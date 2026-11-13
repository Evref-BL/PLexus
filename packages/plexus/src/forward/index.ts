/**
 * Forwarding: one JSON-RPC request to an image's endpoint per call. Nothing
 * is cached, so nothing can name an image that has since stopped.
 */
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { Endpoint } from "../types.js";
import { initialize, request } from "./jsonRpc.js";

const defaultTimeoutMs = 60_000;

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

export async function callTool(
  endpoint: Endpoint,
  name: string,
  args: Record<string, unknown> = {},
  options: { timeoutMs?: number } = {},
): Promise<CallToolResult> {
  const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
  const session = await initialize(endpoint.url, timeoutMs);
  const response = await request(
    endpoint.url,
    "tools/call",
    { name, arguments: args },
    { timeoutMs, session },
  );
  return response.result as CallToolResult;
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
