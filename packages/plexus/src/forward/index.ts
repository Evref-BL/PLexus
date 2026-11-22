/**
 * Forwarding: one JSON-RPC request to an image's endpoint per call. Nothing
 * is cached, so nothing can name an image that has since stopped.
 */
import type { Endpoint, ImageTool, ImageToolResult } from "../types.js";
import { initialize, request } from "./jsonRpc.js";

const defaultTimeoutMs = 60_000;

/** What a call waits beyond its own time limit, so that the image's answer to a call it stopped arrives first. */
const beyondLimitMs = 30_000;

/** The longest wait Node's timers keep, about 24.8 days: a longer one is cut to it with a warning, and an infinite one throws. */
const longestWaitMs = 2 ** 31 - 1;

export async function listTools(
  endpoint: Endpoint,
  options: { timeoutMs?: number } = {},
): Promise<ImageTool[]> {
  const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
  const session = await initialize(endpoint.url, timeoutMs);
  const response = await request(endpoint.url, "tools/list", undefined, {
    timeoutMs,
    session,
  });
  const result = response.result;
  if (!isRecord(result) || !Array.isArray(result.tools)) {
    throw new Error("MCP tools/list response did not include result.tools");
  }
  return result.tools.map((tool, index) => checkedTool(tool, index));
}

export interface CallToolOptions {
  /** The schema the image listed for the tool: its `timeoutSeconds` gives the call's limit and the most it may be. */
  inputSchema?: ImageTool["inputSchema"];
  /** What the handshake waits, and the least the call waits: 60000 unless given. */
  minimumMs?: number;
  /** Aborting it destroys the request in flight, and the call rejects as cancelled. */
  signal?: AbortSignal;
}

/**
 * One call, answered by the tool's result as the image sent it. The call
 * waits longer than any limit the image keeps itself, so that its own answer
 * to a call it stopped arrives first: see `callWaitMs`. A handshake the image
 * does not answer fails the call before it is sent.
 *
 * It rejects with a `ForwardError`, whose `kind` says whether the image
 * answered, never got the call, or got it and gave no answer.
 */
export async function callTool(
  endpoint: Endpoint,
  name: string,
  args: Record<string, unknown> = {},
  options: CallToolOptions = {},
): Promise<ImageToolResult> {
  const handshakeMs = Math.min(options.minimumMs ?? defaultTimeoutMs, longestWaitMs);
  const session = await initialize(endpoint.url, handshakeMs, {
    failOnTimeout: true,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  const response = await request(
    endpoint.url,
    "tools/call",
    { name, arguments: args },
    {
      timeoutMs: callWaitMs(args, options),
      session,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    },
  );
  return response.result as ImageToolResult;
}

/**
 * How long a call waits for its answer: the larger of the minimum and the
 * call's time limit plus 30 s. The limit is the call's own `timeoutSeconds`
 * when it is a number of 0 or more, otherwise the default of `timeoutSeconds`
 * in the schema the image listed; with neither, the call waits the minimum.
 * The limit is never more than the `maximum` that schema lists, since the
 * image does not work past it, and no wait is longer than Node's timers
 * keep. Exported for tests only.
 */
export function callWaitMs(
  args: Record<string, unknown>,
  options: Pick<CallToolOptions, "inputSchema" | "minimumMs"> = {},
): number {
  const minimumMs = options.minimumMs ?? defaultTimeoutMs;
  const listed = listedTimeLimit(options.inputSchema);
  const limitSeconds = timeLimit(args.timeoutSeconds) ?? timeLimit(listed.default);
  const waitMs =
    limitSeconds === undefined
      ? minimumMs
      : Math.max(minimumMs, Math.min(limitSeconds, timeLimit(listed.maximum) ?? Infinity) * 1000 + beyondLimitMs);
  return Math.min(waitMs, longestWaitMs);
}

function timeLimit(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function listedTimeLimit(inputSchema: ImageTool["inputSchema"] | undefined): { default?: unknown; maximum?: unknown } {
  const property = inputSchema?.properties?.timeoutSeconds;
  return isRecord(property) ? property : {};
}

/** The tool an image runs Smalltalk with, `evaluate`, when it lists one. */
export function evaluationTool(tools: ReadonlyArray<{ name: string }>): string | undefined {
  return tools.find((tool) => tool.name === "evaluate")?.name;
}

/**
 * Whether an MCP server answers there. Any JSON-RPC answer to `ping` counts,
 * whatever its HTTP status: a server that wants a session first refuses the
 * ping, and refusing it is answering. A server that does not speak JSON-RPC
 * there may still answer `/health`.
 */
export async function ping(endpoint: Endpoint, timeoutMs = 1_000): Promise<boolean> {
  try {
    const answer = await fetchWithin(timeoutMs, endpoint.url, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: "plexus-ping", method: "ping" }),
    });
    const payload: unknown = await answer.json().catch(() => undefined);
    if (
      isRecord(payload) &&
      payload.jsonrpc === "2.0" &&
      ("result" in payload || "error" in payload)
    ) {
      return true;
    }
  } catch {
    // Not listening yet.
  }
  try {
    return (await fetchWithin(timeoutMs, new URL("/health", endpoint.url).href)).ok;
  } catch {
    return false;
  }
}

async function fetchWithin(timeoutMs: number, url: string, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function checkedTool(value: unknown, index: number): ImageTool {
  if (!isRecord(value) || typeof value.name !== "string") {
    throw new Error(`MCP tools/list returned an invalid tool at index ${index}`);
  }
  if (!isRecord(value.inputSchema)) {
    throw new Error(
      `MCP tools/list returned tool ${value.name} without an inputSchema object`,
    );
  }
  return value as ImageTool;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
