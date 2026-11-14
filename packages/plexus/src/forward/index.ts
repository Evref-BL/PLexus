/**
 * Forwarding: one JSON-RPC request to an image's endpoint per call. Nothing
 * is cached, so nothing can name an image that has since stopped.
 */
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { Endpoint } from "../types.js";
import { initialize, request } from "./jsonRpc.js";

const defaultTimeoutMs = 60_000;

/** What a call waits beyond its own time limit, so that the image's answer to a call it stopped arrives first. */
const beyondLimitMs = 30_000;

export async function listTools(
  endpoint: Endpoint,
  options: { timeoutMs?: number } = {},
): Promise<Tool[]> {
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
  /** One wait for each of the two requests, in place of the waits below. */
  timeoutMs?: number;
  /** The schema the image listed for the tool; the default of its `timeoutSeconds` is the call's limit. */
  inputSchema?: Tool["inputSchema"];
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
): Promise<CallToolResult> {
  const handshakeMs = options.timeoutMs ?? options.minimumMs ?? defaultTimeoutMs;
  const session = await initialize(endpoint.url, handshakeMs, {
    failOnTimeout: true,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  const response = await request(
    endpoint.url,
    "tools/call",
    { name, arguments: args },
    {
      timeoutMs: options.timeoutMs ?? callWaitMs(args, options),
      session,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    },
  );
  return response.result as CallToolResult;
}

/**
 * How long a call waits for its answer: the larger of the minimum and the
 * call's time limit plus 30 s. The limit is the call's own `timeoutSeconds`
 * when it is a number of 0 or more, otherwise the default of `timeoutSeconds`
 * in the schema the image listed; with neither, the call waits the minimum.
 * Exported for tests only.
 */
export function callWaitMs(
  args: Record<string, unknown>,
  options: Pick<CallToolOptions, "inputSchema" | "minimumMs"> = {},
): number {
  const minimumMs = options.minimumMs ?? defaultTimeoutMs;
  const limitSeconds = timeLimit(args.timeoutSeconds) ?? timeLimit(listedTimeLimit(options.inputSchema));
  return limitSeconds === undefined ? minimumMs : Math.max(minimumMs, limitSeconds * 1000 + beyondLimitMs);
}

function timeLimit(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function listedTimeLimit(inputSchema: Tool["inputSchema"] | undefined): unknown {
  const property = inputSchema?.properties?.timeoutSeconds;
  return isRecord(property) ? property.default : undefined;
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

function checkedTool(value: unknown, index: number): Tool {
  if (!isRecord(value) || typeof value.name !== "string") {
    throw new Error(`MCP tools/list returned an invalid tool at index ${index}`);
  }
  if (!isRecord(value.inputSchema)) {
    throw new Error(
      `MCP tools/list returned tool ${value.name} without an inputSchema object`,
    );
  }
  return value as Tool;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
