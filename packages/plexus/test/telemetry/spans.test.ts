import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { context, propagation, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { CompositePropagator, W3CBaggagePropagator, W3CTraceContextPropagator } from "@opentelemetry/core";
import { InMemorySpanExporter, SimpleSpanProcessor, TracerProvider, type ReadableSpan } from "@opentelemetry/sdk-trace";
import { afterEach, describe, expect, it } from "vitest";
import { callTool, listTools } from "../../src/forward/index.js";
import { request } from "../../src/forward/jsonRpc.js";
import { storeRoot } from "../../src/home.js";
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

/** An MCP server over HTTP that keeps the params of every request it gets. */
async function fakeMcpServer(
  answer: (method: string) => Reply | undefined = standardAnswer,
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
    expect(calls[0].params).toEqual({ name: "class_get", arguments: { name: "SecretClass" } });
    expect(calls[1].params).toEqual({ name: "class_get", _meta: { progressToken: 7 } });
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
      "gen_ai.tool.name": "class_get",
      "gen_ai.operation.name": "execute_tool",
      "mcp.protocol.version": "2025-06-18",
      "mcp.session.id": "session-1",
      "network.transport": "tcp",
      "network.protocol.name": "http",
    });

    const call = server.received.find((each) => each.method === "tools/call")!;
    expect(call.params).toEqual({
      name: "class_get",
      arguments: { name: "SecretClass" },
      _meta: { traceparent: `00-${span.spanContext().traceId}-${span.spanContext().spanId}-01` },
    });
    expectNoValues("SecretClass");
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
      progressToken: 7,
      traceparent: expect.stringMatching(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/),
      baggage: "run=r1",
    });
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

  it("fails with a kind and no description: an error result, a JSON-RPC error, an HTTP status, a timeout", async () => {
    registerSdk();
    const cases: Array<[Reply, string]> = [
      [{ result: { content: [{ type: "text", text: "No class SecretClass" }], isError: true } }, "tool_error"],
      [{ error: { code: -32602, message: "Invalid params: SecretClass" } }, "-32602"],
      [{ status: 500, result: {} }, "500"],
      ["never", "timeout"],
    ];
    for (const [reply, type] of cases) {
      exporter.reset();
      const server = await fakeMcpServer((method) => (method === "tools/call" ? reply : standardAnswer(method)));

      await callTool({ url: server.url }, "class_get", { name: "SecretClass" }, { minimumMs: 200 }).catch(() => undefined);

      const span = spanNamed("tools/call class_get");
      expect(span.status, type).toEqual({ code: SpanStatusCode.ERROR });
      expect(span.attributes["error.type"]).toBe(type);
      expect(span.events).toEqual([]);
      expectNoValues("SecretClass");
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
    expect([taken.name, taken.kind, taken.attributes]).toEqual([
      "plexus.image.create",
      SpanKind.INTERNAL,
      { "error.type": "image-exists" },
    ]);
    expect([deleted.name, deleted.kind, deleted.status.code]).toEqual([
      "plexus.image.delete",
      SpanKind.INTERNAL,
      SpanStatusCode.UNSET,
    ]);
    expect(deleted.attributes).toEqual({});
    expect([refused.name, refused.status, refused.attributes]).toEqual([
      "plexus.image.delete",
      { code: SpanStatusCode.ERROR },
      { "error.type": "no-such-image" },
    ]);
    expect([stopped.name, stopped.attributes]).toEqual([
      "plexus.image.stop",
      { "plexus.image.save": false, "error.type": "no-such-image" },
    ]);
    expectNoValues("Secret", "dev", home);
    expect(fs.existsSync(path.join(storeRoot(home), "Secret-dev"))).toBe(false);
  });
});
