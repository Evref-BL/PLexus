import http from "node:http";
import { SpanKind, type Attributes } from "@opentelemetry/api";
import { contentAttributes, errorType, failed, identifierOrOther, inSpan, withTraceContext } from "../telemetry/trace.js";
import { plexusVersion } from "../version.js";
import { headerValue } from "./headers.js";

/** The modern revision PLexus asks for first. */
export const modernProtocolVersion = "2026-07-28";

/** The legacy revision it asks for when a server takes only the handshake. */
export const legacyProtocolVersion = "2025-11-25";

/** What a legacy handshake agreed, and so what the requests after it carry. */
interface Session {
  protocolVersion?: string;
  sessionId?: string;
}

/** How a request was answered: statelessly in the modern revision, or in a legacy session. */
type Era = { modern: true } | ({ modern: false } & Session);

/** The JSON-RPC errors only a modern server answers: header mismatch, missing client capability, unsupported version. */
const modernErrors = new Set([-32020, -32021, -32022]);

/** Method not found, which a modern server answers to a method it does not have, with a 404. */
const methodNotFound = -32601;

/**
 * How a forwarded request failed, beside its message: whether the image
 * answered, never got the call, or got it and gave no answer.
 *
 * - `answered`: the image answered a JSON-RPC error, with its code, whatever
 *   the HTTP status it came with;
 * - `no-handshake`: the handshake timed out, so the call was not sent;
 * - `timeout`: the call was sent and not answered in time;
 * - `refused`: the connection was refused, so nothing was sent;
 * - `closed`: the connection closed after the call was sent;
 * - `cancelled`: the caller's signal aborted the request;
 * - `other`: an HTTP status whose body is no JSON-RPC error, with
 *   `httpStatus`, invalid JSON, or a response with no result.
 */
export type ForwardError = Error & ForwardErrorKind;

type ForwardErrorKind =
  | { kind: "answered"; rpcCode?: number; rpcMessage?: string }
  | { kind: "no-handshake" | "timeout"; waitedMs: number }
  | { kind: "refused" | "closed" | "cancelled" }
  | { kind: "other"; httpStatus?: number };

interface HttpAnswer {
  payload: unknown;
  status: number;
  sessionId?: string;
}

/** What waits for a legacy server's handshake, and whether its timing out fails the request. */
export interface Handshake {
  timeoutMs: number;
  failOnTimeout?: boolean;
}

/**
 * One request, answered by its JSON-RPC response object. A JSON-RPC error is
 * thrown with the server's `error.data` in the message, whatever the HTTP
 * status it came with: an image answers a request it refuses with 400 and a
 * JSON-RPC error saying why.
 *
 * The request goes in the modern revision first: one POST whose `_meta`
 * names the revision, PLexus and the capabilities it offers, none, and whose
 * headers mirror its method and name, beside the `headers` given. A `4xx`
 * whose body is no error only a modern server answers says the server is
 * legacy: the request then goes again in a session the `handshake` opens.
 * Only a refusal is sent again, never a request that timed out or whose
 * connection closed, which the server may have run.
 *
 * The request is a CLIENT span, `<method>` or `tools/call <tool>`, and
 * carries the active trace context in its `params._meta`: see
 * `requestAttributes` for what the span records. A JSON-RPC error answer
 * fails it, whatever its code, which `rpc.status_code` records. A request that `endsImage`
 * does not fail its span when the connection closes or no answer comes.
 */
