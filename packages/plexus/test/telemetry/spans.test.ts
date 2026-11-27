import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { context, propagation, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { CompositePropagator, W3CBaggagePropagator, W3CTraceContextPropagator } from "@opentelemetry/core";
import { InMemorySpanExporter, SimpleSpanProcessor, TracerProvider, type ReadableSpan } from "@opentelemetry/sdk-trace";
import { afterEach, describe, expect, it } from "vitest";
import { callTool, listTools, ping } from "../../src/forward/index.js";
import { request } from "../../src/forward/jsonRpc.js";
import { storeRoot } from "../../src/home.js";
import { PlexusError } from "../../src/errors.js";
import { answeredCode, serverFailedWith, withSession } from "../../src/telemetry/trace.js";
import { FakeLauncher, imagesWith, tempHome, writeLauncherImage } from "../support/fakeLauncher.js";

const exporter = new InMemorySpanExporter();

/** An SDK as an application installs one, exporting to memory. */
function registerSdk(): void {
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  propagation.setGlobalPropagator(
    new CompositePropagator({ propagators: [new W3CTraceContextPropagator(), new W3CBaggagePropagator()] }),
  );
  trace.setGlobalTracerProvider(new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] }));
}

const servers: http.Server[] = [];

afterEach(async () => {
  trace.disable();
  propagation.disable();
  context.disable();
  exporter.reset();
  await Promise.all(
    servers.splice(0).map((server) => {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(resolve));
    }),
  );
});

type Reply = { result?: unknown; error?: unknown; status?: number } | "never";

/** The per-request fields a modern request carries in its `_meta`. */
const modernMeta = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientInfo": { name: "plexus", version: expect.any(String) },
  "io.modelcontextprotocol/clientCapabilities": {},
};

/**
 * An MCP server over HTTP that keeps the params of every request it gets. A
 * legacy one refuses a modern request with a bare 400, as MCP did before it
 * spoke 2026-07-28.
 */
