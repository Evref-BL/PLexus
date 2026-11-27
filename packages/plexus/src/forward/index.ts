/**
 * Forwarding: one JSON-RPC request to an image's endpoint per call. Nothing
 * is cached, so nothing can name an image that has since stopped.
 */
import type { Endpoint, ImageTool, ImageToolResult } from "../types.js";
import { annotationProblem, parameterHeaders } from "./headers.js";
import { jsonRpcMessage, request } from "./jsonRpc.js";

const defaultTimeoutMs = 60_000;

/** What a call waits beyond its own time limit, so that the image's answer to a call it stopped arrives first. */
const beyondLimitMs = 30_000;

/** The longest wait Node's timers keep, about 24.8 days: a longer one is cut to it with a warning, and an infinite one throws. */
const longestWaitMs = 2 ** 31 - 1;

/** The code of the error a modern server answers when a request's headers do not match its body. */
const headerMismatch = -32020;

/**
 * The image's tools, but for one whose `x-mcp-header` annotations break the
 * rules, which is left out with a warning, as the Streamable HTTP binding
 * asks.
 */
export async function listTools(
  endpoint: Endpoint,
  options: { timeoutMs?: number } = {},
): Promise<ImageTool[]> {
  const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
  const response = await request(endpoint.url, "tools/list", undefined, { timeoutMs });
  const result = response.result;
  if (!isRecord(result) || !Array.isArray(result.tools)) {
    throw new Error("MCP tools/list response did not include result.tools");
  }
  return result.tools
    .map((tool, index) => checkedTool(tool, index))
    .filter((tool) => {
      const problem = annotationProblem(tool.inputSchema);
      if (problem !== undefined) {
        process.emitWarning(`Left out tool ${tool.name}, whose x-mcp-header annotations break the rules: ${problem}`);
      }
      return problem === undefined;
    });
}

export interface CallToolOptions {
  /** The schema the image listed for the tool: its `timeoutSeconds` gives the call's limit and the most it may be. */
  inputSchema?: ImageTool["inputSchema"];
  /** What a legacy server's handshake waits, and the least the call waits: 60000 unless given. */
  minimumMs?: number;
  /** Aborting it destroys the request in flight, and the call rejects as cancelled. */
  signal?: AbortSignal;
  /**
   * The call is meant to end the image, such as a quit: the connection
   * closing, or no answer in time, is how it may go, and does not fail its
   * span. The call still rejects as it would.
   */
  endsImage?: boolean;
}

/**
 * One call, answered by the tool's result as the image sent it. The call
 * waits longer than any limit the image keeps itself, so that its own answer
 * to a call it stopped arrives first: see `callWaitMs`. A handshake a legacy
 * image does not answer fails the call before it is sent.
 *
 * The parameters the listed schema annotates with `x-mcp-header` go in
 * headers too. Without that schema, a call the image refuses for headers it
 * lacks lists the image's tools and goes again with them, once: the refusal
 * came before the call ran.
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
  const send = (inputSchema: unknown) =>
    request(
      endpoint.url,
      "tools/call",
      { name, arguments: args },
      {
        timeoutMs: callWaitMs(args, options),
        handshake: { timeoutMs: handshakeMs, failOnTimeout: true },
        headers: parameterHeaders(inputSchema, args),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(options.endsImage ? { endsImage: true } : {}),
      },
    );
  let response: Record<string, unknown>;
  try {
    response = await send(options.inputSchema);
  } catch (error) {
    if (options.inputSchema !== undefined || (error as { rpcCode?: number }).rpcCode !== headerMismatch) {
      throw error;
    }
    const listed = (await listTools(endpoint, { timeoutMs: handshakeMs })).find((tool) => tool.name === name);
    if (listed === undefined || Object.keys(parameterHeaders(listed.inputSchema, args)).length === 0) {
      throw error;
    }
    response = await send(listed.inputSchema);
  }
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
 * ping, and refusing it is answering. The ping is no span of its own, and
 * carries the active trace context in its `_meta`.
 */
export async function ping(endpoint: Endpoint, timeoutMs = 1_000): Promise<boolean> {
  // The answer's body as well as its headers within the time.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const answer = await fetch(endpoint.url, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      body: JSON.stringify(jsonRpcMessage("ping", undefined, "plexus-ping")),
      signal: controller.signal,
    });
    const payload: unknown = await answer.json().catch(() => undefined);
    return isRecord(payload) && payload.jsonrpc === "2.0" && ("result" in payload || "error" in payload);
  } catch {
    // Not listening yet.
    return false;
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