export async function request(
  url: string,
  method: string,
  params: Record<string, unknown> | undefined,
  options: {
    timeoutMs: number;
    handshake?: Handshake;
    headers?: Record<string, string>;
    signal?: AbortSignal;
    endsImage?: boolean;
  },
): Promise<Record<string, unknown>> {
  const id = `plexus-${method}-${Date.now()}`;
  const tool = method === "tools/call" && typeof params?.name === "string" ? identifierOrOther(params.name) : undefined;
  return inSpan(
    tool === undefined ? method : `${method} ${tool}`,
    SpanKind.CLIENT,
    {
      ...requestAttributes(method, tool, id, url),
      ...(tool === undefined ? {} : contentAttributes(params?.arguments)),
    },
    async (span) => {
      let era: Era = { modern: true };
      let answer = await post(
        url,
        jsonRpcMessage(method, withProtocolMeta(params), id),
        options.timeoutMs,
        { ...modernHeaders(method, params), ...options.headers },
        options.signal,
      ).catch((error: unknown) => {
        if (isLegacyRefusal(error)) {
          return undefined;
        }
        throw error;
      });
      if (answer === undefined || isLegacyRefusal(answer)) {
        const session = await initialize(url, options.handshake ?? { timeoutMs: options.timeoutMs }, options.signal);
        era = { modern: false, ...session };
        answer = await post(url, jsonRpcMessage(method, params, id), options.timeoutMs, sessionHeaders(session), options.signal);
      }
      span.setAttributes(eraAttributes(era));
      const payload = answer.payload;
      if (!isRecord(payload)) {
        throw forwardError(new Error("MCP response was not a JSON object"), { kind: "other" });
      }
      if ("error" in payload) {
        const code = isRecord(payload.error) ? payload.error.code : undefined;
        const message = isRecord(payload.error) ? payload.error.message : undefined;
        if (typeof code === "number") {
          span.setAttribute("rpc.status_code", String(code));
        }
        throw forwardError(new Error(`MCP error ${jsonRpcErrorText(payload.error)}`), {
          kind: "answered",
          ...(typeof code === "number" ? { rpcCode: code } : {}),
          ...(typeof message === "string" ? { rpcMessage: message } : {}),
        });
      }
      if (!("result" in payload)) {
        throw forwardError(new Error(`MCP ${method} response did not include a result`), { kind: "other" });
      }
      if (tool !== undefined && isRecord(payload.result)) {
        if (payload.result.isError === true) {
          failed(span, "tool_error");
        }
        span.setAttributes(contentAttributes(undefined, payload.result));
      }
      return payload;
    },
    (error) => (options.endsImage && endedImage(error) ? undefined : requestErrorType(error)),
    (error) => (error as Partial<ForwardError> | undefined)?.kind === "answered" ? (error as { rpcMessage?: string }).rpcMessage : undefined,
  );
}

/**
 * The params with the per-request fields of the modern revision in their
 * `_meta`, beside what it already carries.
 */
function withProtocolMeta(params: Record<string, unknown> | undefined): Record<string, unknown> {
  const meta = isRecord(params?._meta) ? params._meta : {};
  return {
    ...params,
    _meta: {
      ...meta,
      "io.modelcontextprotocol/protocolVersion": modernProtocolVersion,
      "io.modelcontextprotocol/clientInfo": { name: "plexus", version: plexusVersion },
      "io.modelcontextprotocol/clientCapabilities": {},
    },
  };
}

/** The headers a modern request mirrors from its body: the revision, the method, and the name or URI it is about. */
function modernHeaders(method: string, params: Record<string, unknown> | undefined): Record<string, string> {
  const named = method === "resources/read" ? params?.uri : method === "tools/call" || method === "prompts/get" ? params?.name : undefined;
  return {
    "MCP-Protocol-Version": modernProtocolVersion,
    "Mcp-Method": method,
    ...(typeof named === "string" ? { "Mcp-Name": headerValue(named) } : {}),
  };
}

function sessionHeaders(session: Session): Record<string, string> {
  return {
    ...(session.protocolVersion ? { "MCP-Protocol-Version": session.protocolVersion } : {}),
    ...(session.sessionId ? { "Mcp-Session-Id": session.sessionId } : {}),
  };
}