async function fakeMcpServer(
  answer: (method: string) => Reply | undefined = standardAnswer,
  options: { legacy?: boolean } = {},
): Promise<{ url: string; port: number; received: Array<{ method: string; params?: Record<string, unknown> }> }> {
  const received: Array<{ method: string; params?: Record<string, unknown> }> = [];
  const server = http.createServer((incoming, response) => {
    let body = "";
    incoming.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    incoming.on("end", () => {
      const message = JSON.parse(body) as { id?: string; method: string; params?: Record<string, unknown> };
      received.push({ method: message.method, ...(message.params === undefined ? {} : { params: message.params }) });
      if (options.legacy && incoming.headers["mcp-protocol-version"] === "2026-07-28") {
        response.writeHead(400).end();
        return;
      }
      const reply = answer(message.method);
      if (reply === "never") {
        return;
      }
      if (message.id === undefined || reply === undefined) {
        response.writeHead(202).end();
        return;
      }
      const { status, ...rest } = reply;
      response.writeHead(status ?? 200, {
        "content-type": "application/json",
        ...(message.method === "initialize" ? { "mcp-session-id": "session-1" } : {}),
      });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, ...rest }));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}/`, port, received };
}

function standardAnswer(method: string): Reply | undefined {
  switch (method) {
    case "initialize":
      return { result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "MCP" } } };
    case "tools/list":
      return { result: { tools: [{ name: "class_get", inputSchema: { type: "object" } }] } };
    case "tools/call":
      return { result: { content: [{ type: "text", text: "Answer about SecretClass" }] } };
    default:
      return undefined;
  }
}

function spanNamed(name: string): ReadableSpan {
  const span = exporter.getFinishedSpans().find((each) => each.name === name);
  expect(span, `a span named ${name}`).toBeDefined();
  return span!;
}

/** Fails the test when anything about the call, beyond its tool's name, reached the spans. */
function expectNoValues(...values: string[]): void {
  const recorded = JSON.stringify(
    exporter.getFinishedSpans().map((span) => ({
      name: span.name,
      attributes: span.attributes,
      status: span.status,
      events: span.events,
    })),
  );
  for (const value of values) {
    expect(recorded).not.toContain(value);
  }
}

describe("a forwarded request without an SDK", () => {
  it("carries no trace context in _meta, and keeps the _meta it has", async () => {
    const server = await fakeMcpServer();

    await callTool({ url: server.url }, "class_get", { name: "SecretClass" });
    await request(server.url, "tools/call", { name: "class_get", _meta: { progressToken: 7 } }, { timeoutMs: 1_000 });

    const calls = server.received.filter((each) => each.method === "tools/call");
    expect(calls[0].params).toEqual({ name: "class_get", arguments: { name: "SecretClass" }, _meta: modernMeta });
    expect(calls[1].params).toEqual({ name: "class_get", _meta: { progressToken: 7, ...modernMeta } });
  });

  it("carries nothing in the handshake's _meta, nor in the legacy request it opens", async () => {
    const server = await fakeMcpServer(standardAnswer, { legacy: true });

    await callTool({ url: server.url }, "class_get", { name: "SecretClass" });

    expect(server.received.map((each) => each.method)).toEqual(["tools/call", "initialize", "notifications/initialized", "tools/call"]);
    expect(server.received[1].params).not.toHaveProperty("_meta");
    expect(server.received[2]).not.toHaveProperty("params");
    expect(server.received[3].params).toEqual({ name: "class_get", arguments: { name: "SecretClass" } });
  });
});

describe("a forwarded request with an SDK", () => {
  it("is a CLIENT span named after its method and tool, child of the active span, whose context it passes in _meta", async () => {
    registerSdk();
    const server = await fakeMcpServer();

    await trace.getTracer("test").startActiveSpan("caller", async (caller) => {
      await callTool({ url: server.url }, "class_get", { name: "SecretClass" });
      caller.end();
    });

    const span = spanNamed("tools/call class_get");
    const caller = spanNamed("caller");
    expect(span.kind).toBe(SpanKind.CLIENT);
    expect(span.parentSpanContext?.spanId).toBe(caller.spanContext().spanId);
    expect(span.spanContext().traceId).toBe(caller.spanContext().traceId);
    expect(span.status.code).not.toBe(SpanStatusCode.ERROR);
    expect(span.attributes).toEqual({
      "mcp.method.name": "tools/call",
      "jsonrpc.request.id": expect.stringMatching(/^plexus-tools\/call-\d+$/),
      "server.address": "127.0.0.1",
      "server.port": server.port,
      "gen_ai.tool.name": "class_get",
      "gen_ai.operation.name": "execute_tool",
      "mcp.protocol.version": "2026-07-28",
      "network.transport": "tcp",
      "network.protocol.name": "http",
      "network.protocol.version": "1.1",
      "session.id": expect.stringMatching(/^[0-9a-f-]{36}$/),
    });

    const call = server.received.find((each) => each.method === "tools/call")!;
    expect(call.params).toEqual({
      name: "class_get",
      arguments: { name: "SecretClass" },
      _meta: { ...modernMeta, traceparent: `00-${span.spanContext().traceId}-${span.spanContext().spanId}-01` },
    });
    expectNoValues("SecretClass");
  });

  it("records the session and the revision a legacy image agreed, in one span with the refused request", async () => {
    registerSdk();
    const server = await fakeMcpServer(standardAnswer, { legacy: true });

    await callTool({ url: server.url }, "class_get", {});

    expect(exporter.getFinishedSpans().map((span) => span.name)).toEqual(["tools/call class_get"]);
    const span = spanNamed("tools/call class_get");
    expect(span.status.code).not.toBe(SpanStatusCode.ERROR);
    expect(span.attributes).toMatchObject({ "mcp.protocol.version": "2025-06-18", "mcp.session.id": "session-1" });
  });

  it("adds the trace context to the _meta the request carries, with the baggage", async () => {
    registerSdk();
    const server = await fakeMcpServer();
    const withBaggage = propagation.setBaggage(
      context.active(),
      propagation.createBaggage({ run: { value: "r1" } }),
    );

    await context.with(withBaggage, () =>
      request(server.url, "tools/call", { name: "class_get", _meta: { progressToken: 7 } }, { timeoutMs: 1_000 }),
    );

    const [call] = server.received;
    expect(call.params?._meta).toEqual({
      ...modernMeta,
      progressToken: 7,
      traceparent: expect.stringMatching(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/),
      baggage: "run=r1",
    });
  });

  it("passes the call's trace context in a legacy handshake, and the caller's in a ping, which are no spans of their own", async () => {
    registerSdk();
    const server = await fakeMcpServer(standardAnswer, { legacy: true });

    await trace.getTracer("test").startActiveSpan("caller", async (caller) => {
      await callTool({ url: server.url }, "class_get", {});
      await ping({ url: server.url });
      caller.end();
    });

    const parent = (name: string) => {
      const span = spanNamed(name).spanContext();
      return { traceparent: `00-${span.traceId}-${span.spanId}-01` };
    };
    const sent = (method: string) => server.received.find((each) => each.method === method)?.params;
    expect(sent("initialize")).toEqual({
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "plexus", version: expect.any(String) },
      _meta: parent("tools/call class_get"),
    });
    expect(sent("notifications/initialized")).toEqual({ _meta: parent("tools/call class_get") });
    expect(sent("ping")).toEqual({ _meta: parent("caller") });
    expect(exporter.getFinishedSpans().map((span) => span.name)).toEqual(["tools/call class_get", "caller"]);
  });

  it("records an IPv6 address without the brackets a URL keeps", async () => {
    registerSdk();

    await request("http://[::1]:9/", "tools/list", undefined, { timeoutMs: 200 }).catch(() => undefined);

    expect(spanNamed("tools/list").attributes).toMatchObject({ "server.address": "::1", "server.port": 9 });
  });

  it("names a listing after its method alone, without a tool or an operation", async () => {
    registerSdk();
    const server = await fakeMcpServer();

    await listTools({ url: server.url });

    const span = spanNamed("tools/list");
    expect(span.attributes["mcp.method.name"]).toBe("tools/list");
    expect(span.attributes).not.toHaveProperty("gen_ai.tool.name");
    expect(span.attributes).not.toHaveProperty("gen_ai.operation.name");
    expect(server.received.find((each) => each.method === "tools/list")?.params?._meta).toEqual({
      ...modernMeta,
      traceparent: expect.any(String),
    });
  });

  it("records a tool name that is no identifier as _OTHER", async () => {
    registerSdk();
    const server = await fakeMcpServer();

    await callTool({ url: server.url }, "Smalltalk at: #Secret", {});

    expect(spanNamed("tools/call _OTHER").attributes["gen_ai.tool.name"]).toBe("_OTHER");
    expectNoValues("Secret");
  });

  it("carries the session it runs in, or the process's own, never one the caller's baggage names", async () => {
    registerSdk();
    const server = await fakeMcpServer();
    const callers = propagation.setBaggage(context.active(), propagation.createBaggage({ "session.id": { value: "alice" } }));

    await context.with(callers, () => callTool({ url: server.url }, "class_get", {}));
    await context.with(withSession(callers, "s-1"), () => callTool({ url: server.url }, "class_get", {}));
    await callTool({ url: server.url }, "class_get", {});

    const [inCaller, inSession, alone] = exporter.getFinishedSpans().map((span) => span.attributes["session.id"]);
    expect(inSession).toBe("s-1");
    expect(inCaller).toMatch(/^[0-9a-f-]{36}$/);
    expect(alone).toBe(inCaller);
    const sent = server.received.filter((each) => each.method === "tools/call").map((each) => each.params?._meta);
    expect((sent[1] as { baggage?: string }).baggage).toBe("session.id=s-1");
  });

  it("does not fail a call meant to end the image when its connection closes or no answer comes", async () => {
    registerSdk();
    const cases: Array<[(method: string) => Reply | undefined, string | undefined]> = [
      [(method) => (method === "tools/call" ? "never" : standardAnswer(method)), "timeout"],
      [(method) => (method === "tools/call" ? { error: { code: -32603, message: "no" } } : standardAnswer(method)), "-32603"],
    ];
    for (const [answer, type] of cases) {
      exporter.reset();
      const server = await fakeMcpServer(answer);
      const failure = await callTool({ url: server.url }, "evaluate", { code: "quit" }, { minimumMs: 200, endsImage: true }).then(
        () => undefined,
        (error: Error & { kind?: string }) => error.kind,
      );

      const span = spanNamed("tools/call evaluate");
      if (type === "timeout") {
        expect(failure).toBe("timeout");
        expect(span.status.code).toBe(SpanStatusCode.UNSET);
        expect(span.attributes).not.toHaveProperty("error.type");
      } else {
        expect(span.attributes["error.type"]).toBe(type);
      }
    }

    exporter.reset();
    const closing = http.createServer((incoming, response) => {
      let body = "";
      incoming.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
      incoming.on("end", () => {
        const message = JSON.parse(body) as { id?: string; method: string };
        if (message.method === "tools/call") {
          incoming.socket.destroy();
          return;
        }
        response.writeHead(message.id === undefined ? 202 : 200, { "content-type": "application/json" });
        response.end(message.id === undefined ? undefined : JSON.stringify({ jsonrpc: "2.0", id: message.id, ...(standardAnswer(message.method) as object) }));
      });
    });
    servers.push(closing);
    await new Promise<void>((resolve) => closing.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(closing.address() as AddressInfo).port}/`;
    const kind = await callTool({ url }, "evaluate", { code: "quit" }, { endsImage: true }).catch((error: { kind?: string }) => error.kind);
    expect(kind).toBe("closed");
    expect(spanNamed("tools/call evaluate").attributes).not.toHaveProperty("error.type");
  });

  it("fails with a kind, described by the JSON-RPC error's message alone: an error result, a JSON-RPC error, an HTTP status, a timeout", async () => {
    registerSdk();
    const cases: Array<[Reply, string, string?]> = [
      [{ result: { content: [{ type: "text", text: "No class SecretClass" }], isError: true } }, "tool_error"],
      [{ error: { code: -32602, message: "Invalid params: SecretClass" } }, "-32602", "Invalid params: SecretClass"],
      // An image refuses a request it cannot take with 400 and a JSON-RPC error: that error is the answer.
      [{ status: 400, error: { code: -32600, message: "Unsupported protocol version" } }, "-32600", "Unsupported protocol version"],
      [{ status: 500, result: {} }, "500"],
      ["never", "timeout"],
    ];
    for (const [reply, type, message] of cases) {
      exporter.reset();
      const server = await fakeMcpServer((method) => (method === "tools/call" ? reply : standardAnswer(method)));

      const failure = await callTool({ url: server.url }, "class_get", { name: "SecretClass" }, { minimumMs: 200 }).then(
        () => undefined,
        (error: Error & { kind?: string }) => error,
      );

      const span = spanNamed("tools/call class_get");
      expect(span.status, type).toEqual({ code: SpanStatusCode.ERROR, ...(message === undefined ? {} : { message }) });
      expect(span.attributes["error.type"]).toBe(type);
      expect(span.attributes["rpc.status_code"]).toBe(message === undefined ? undefined : type);
      expect(span.events).toEqual([]);
      expect(span.attributes["gen_ai.tool.call.arguments"]).toBeUndefined();
      if (message !== undefined) {
        expect(failure?.kind).toBe("answered");
        expect(failure?.message).toBe(`MCP error ${type}: ${message}`);
      }
    }
  });

  it("counts a JSON-RPC code as a server's error unless it says the request was the caller's fault", () => {
    expect([-32700, -32600, -32601, -32602, -32002].map(serverFailedWith)).toEqual([false, false, false, false, false]);
    expect([-32603, -32000, 1].map(serverFailedWith)).toEqual([true, true, true]);
    expect(answeredCode(Object.assign(new Error("Invalid params"), { code: -32602 }))).toBe(-32602);
    expect(answeredCode(new PlexusError("no-such-image", "No image dev."))).toBe(-32603);
    expect(answeredCode("not an error")).toBe(-32603);
  });

  it("records the arguments, and the result of a call that succeeded, only when content is turned on", async () => {
    registerSdk();
    const answers: Record<string, Reply> = {
      ok: { result: { content: [{ type: "text", text: "Object subclass: #SecretClass" }] } },
      failed: { result: { content: [{ type: "text", text: "No class SecretClass" }], isError: true } },
    };
    const recorded = async (capture: string | undefined, outcome: string) => {
      exporter.reset();
      const server = await fakeMcpServer((method) => (method === "tools/call" ? answers[outcome] : standardAnswer(method)));
      const previous = process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_CONTENT;
      if (capture === undefined) delete process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_CONTENT;
      else process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_CONTENT = capture;
      try {
        await callTool({ url: server.url }, "class_get", { name: "SecretClass" });
      } finally {
        if (previous === undefined) delete process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_CONTENT;
        else process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_CONTENT = previous;
      }
      const span = spanNamed("tools/call class_get");
      return [span.attributes["gen_ai.tool.call.arguments"], span.attributes["gen_ai.tool.call.result"]];
    };

    // The values themselves, as the conventions ask, never their JSON.
    expect(await recorded("span_only", "ok")).toEqual([
      { name: "SecretClass" },
      [{ type: "text", text: "Object subclass: #SecretClass" }],
    ]);
    expect(await recorded("SPAN_AND_EVENT", "failed")).toEqual([{ name: "SecretClass" }, undefined]);
    for (const capture of [undefined, "NO_CONTENT", "EVENT_ONLY", "yes"]) {
      expect(await recorded(capture, "ok"), String(capture)).toEqual([undefined, undefined]);
    }
  });
});

