import http from "node:http";
import type { AddressInfo } from "node:net";
import { context, propagation, SpanKind, trace } from "@opentelemetry/api";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startTelemetry, tracesExport } from "../../src/telemetry/sdk.js";
import { inSpan } from "../../src/telemetry/trace.js";
import { plexusVersion } from "../../src/version.js";

const servers: http.Server[] = [];

afterEach(async () => {
  trace.disable();
  propagation.disable();
  context.disable();
  vi.unstubAllEnvs();
  await Promise.all(
    servers.splice(0).map((server) => {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(resolve));
    }),
  );
});

/** A collector that keeps what it is sent, or never answers. */
async function collector(answer = true) {
  const received: Array<{ path: string; type: string; body: Buffer }> = [];
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      received.push({
        path: request.url ?? "",
        type: request.headers["content-type"] ?? "",
        body: Buffer.concat(chunks),
      });
      if (answer) {
        response.writeHead(200, { "content-type": "application/json" }).end("{}");
      }
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, received };
}

describe("what the environment asks of traces", () => {
  const endpoint = { OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318" };

  it("is an OTLP export over HTTP once an endpoint is set, protobuf and two seconds unless told otherwise", () => {
    expect(tracesExport(endpoint)).toEqual({ protocol: "http/protobuf", timeoutMs: 2_000 });
    expect(tracesExport({ OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://localhost:4318/v1/traces", OTEL_TRACES_EXPORTER: "otlp" })).toEqual({
      protocol: "http/protobuf",
      timeoutMs: 2_000,
    });
    expect(tracesExport({ ...endpoint, OTEL_EXPORTER_OTLP_PROTOCOL: "http/json", OTEL_EXPORTER_OTLP_TIMEOUT: "500" })).toEqual({
      protocol: "http/json",
      timeoutMs: 500,
    });
    expect(tracesExport({ ...endpoint, OTEL_EXPORTER_OTLP_TIMEOUT: "soon" })?.timeoutMs).toBe(2_000);
  });

  it("is nothing without an endpoint, when disabled, for another exporter, or over gRPC", () => {
    for (const env of [
      {},
      { OTEL_TRACES_EXPORTER: "otlp" },
      { ...endpoint, OTEL_SDK_DISABLED: "true" },
      { ...endpoint, OTEL_TRACES_EXPORTER: "none" },
      { ...endpoint, OTEL_TRACES_EXPORTER: "console" },
      { ...endpoint, OTEL_EXPORTER_OTLP_PROTOCOL: "grpc" },
    ]) {
      expect(tracesExport(env), JSON.stringify(env)).toBeUndefined();
    }
  });
});

describe("the command's SDK", () => {
  it("is not installed when nothing asks for it", async () => {
    const telemetry = await startTelemetry({});

    expect(telemetry.within(() => trace.getTracer("t").startSpan("x").isRecording())).toBe(false);
    await telemetry.shutdown();
  });

  it("exports the command's spans under the caller's TRACEPARENT, with no host or process resource", async () => {
    const { endpoint, received } = await collector();
    const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
    const parentId = "00f067aa0ba902b7";
    vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", endpoint);
    vi.stubEnv("OTEL_EXPORTER_OTLP_PROTOCOL", "http/json");
    vi.stubEnv("OTEL_RESOURCE_ATTRIBUTES", "deployment.environment.name=test");
    vi.stubEnv("TRACEPARENT", `00-${traceId}-${parentId}-01`);

    const telemetry = await startTelemetry(process.env);
    await telemetry.within(() => inSpan("plexus.image.start", SpanKind.INTERNAL, {}, async () => undefined));
    await telemetry.shutdown();

    expect(received.map((each) => [each.path, each.type])).toEqual([["/v1/traces", "application/json"]]);
    const sent = JSON.parse(received[0].body.toString("utf8")) as {
      resourceSpans: Array<{
        resource: { attributes: Array<{ key: string; value: { stringValue?: string } }> };
        scopeSpans: Array<{ spans: Array<{ name: string; traceId: string; parentSpanId: string }> }>;
      }>;
    };
    const [resourceSpans] = sent.resourceSpans;
    const resource = Object.fromEntries(
      resourceSpans.resource.attributes.map((attribute) => [attribute.key, attribute.value.stringValue]),
    );
    expect(resource).toMatchObject({
      "service.name": "plexus",
      "service.version": plexusVersion,
      "os.type": expect.any(String),
      "deployment.environment.name": "test",
    });
    expect(Object.keys(resource).filter((key) => key.startsWith("host.") || key.startsWith("process."))).toEqual([]);
    expect(resourceSpans.scopeSpans[0].spans).toMatchObject([
      { name: "plexus.image.start", traceId, parentSpanId: parentId },
    ]);
  });

  it("sends protobuf unless told otherwise", async () => {
    const { endpoint, received } = await collector();
    vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", endpoint);

    const telemetry = await startTelemetry(process.env);
    trace.getTracer("t").startSpan("x").end();
    await telemetry.shutdown();

    expect(received.map((each) => [each.path, each.type])).toEqual([["/v1/traces", "application/x-protobuf"]]);
  });

  it("ends within the export timeout when the collector does not answer, and fails nothing", async () => {
    const { endpoint } = await collector(false);
    vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", endpoint);
    vi.stubEnv("OTEL_EXPORTER_OTLP_TIMEOUT", "200");

    const telemetry = await startTelemetry(process.env);
    trace.getTracer("t").startSpan("x").end();
    const startedAt = Date.now();
    await telemetry.shutdown();

    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });
});
