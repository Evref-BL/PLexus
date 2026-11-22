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
    for (const [index, outcome] of (["throw", "reject"] as const).entries()) {
      // A process that failed waits; another one, later, tries again.
      const guarded = new GuardedExporter(fakeExporter(outcome), new Reachability(file, endpoint, () => start), ExportResultCode);
      expect((await exportOnce(guarded)).code).toBe(ExportResultCode.FAILED);
      expect(readReachability(file)[endpoint]?.failures).toBe(index + 1);
    }
    expect(reachability.isOpen()).toBe(true);
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

describe("the command's SDK and an unreachable collector", () => {
  it("is not loaded, and sends nothing, while the endpoint's time to try again is to come", async () => {
    const { endpoint, received } = await collector();
    vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", endpoint);
    writeReachability(file, { [`${endpoint}/v1/traces`]: { failures: 1, retryAt: start + 1 } });
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
    expect(received).toEqual([]);
  });

  it("records a failure when the endpoint refuses, and is not installed in the next process", async () => {
    const endpoint = await closedPort();
    vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", endpoint);
    vi.stubEnv("OTEL_EXPORTER_OTLP_TIMEOUT", "200");

    const telemetry = await startTelemetry(process.env, { reachabilityFile: file, now: () => start });
    trace.getTracer("t").startSpan("x").end();
    await telemetry.shutdown();

    expect(readReachability(file)).toEqual({
      [`${endpoint}/v1/traces`]: { failures: 1, retryAt: start + 5 * minutes },
    });
    trace.disable();
    const next = await startTelemetry(process.env, { reachabilityFile: file, now: () => start + minutes });
    expect(trace.getTracer("t").startSpan("x").isRecording()).toBe(false);
    await next.shutdown();
  });

  it("sends again once the time to try again has come, and clears the entry when it succeeds", async () => {
    const { endpoint, received } = await collector();
    vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", endpoint);
    writeReachability(file, { [`${endpoint}/v1/traces`]: { failures: 4, retryAt: start } });

    const telemetry = await startTelemetry(process.env, { now: () => start });
    trace.getTracer("t").startSpan("x").end();
    await telemetry.shutdown();

    expect(received).toEqual(["/v1/traces"]);
    expect(readReachability(file)).toEqual({});
  });

  it("waits a second at most at exit, and gives a long-lived process's batches the whole export timeout", () => {
    expect(exportTimings({ protocol: "http/protobuf", timeoutMs: 2_000, batch: {} })).toEqual({
      exportTimeoutMs: 1_000,
      exitWaitMs: 1_000,
    });
    expect(exportTimings({ protocol: "http/protobuf", timeoutMs: 2_000, batch: {} }, true)).toEqual({
      exportTimeoutMs: 2_000,
      exitWaitMs: 1_000,
    });
    expect(exportTimings({ protocol: "http/protobuf", timeoutMs: 200, batch: {} }, true)).toEqual({
      exportTimeoutMs: 200,
      exitWaitMs: 200,
    });
  });
});
