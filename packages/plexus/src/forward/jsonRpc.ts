import http from "node:http";
import { plexusVersion } from "../version.js";

const protocolVersion = "2025-06-18";

export interface Session {
  protocolVersion?: string;
  sessionId?: string;
}

interface HttpAnswer {
  payload: unknown;
  sessionId?: string;
}

/**
 * One request, answered by its JSON-RPC response object. A JSON-RPC error is
 * thrown with the server's `error.data` in the message.
 */
export async function request(
  url: string,
  method: string,
  params: Record<string, unknown> | undefined,
  options: { timeoutMs: number; session?: Session },
): Promise<Record<string, unknown>> {
  const answer = await post(
    url,
    {
      jsonrpc: "2.0",
      id: `plexus-${method}-${Date.now()}`,
      method,
      ...(params === undefined ? {} : { params }),
    },
    options.timeoutMs,
    options.session,
  );
  const payload = answer.payload;
  if (!isRecord(payload)) {
    throw new Error("MCP response was not a JSON object");
  }
  if ("error" in payload) {
    throw new Error(`MCP error ${jsonRpcErrorText(payload.error)}`);
  }
  if (!("result" in payload)) {
    throw new Error(`MCP ${method} response did not include a result`);
  }
  return payload;
}

/**
 * The handshake a stateful MCP server needs before a call. A server that does
 * not take it still answers calls, so a failed handshake leaves the call to
 * go without a session rather than failing it.
 */
export async function initialize(url: string, timeoutMs: number): Promise<Session> {
  let answer: HttpAnswer;
  try {
    answer = await post(
      url,
      {
        jsonrpc: "2.0",
        id: `plexus-initialize-${Date.now()}`,
        method: "initialize",
        params: {
          protocolVersion,
          capabilities: {},
          clientInfo: { name: "plexus", version: plexusVersion },
        },
      },
      timeoutMs,
    );
  } catch {
    return {};
  }

  const result = isRecord(answer.payload) ? answer.payload.result : undefined;
  if (!isRecord(result)) {
    return {};
  }
  const session: Session = {
    ...(typeof result.protocolVersion === "string"
      ? { protocolVersion: result.protocolVersion }
      : {}),
    ...(answer.sessionId ? { sessionId: answer.sessionId } : {}),
  };
  // A stateless server does not implement the notification.
  await post(
    url,
    { jsonrpc: "2.0", method: "notifications/initialized" },
    timeoutMs,
    session,
  ).catch(() => undefined);
  return session;
}

// MCP Pharo names each argument that broke a tool's schema in the error's
// data, and its message alone says only "Invalid method parameter(s)". The
// data goes into the message as the server sent it: PLexus forwards to any
// MCP server and does not know the shape of its data.
export function jsonRpcErrorText(value: unknown): string {
  if (!isRecord(value) || typeof value.message !== "string") {
    return JSON.stringify(value);
  }
  const code = typeof value.code === "number" ? `${value.code}: ` : "";
  const data = value.data === undefined ? "" : ` ${JSON.stringify(value.data)}`;
  return `${code}${value.message}${data}`;
}

function post(
  url: string,
  payload: Record<string, unknown>,
  timeoutMs: number,
  session: Session = {},
): Promise<HttpAnswer> {
  const target = new URL(url);
  if (target.protocol !== "http:") {
    return Promise.reject(new Error(`Unsupported MCP endpoint: ${url}`));
  }
  const body = JSON.stringify(payload);

  return new Promise((resolve, reject) => {
    const outgoing = http.request(
      {
        // URL keeps an IPv6 host in brackets; the socket wants it bare.
        hostname: target.hostname.replace(/^\[(.*)\]$/, "$1"),
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
          connection: "close",
          ...(session.protocolVersion
            ? { "MCP-Protocol-Version": session.protocolVersion }
            : {}),
          ...(session.sessionId ? { "Mcp-Session-Id": session.sessionId } : {}),
        },
        timeout: timeoutMs,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer | string) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        response.on("end", () => {
          const status = response.statusCode;
          if (status === undefined || status < 200 || status >= 300) {
            reject(
              new Error(
                `HTTP ${status ?? "unknown"} ${response.statusMessage ?? ""}`.trim(),
              ),
            );
            return;
          }

          const text = Buffer.concat(chunks).toString("utf8");
          if (!text.trim()) {
            // A notification is answered with an empty 202.
            resolve({ payload: undefined });
            return;
          }
          let data: unknown;
          try {
            data = JSON.parse(text);
          } catch (error) {
            reject(
              new Error(
                `MCP response was not valid JSON: ${
                  error instanceof Error ? error.message : String(error)
                }`,
              ),
            );
            return;
          }
          const sessionId = response.headers["mcp-session-id"];
          resolve({
            payload: data,
            ...(typeof sessionId === "string" ? { sessionId } : {}),
          });
        });
      },
    );

    outgoing.on("timeout", () => {
      outgoing.destroy(new Error(`MCP request timed out after ${timeoutMs}ms`));
    });
    outgoing.on("error", reject);
    outgoing.end(body);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