/**
 * Whether a modern request was refused as only a legacy server refuses it: a
 * `4xx` whose body is empty, no JSON-RPC error, or one a modern server does
 * not answer. An unsupported version whose `supported` list names a legacy
 * revision is answered by a dual-era server that does not speak this modern
 * one, and falls back too.
 */
function isLegacyRefusal(answer: unknown): boolean {
  if (answer instanceof Error) {
    const failure = answer as Partial<ForwardError> & { httpStatus?: number };
    return failure.kind === "other" && isClientError(failure.httpStatus);
  }
  const { payload, status } = answer as HttpAnswer;
  if (!isClientError(status) || !isRecord(payload) || !isRecord(payload.error)) {
    return false;
  }
  const code = payload.error.code;
  if (code === -32022) {
    const supported = isRecord(payload.error.data) ? payload.error.data.supported : undefined;
    return Array.isArray(supported) && supported.some((version) => typeof version === "string" && version <= legacyProtocolVersion);
  }
  return typeof code !== "number" || !(modernErrors.has(code) || code === methodNotFound);
}

function isClientError(status: number | undefined): boolean {
  return status !== undefined && status >= 400 && status < 500;
}

/** The revision a request was answered in, and the session it went in, when there was one. */
function eraAttributes(era: Era): Attributes {
  if (era.modern) {
    return { "mcp.protocol.version": modernProtocolVersion };
  }
  return {
    ...(era.protocolVersion === undefined ? {} : { "mcp.protocol.version": era.protocolVersion }),
    ...(era.sessionId === undefined ? {} : { "mcp.session.id": era.sessionId }),
  };
}

/** Whether a request failed as one that ends the image may: its connection closed, or no answer came in time. */
function endedImage(error: unknown): boolean {
  const kind = (error as Partial<ForwardError> | undefined)?.kind;
  return kind === "closed" || kind === "timeout";
}

/**
 * What a forwarded request's span records, after the OpenTelemetry MCP
 * conventions: the method, its id, the tool and its operation, the image's
 * address and port, and HTTP/1.1, the only version Node's `http` client
 * speaks. The protocol version, and the session when there is one, are
 * added once the server has answered: see `eraAttributes`.
 */
function requestAttributes(method: string, tool: string | undefined, id: string, url: string): Attributes {
  const server = new URL(url);
  return {
    "mcp.method.name": method,
    "jsonrpc.request.id": id,
    "server.address": bareHost(server),
    "server.port": Number(server.port || (server.protocol === "https:" ? 443 : 80)),
    ...(tool === undefined ? {} : { "gen_ai.tool.name": tool, "gen_ai.operation.name": "execute_tool" }),
    "network.transport": "tcp",
    "network.protocol.name": "http",
    "network.protocol.version": "1.1",
  };
}

/** A URL's host as a socket takes it: URL keeps an IPv6 address in brackets. */
function bareHost(url: URL): string {
  return url.hostname.replace(/^\[(.*)\]$/, "$1");
}

/**
 * A JSON-RPC request, or a notification when it has no id, whose params
 * carry the active trace context in their `_meta`, as the MCP conventions ask
 * of every request and notification: see `withTraceContext`.
 */
export function jsonRpcMessage(
  method: string,
  params: Record<string, unknown> | undefined,
  id?: string,
): Record<string, unknown> {
  const sent = withTraceContext(params);
  return {
    jsonrpc: "2.0",
    ...(id === undefined ? {} : { id }),
    method,
    ...(sent === undefined ? {} : { params: sent }),
  };
}

/**
 * A failed request's `error.type`: the JSON-RPC code an image answered, the
 * HTTP status it answered, `timeout`, how the connection failed, or the
 * error's class.
 */
function requestErrorType(error: unknown): string {
  const failure = error as Partial<ForwardError> | undefined;
  switch (failure?.kind) {
    case "answered":
      return failure.rpcCode === undefined ? "_OTHER" : String(failure.rpcCode);
    case "timeout":
    case "no-handshake":
      return "timeout";
    case "refused":
    case "closed":
    case "cancelled":
      return failure.kind;
    case "other":
      return failure.httpStatus === undefined ? errorType(error) : String(failure.httpStatus);
    default:
      return errorType(error);
  }
}

