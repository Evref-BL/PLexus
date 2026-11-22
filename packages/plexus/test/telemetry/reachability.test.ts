import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { context, propagation, trace } from "@opentelemetry/api";
import { ExportResultCode, type ExportResult } from "@opentelemetry/core";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GuardedExporter,
  isLoopback,
  Reachability,
  readReachability,
  reachabilityFile,
  retryDelayMs,
  tracesEndpoint,
  writeReachability,
} from "../../src/telemetry/reachability.js";
import { exportTimings, startTelemetry } from "../../src/telemetry/sdk.js";

const minutes = 60_000;
const start = Date.UTC(2026, 10, 19, 12);

let directory: string;
let file: string;
const servers: http.Server[] = [];

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "plexus-reachability-"));
  file = path.join(directory, "plexus", "otel-reachability.json");
  vi.stubEnv("XDG_CACHE_HOME", directory);
});

afterEach(async () => {
  trace.disable();
  propagation.disable();
  context.disable();
  vi.unstubAllEnvs();
  vi.doUnmock("@opentelemetry/sdk-trace");
  fs.rmSync(directory, { recursive: true, force: true });
  await Promise.all(
    servers.splice(0).map((server) => {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(resolve));
    }),
  );
});

/** A collector that counts what it is sent. */
async function collector() {
  const received: string[] = [];
  const server = http.createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      received.push(request.url ?? "");
      response.writeHead(200, { "content-type": "application/json" }).end("{}");
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, received };
}

/** A localhost port nothing listens on. */
async function closedPort(): Promise<string> {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return `http://127.0.0.1:${port}`;
}

/** An exporter that answers each export with the next of `results`, and counts the exports. */
function fakeExporter(...results: Array<ExportResult | "throw" | "reject">) {
  const exporter = {
    calls: 0,
    export(_spans: ReadableSpan[], done: (result: ExportResult) => void): unknown {
      exporter.calls += 1;
      const result = results.shift() ?? { code: ExportResultCode.SUCCESS };
      if (result === "throw") {
        throw new Error("no network");
      }
      if (result === "reject") {
        return Promise.reject(new Error("no network"));
      }
      done(result);
      return undefined;
    },
    shutdown: async () => undefined,
  };
  return exporter;
}

function exportOnce(exporter: SpanExporter): Promise<ExportResult> {
  return new Promise((resolve) => exporter.export([], resolve));
}

const failed = { code: ExportResultCode.FAILED };
const succeeded = { code: ExportResultCode.SUCCESS };

