import http from "node:http";
import { plexusVersion } from "../version.js";

const protocolVersion = "2025-06-18";

export interface Session {
  protocolVersion?: string;
  sessionId?: string;
}

/**
 * How a forwarded request failed, beside its message: whether the image
 * answered, never got the call, or got it and gave no answer.
 *
 * - `answered`: the image answered a JSON-RPC error, with its code;
 * - `no-handshake`: the handshake timed out, so the call was not sent;
 * - `timeout`: the call was sent and not answered in time;
 * - `refused`: the connection was refused, so nothing was sent;
 * - `closed`: the connection closed after the call was sent;
 * - `cancelled`: the caller's signal aborted the request;
 * - `other`: an HTTP status, invalid JSON, or a response with no result.
 */
export type ForwardError = Error & ForwardErrorKind;

type ForwardErrorKind =
  | { kind: "answered"; rpcCode?: number }
  | { kind: "no-handshake" | "timeout"; waitedMs: number }
  | { kind: "refused" | "closed" | "cancelled" | "other" };

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
  options: { timeoutMs: number; session?: Session; signal?: AbortSignal },
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
    options.signal,
  );
  const payload = answer.payload;
  if (!isRecord(payload)) {
    throw forwardError(new Error("MCP response was not a JSON object"), { kind: "other" });
  }
  if ("error" in payload) {
    const code = isRecord(payload.error) ? payload.error.code : undefined;
    throw forwardError(new Error(`MCP error ${jsonRpcErrorText(payload.error)}`), {
      kind: "answered",
      ...(typeof code === "number" ? { rpcCode: code } : {}),
    });
  }
  if (!("result" in payload)) {
    throw forwardError(new Error(`MCP ${method} response did not include a result`), { kind: "other" });
  }
  return payload;
}

/**
 * The handshake a stateful MCP server needs before a call. A server that does
 * not take it still answers calls, so a failed handshake leaves the call to
 * go without a session rather than failing it, except when it was cancelled,
 * or timed out and `failOnTimeout` asks: a server that does not answer the
 * handshake will not answer the call either, and failing here says the call
 * was never sent.
 */
export async function initialize(
  url: string,
  timeoutMs: number,
  options: { failOnTimeout?: boolean; signal?: AbortSignal } = {},
): Promise<Session> {
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
      {},
      options.signal,
    );
  } catch (error) {
    const kind = (error as Partial<ForwardError>).kind;
    if (kind === "cancelled") {
      throw error;
    }
    if (kind === "timeout" && options.failOnTimeout) {
      throw forwardError(new Error(`MCP initialize timed out after ${timeoutMs}ms`), {
        kind: "no-handshake",
        waitedMs: timeoutMs,
      });
    }
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
    options.signal,
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

/** The error with its kind, its message kept. */
function forwardError(error: Error, kind: ForwardErrorKind): ForwardError {
  return Object.assign(error, kind) as ForwardError;
}

function cancelled(): ForwardError {
  return forwardError(new Error("MCP request cancelled"), { kind: "cancelled" });
}

// What the socket said, by whether the request could have reached the server:
// a refused connection sent nothing, a reset one had the request written.
function socketError(error: unknown, signal: AbortSignal | undefined): ForwardError {
  if (signal?.aborted) {
    return cancelled();
  }
  const failure = error instanceof Error ? error : new Error(String(error));
  if ("kind" in failure) {
    return failure as ForwardError;
  }
  const code = (failure as NodeJS.ErrnoException).code;
  return forwardError(failure, {
    kind: code === "ECONNREFUSED" ? "refused" : code === "ECONNRESET" || code === "EPIPE" ? "closed" : "other",
  });
}

/**
 * One POST, waiting at most `timeoutMs` for the server to say anything, and
 * no longer than `signal` lets it: an abort destroys the request in flight.
 */
function post(
  url: string,
  payload: Record<string, unknown>,
  timeoutMs: number,
  session: Session = {},
  signal?: AbortSignal,
): Promise<HttpAnswer> {
  const target = new URL(url);
  if (target.protocol !== "http:") {
    return Promise.reject(forwardError(new Error(`Unsupported MCP endpoint: ${url}`), { kind: "other" }));
  }
  if (signal?.aborted) {
    return Promise.reject(cancelled());
  }
  const body = JSON.stringify(payload);

  return new Promise((resolve, reject) => {
    const fail = (error: unknown) => reject(socketError(error, signal));
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
        ...(signal === undefined ? {} : { signal }),
      },
      (response) => {
        // A connection that closes in the middle of the body ends nothing.
        response.on("error", fail);
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer | string) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        response.on("end", () => {
          const status = response.statusCode;
          if (status === undefined || status < 200 || status >= 300) {
            reject(
              forwardError(
                new Error(`HTTP ${status ?? "unknown"} ${response.statusMessage ?? ""}`.trim()),
                { kind: "other" },
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
              forwardError(
                new Error(
                  `MCP response was not valid JSON: ${
                    error instanceof Error ? error.message : String(error)
                  }`,
                ),
                { kind: "other" },
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
      outgoing.destroy(
        forwardError(new Error(`MCP request timed out after ${timeoutMs}ms`), {
          kind: "timeout",
          waitedMs: timeoutMs,
        }),
      );
    });
    outgoing.on("error", fail);
    outgoing.end(body);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