/**
 * The handshake a legacy MCP server needs before a request, asking for the
 * newest legacy revision. A server that does not take it still answers
 * requests, so a failed handshake leaves the request to go without a session
 * rather than failing it, except when it was cancelled, or timed out and
 * `failOnTimeout` asks: a server that does not answer the handshake will not
 * answer the request either, and failing here says the request was never
 * run.
 *
 * Neither the request nor the notification that follows it is a span of its
 * own; each carries the active trace context in its `_meta`.
 */
async function initialize(url: string, handshake: Handshake, signal?: AbortSignal): Promise<Session> {
  const timeoutMs = handshake.timeoutMs;
  let answer: HttpAnswer;
  try {
    answer = await post(
      url,
      jsonRpcMessage(
        "initialize",
        { protocolVersion: legacyProtocolVersion, capabilities: {}, clientInfo: { name: "plexus", version: plexusVersion } },
        `plexus-initialize-${Date.now()}`,
      ),
      timeoutMs,
      {},
      signal,
    );
  } catch (error) {
    const kind = (error as Partial<ForwardError>).kind;
    if (kind === "cancelled") {
      throw error;
    }
    if (kind === "timeout" && handshake.failOnTimeout) {
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
  await post(url, jsonRpcMessage("notifications/initialized", undefined), timeoutMs, sessionHeaders(session), signal).catch(
    () => undefined,
  );
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
 * A status other than 2xx is the answer when its body is a JSON-RPC error,
 * which says why the server refused the request; otherwise it fails as an
 * HTTP error.
 */
function post(
  url: string,
  payload: Record<string, unknown>,
  timeoutMs: number,
  headers: Record<string, string>,
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

  return new Promise((answered, failed) => {
    // A deadline, not the socket's idle timeout, which an answer trickling
    // in a byte at a time would never reach.
    let deadline: NodeJS.Timeout | undefined;
    const resolve = (answer: HttpAnswer) => {
      clearTimeout(deadline);
      answered(answer);
    };
    const reject = (error: unknown) => {
      clearTimeout(deadline);
      failed(error);
    };
    const fail = (error: unknown) => reject(socketError(error, signal));
    const outgoing = http.request(
      {
        hostname: bareHost(target),
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
          connection: "close",
          ...headers,
        },
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
          const text = Buffer.concat(chunks).toString("utf8");
          if (status === undefined || status < 200 || status >= 300) {
            const refusal = jsonRpcError(text);
            if (refusal !== undefined && status !== undefined) {
              resolve({ payload: refusal, status });
              return;
            }
            reject(
              forwardError(
                new Error(`HTTP ${status ?? "unknown"} ${response.statusMessage ?? ""}`.trim()),
                { kind: "other", ...(status === undefined ? {} : { httpStatus: status }) },
              ),
            );
            return;
          }

          if (!text.trim()) {
            // A notification is answered with an empty 202.
            resolve({ payload: undefined, status });
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
            status,
            ...(typeof sessionId === "string" ? { sessionId } : {}),
          });
        });
      },
    );

    deadline = setTimeout(() => {
      outgoing.destroy(
        forwardError(new Error(`MCP request timed out after ${timeoutMs}ms`), {
          kind: "timeout",
          waitedMs: timeoutMs,
        }),
      );
    }, timeoutMs);
    outgoing.on("error", fail);
    outgoing.end(body);
  });
}

/** The JSON-RPC error response a body holds, or nothing when it holds none. */
function jsonRpcError(text: string): Record<string, unknown> | undefined {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return undefined;
  }
  return isRecord(data) && data.jsonrpc === "2.0" && isRecord(data.error) ? data : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