describe("the image verbs with an SDK", () => {
  it("are INTERNAL spans that say how they ended, and nothing of the image", async () => {
    registerSdk();
    const home = tempHome();
    const launcher = new FakeLauncher(home);
    writeLauncherImage(path.join(storeRoot(home), "Secret-dev"), "Secret-dev");
    const images = imagesWith({ home, scope: "Secret", launcher });

    await images.create("dev", { template: "Pharo 14.0 - 64bit", category: "Official" }).catch(() => undefined);
    await images.delete("dev");
    await images.delete("dev").catch(() => undefined);
    await images.stop("dev").catch(() => undefined);

    const [taken, deleted, refused, stopped] = exporter.getFinishedSpans();
    const session = taken.attributes["session.id"];
    expect(session).toMatch(/^[0-9a-f-]{36}$/);
    expect([taken.name, taken.kind, taken.attributes]).toEqual([
      "plexus.image.create",
      SpanKind.INTERNAL,
      { "error.type": "image-exists", "session.id": session },
    ]);
    expect([deleted.name, deleted.kind, deleted.status.code]).toEqual([
      "plexus.image.delete",
      SpanKind.INTERNAL,
      SpanStatusCode.UNSET,
    ]);
    expect(deleted.attributes).toEqual({ "session.id": session });
    expect([refused.name, refused.status, refused.attributes]).toEqual([
      "plexus.image.delete",
      { code: SpanStatusCode.ERROR },
      { "error.type": "no-such-image", "session.id": session },
    ]);
    expect([stopped.name, stopped.attributes]).toEqual([
      "plexus.image.stop",
      { "plexus.image.save": false, "error.type": "no-such-image", "session.id": session },
    ]);
    expectNoValues("Secret", "dev", home);
    expect(fs.existsSync(path.join(storeRoot(home), "Secret-dev"))).toBe(false);
  });
});