describe("the reachability state", () => {
  it("lives in the user's cache directory", () => {
    expect(reachabilityFile({ XDG_CACHE_HOME: "/cache" }, "linux", "/home/me")).toBe(
      "/cache/plexus/otel-reachability.json",
    );
    expect(reachabilityFile({}, "darwin", "/Users/me")).toBe("/Users/me/.cache/plexus/otel-reachability.json");
    expect(reachabilityFile({ LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" }, "win32", "C:\\Users\\me")).toBe(
      "C:\\Users\\me\\AppData\\Local\\plexus\\otel-reachability.json",
    );
  });

  it("is keyed by the traces endpoint the exporter sends to", () => {
    expect(tracesEndpoint({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318" })).toBe(
      "http://localhost:4318/v1/traces",
    );
    expect(tracesEndpoint({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318/" })).toBe(
      "http://localhost:4318/v1/traces",
    );
    expect(
      tracesEndpoint({
        OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318",
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://collector/traces",
      }),
    ).toBe("http://collector/traces");
    expect(tracesEndpoint({})).toBeUndefined();
  });

  it("is written whole and read back, leaving no temporary file", () => {
    const state = { "http://a/v1/traces": { failures: 2, retryAt: start } };
    writeReachability(file, state);

    expect(readReachability(file)).toEqual(state);
    expect(fs.readdirSync(path.dirname(file))).toEqual(["otel-reachability.json"]);
  });

  it("is no state when missing, malformed or not an object, and keeps only well-formed entries", () => {
    expect(readReachability(file)).toEqual({});
    for (const text of ["{not json", "[]", "null", "3", ""]) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
      expect(readReachability(file), text).toEqual({});
    }
    fs.writeFileSync(
      file,
      JSON.stringify({ a: { failures: "1", retryAt: 1 }, b: null, c: { failures: 1 }, d: { failures: 1, retryAt: 9 } }),
    );
    expect(readReachability(file)).toEqual({ d: { failures: 1, retryAt: 9 } });
  });

  it("is not written, and fails nothing, where it cannot be", () => {
    const blocker = path.join(directory, "a-file");
    fs.writeFileSync(blocker, "");

    expect(() => writeReachability(path.join(blocker, "plexus", "otel-reachability.json"), {})).not.toThrow();
    expect(readReachability(path.join(blocker, "plexus", "otel-reachability.json"))).toEqual({});
  });

  it("leaves an endpoint alone five minutes after a failure, doubling up to six hours", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8, 100].map((failures) => retryDelayMs(failures) / minutes)).toEqual([
      5, 10, 20, 40, 80, 160, 320, 360, 360,
    ]);
  });
});

describe("an export to an endpoint", () => {
  const endpoint = "http://collector/v1/traces";

  it("records a failure, then fails at once without the exporter until the time to try again", async () => {
    let now = start;
    const exporter = fakeExporter(failed, failed);
    const guarded = new GuardedExporter(exporter, new Reachability(file, endpoint, () => now), ExportResultCode);

    expect((await exportOnce(guarded)).code).toBe(ExportResultCode.FAILED);
    expect(readReachability(file)).toEqual({ [endpoint]: { failures: 1, retryAt: start + 5 * minutes } });

    now += 5 * minutes - 1;
    expect((await exportOnce(guarded)).code).toBe(ExportResultCode.FAILED);
    expect(exporter.calls).toBe(1);

    now += 1;
    expect((await exportOnce(guarded)).code).toBe(ExportResultCode.FAILED);
    expect(exporter.calls).toBe(2);
    expect(readReachability(file)).toEqual({ [endpoint]: { failures: 2, retryAt: now + 10 * minutes } });
  });

  it("records a failure when the exporter throws or rejects", async () => {
    const reachability = new Reachability(file, endpoint, () => start);
    let now = start;
    for (const [index, outcome] of (["throw", "reject"] as const).entries()) {
      // A process that failed waits; another one, once that wait is over, tries again.
      const guarded = new GuardedExporter(fakeExporter(outcome), new Reachability(file, endpoint, () => now), ExportResultCode);
      expect((await exportOnce(guarded)).code).toBe(ExportResultCode.FAILED);
      expect(readReachability(file)[endpoint]?.failures).toBe(index + 1);
      now = readReachability(file)[endpoint]?.retryAt ?? now;
    }
    expect(reachability.isOpen()).toBe(true);
  });

  it("waits out the time to try again that another process's failure set", async () => {
    let now = start;
    const exporter = fakeExporter(succeeded, succeeded);
    const guarded = new GuardedExporter(exporter, new Reachability(file, endpoint, () => now), ExportResultCode);
    writeReachability(file, { [endpoint]: { failures: 2, retryAt: start + 10 * minutes } });

    expect((await exportOnce(guarded)).code).toBe(ExportResultCode.FAILED);
    expect(exporter.calls).toBe(0);

    now = start + 10 * minutes;
    expect((await exportOnce(guarded)).code).toBe(ExportResultCode.SUCCESS);
    expect(exporter.calls).toBe(1);
    expect(readReachability(file)).toEqual({});
  });

  it("takes a collector that refused the batch, as malformed or too large, for one it reached", async () => {
    for (const status of [400, 413]) {
      writeReachability(file, { [endpoint]: { failures: 1, retryAt: start } });
      const refused = { code: ExportResultCode.FAILED, error: Object.assign(new Error("refused"), { code: status }) };
      const guarded = new GuardedExporter(fakeExporter(refused), new Reachability(file, endpoint, () => start), ExportResultCode);

      expect((await exportOnce(guarded)).code).toBe(ExportResultCode.FAILED);
      expect(readReachability(file), String(status)).toEqual({});
    }
    const unauthorized = { code: ExportResultCode.FAILED, error: Object.assign(new Error("no"), { code: 401 }) };
    await exportOnce(new GuardedExporter(fakeExporter(unauthorized), new Reachability(file, endpoint, () => start), ExportResultCode));
    expect(readReachability(file)[endpoint]?.failures).toBe(1);
  });

  it("fails an export that has not ended by its deadline, and remembers the endpoint", async () => {
    const silent: SpanExporter = { export: () => undefined, shutdown: async () => undefined };
    const guarded = new GuardedExporter(silent, new Reachability(file, endpoint, () => start), ExportResultCode, 20);

    expect((await exportOnce(guarded)).code).toBe(ExportResultCode.FAILED);
    expect(readReachability(file)[endpoint]).toEqual({ failures: 1, retryAt: start + 5 * minutes });
  });

  it("clears the endpoint's entry when it succeeds, and writes nothing when there was none", async () => {
    const other = { failures: 1, retryAt: start + minutes };
    writeReachability(file, { [endpoint]: { failures: 3, retryAt: start - 1 }, other });
    const guarded = new GuardedExporter(fakeExporter(succeeded), new Reachability(file, endpoint, () => start), ExportResultCode);

    expect((await exportOnce(guarded)).code).toBe(ExportResultCode.SUCCESS);
    expect(readReachability(file)).toEqual({ other });

    fs.rmSync(file);
    await exportOnce(guarded);
    expect(fs.existsSync(file)).toBe(false);
  });
});

describe("an endpoint on this machine", () => {
  it("is localhost, 127.0.0.0/8 or ::1", () => {
    for (const endpoint of ["http://localhost:4318/v1/traces", "http://127.0.0.1:4318/v1/traces", "http://127.1.2.3/v1/traces", "http://[::1]:4318/v1/traces"]) {
      expect(isLoopback(endpoint), endpoint).toBe(true);
    }
    for (const endpoint of ["http://collector.test/v1/traces", "http://10.0.0.1/v1/traces", "http://localhost.example/v1/traces", "not a url"]) {
      expect(isLoopback(endpoint), endpoint).toBe(false);
    }
  });

  it("is never left alone: its failures are not recorded, and an entry an earlier PLexus wrote goes once it answers", async () => {
    const endpoint = "http://127.0.0.1:4318/v1/traces";
    writeReachability(file, { [endpoint]: { failures: 3, retryAt: start + 20 * minutes } });
    const exporter = fakeExporter(failed, succeeded);
    const reachability = new Reachability(file, endpoint, () => start);
    const guarded = new GuardedExporter(exporter, reachability, ExportResultCode);

    expect(reachability.isOpen()).toBe(false);
    expect((await exportOnce(guarded)).code).toBe(ExportResultCode.FAILED);
    expect(readReachability(file)[endpoint]?.failures).toBe(3);
    expect((await exportOnce(guarded)).code).toBe(ExportResultCode.SUCCESS);
    expect(exporter.calls).toBe(2);
    expect(readReachability(file)).toEqual({});
  });
});

describe("the command's SDK and an unreachable collector", () => {
  const elsewhere = "http://collector.test:4318";

  it("is not loaded, and sends nothing, while a collector elsewhere has its time to try again to come", async () => {
    vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", elsewhere);
    writeReachability(file, { [`${elsewhere}/v1/traces`]: { failures: 1, retryAt: start + 1 } });
    let loaded = false;
    vi.doMock("@opentelemetry/sdk-trace", async (original) => {
      loaded = true;
      return original();
    });

    const telemetry = await startTelemetry(process.env, { now: () => start });
    const recording = telemetry.within(() => {
      const span = trace.getTracer("t").startSpan("x");
      span.end();
      return span.isRecording();
    });
    await telemetry.shutdown();

    expect(loaded).toBe(false);
    expect(recording).toBe(false);
  });

  it("is installed in a process that serves all the same, which passes the trace context on and sends once that time has come", async () => {
    let now = start;
    // A documentation address: nothing answers there.
    vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://192.0.2.1:4318");
    vi.stubEnv("OTEL_EXPORTER_OTLP_TIMEOUT", "200");
    vi.stubEnv("OTEL_BSP_SCHEDULE_DELAY", "10");
    const key = "http://192.0.2.1:4318/v1/traces";
    writeReachability(file, { [key]: { failures: 1, retryAt: start + 5 * minutes } });

    const telemetry = await startTelemetry(process.env, { longLived: true, reachabilityFile: file, now: () => now });
    const carrier: Record<string, string> = {};
    telemetry.within(() => {
      const span = trace.getTracer("t").startSpan("x");
      context.with(trace.setSpan(context.active(), span), () => propagation.inject(context.active(), carrier));
      expect(span.isRecording()).toBe(true);
      span.end();
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(carrier.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    expect(readReachability(file)[key]?.failures).toBe(1);

    now = start + 5 * minutes;
    trace.getTracer("t").startSpan("y").end();
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(readReachability(file)[key]?.failures).toBe(2);
    await telemetry.shutdown();
  });

  it("records a failure when a collector elsewhere does not answer, before the command ends, and is not installed in the next process", async () => {
    vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://192.0.2.1:4318");
    vi.stubEnv("OTEL_EXPORTER_OTLP_TIMEOUT", "500");

    const telemetry = await startTelemetry(process.env, { reachabilityFile: file, now: () => start });
    trace.getTracer("t").startSpan("x").end();
    await telemetry.shutdown();

    expect(readReachability(file)).toEqual({
      "http://192.0.2.1:4318/v1/traces": { failures: 1, retryAt: start + 5 * minutes },
    });
    trace.disable();
    const next = await startTelemetry(process.env, { reachabilityFile: file, now: () => start + minutes });
    expect(trace.getTracer("t").startSpan("x").isRecording()).toBe(false);
    await next.shutdown();
  });

  it("sends to a collector on this machine whatever its last export did, and records nothing when it refuses", async () => {
    const { endpoint, received } = await collector();
    vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", endpoint);
    writeReachability(file, { [`${endpoint}/v1/traces`]: { failures: 4, retryAt: start + 60 * minutes } });

    const telemetry = await startTelemetry(process.env, { now: () => start });
    trace.getTracer("t").startSpan("x").end();
    await telemetry.shutdown();

    expect(received).toEqual(["/v1/traces"]);
    expect(readReachability(file)).toEqual({});

    trace.disable();
    const refusing = await closedPort();
    vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", refusing);
    vi.stubEnv("OTEL_EXPORTER_OTLP_TIMEOUT", "200");
    const next = await startTelemetry(process.env, { now: () => start });
    trace.getTracer("t").startSpan("x").end();
    await next.shutdown();
    expect(readReachability(file)).toEqual({});
  });

  it("waits a second at most at exit, and gives a long-lived process's batches the whole export timeout", () => {
    expect(exportTimings({ protocol: "http/protobuf", timeoutMs: 2_000, batch: {} })).toEqual({
      exportTimeoutMs: 1_000,
      deadlineMs: 900,
      exitWaitMs: 1_000,
    });
    expect(exportTimings({ protocol: "http/protobuf", timeoutMs: 2_000, batch: {} }, true)).toEqual({
      exportTimeoutMs: 2_000,
      deadlineMs: 2_000,
      exitWaitMs: 1_000,
    });
    expect(exportTimings({ protocol: "http/protobuf", timeoutMs: 200, batch: {} }, true)).toEqual({
      exportTimeoutMs: 200,
      deadlineMs: 200,
      exitWaitMs: 200,
    });
  });
});
