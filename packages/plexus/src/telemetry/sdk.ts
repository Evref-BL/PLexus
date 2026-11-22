/**
 * The `plexus` command is an application, so it may install an OpenTelemetry
 * SDK, which the library never does. It installs one only when the standard
 * `OTEL_*` environment asks for an OTLP traces exporter, loading the SDK then
 * and not before; with nothing configured, nothing is loaded or sent.
 *
 * Nothing here reaches a command's answer or its exit status: an SDK that is
 * missing, fails to load, or fails to export leaves the command as it was,
 * and nothing is printed. A collector elsewhere that could not be reached is
 * remembered, and left alone for a while (see `reachability.ts`).
 */
import os from "node:os";
import { context, propagation, ROOT_CONTEXT, trace } from "@opentelemetry/api";
import { plexusVersion } from "../version.js";
import { GuardedExporter, Reachability, reachabilityFile, tracesEndpoint } from "./reachability.js";

/** The SDK the command installed, or none: what to run the command in, and how to end it. */
export interface Telemetry {
  /** Runs the command's work under the parent `TRACEPARENT` names, when it names one and the process does not serve. */
  within<T>(work: () => T): T;
  /** Exports what is left, waiting no longer than a second, or the export timeout when it is shorter. */
  shutdown(): Promise<void>;
}

const none: Telemetry = {
  within: (work) => work(),
  shutdown: async () => undefined,
};

/** The export timeout unless `OTEL_EXPORTER_OTLP_TIMEOUT` says otherwise: a command never waits long on telemetry. */
const defaultTimeoutMs = 2_000;

/** The longest a process waits for its spans as it ends. */
const longestExitWaitMs = 1_000;

export interface TelemetryOptions {
  /**
   * The process serves until its input closes (`plexus mcp`): its batches go
   * in the background with the whole export timeout, the SDK is installed
   * even while the collector is left alone, which its exports then wait out,
   * and its work has no parent from the environment, since each request
   * names its own. Otherwise each export is given no more than the process
   * waits at its end.
   */
  longLived?: boolean;
  /** Where reachability is kept, instead of the user's cache directory. */
  reachabilityFile?: string;
  /** The clock reachability is kept by. */
  now?: () => number;
}

/**
 * How long an export may take, when one that has not ended has failed, and
 * how long the process waits for its spans as it ends. A command's export
 * fails a little before the command stops waiting, so that a collector that
 * does not answer is remembered before the process exits.
 */
export function exportTimings(
  traces: TracesExport,
  longLived = false,
): { exportTimeoutMs: number; deadlineMs: number; exitWaitMs: number } {
  const exitWaitMs = Math.min(longestExitWaitMs, traces.timeoutMs);
  return longLived
    ? { exportTimeoutMs: traces.timeoutMs, deadlineMs: traces.timeoutMs, exitWaitMs }
    : { exportTimeoutMs: exitWaitMs, deadlineMs: Math.max(1, Math.floor(exitWaitMs * 0.9)), exitWaitMs };
}

export interface TracesExport {
  protocol: "http/protobuf" | "http/json";
  timeoutMs: number;
  /** The `OTEL_BSP_*` settings the environment gives, which the SDK's batch processor does not read itself. */
  batch: BatchSettings;
}

/** How the batch processor groups spans, as `OTEL_BSP_SCHEDULE_DELAY`, `OTEL_BSP_MAX_QUEUE_SIZE` and `OTEL_BSP_MAX_EXPORT_BATCH_SIZE` set it. */
export interface BatchSettings {
  scheduledDelayMillis?: number;
  maxQueueSize?: number;
  maxExportBatchSize?: number;
}

/**
 * What the environment asks of traces: an OTLP export over HTTP, or nothing.
 * Nothing when `OTEL_SDK_DISABLED` is true, when `OTEL_TRACES_EXPORTER` names
 * an exporter other than `otlp` (`none` among them), when no OTLP endpoint is
 * set, and when the protocol is one PLexus does not send (gRPC).
 */
export function tracesExport(env: NodeJS.ProcessEnv): TracesExport | undefined {
  if (env.OTEL_SDK_DISABLED?.trim().toLowerCase() === "true") {
    return undefined;
  }
  const exporters = (env.OTEL_TRACES_EXPORTER ?? "")
    .split(",")
    .map((each) => each.trim().toLowerCase())
    .filter((each) => each !== "");
  if (exporters.length > 0 && !(exporters.length === 1 && exporters[0] === "otlp")) {
    return undefined;
  }
  if (!(env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim() || env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim())) {
    return undefined;
  }
  const protocol = (
    env.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL?.trim() ||
    env.OTEL_EXPORTER_OTLP_PROTOCOL?.trim() ||
    "http/protobuf"
  ).toLowerCase();
  if (protocol !== "http/protobuf" && protocol !== "http/json") {
    return undefined;
  }
  const timeoutMs =
    positive(env.OTEL_EXPORTER_OTLP_TRACES_TIMEOUT) ?? positive(env.OTEL_EXPORTER_OTLP_TIMEOUT) ?? defaultTimeoutMs;
  return { protocol, timeoutMs, batch: batchSettings(env) };
}

/**
 * The batch settings the environment gives. SDK 3's `BatchSpanProcessor`
 * reads only its options, so without this a participant's
 * `OTEL_BSP_SCHEDULE_DELAY` would reach the images and not PLexus.
 */
export function batchSettings(env: NodeJS.ProcessEnv): BatchSettings {
  const settings: BatchSettings = {};
  const delay = positive(env.OTEL_BSP_SCHEDULE_DELAY);
  const queue = positive(env.OTEL_BSP_MAX_QUEUE_SIZE);
  const batch = positive(env.OTEL_BSP_MAX_EXPORT_BATCH_SIZE);
  if (delay !== undefined) settings.scheduledDelayMillis = delay;
  if (queue !== undefined) settings.maxQueueSize = queue;
  if (batch !== undefined) settings.maxExportBatchSize = batch;
  return settings;
}

function positive(value: string | undefined): number | undefined {
  const number = value === undefined || value.trim() === "" ? NaN : Number(value);
  return Number.isFinite(number) && number > 0 ? number : undefined;
}

/**
 * Installs the trace SDK when `env` asks for it, and says how to run and end
 * the command under it. The exporter reads the rest of its settings, the
 * endpoint and headers among them, from the process environment, as the
 * OpenTelemetry exporters do.
 *
 * The resource is `service.name`, `service.version`, `os.type`, Node's version
 * as `process.runtime.*`, and what `OTEL_RESOURCE_ATTRIBUTES` adds; the
 * environment cannot replace these, since the programs PLexus runs with share
 * it. The host and process detectors are not used: they would send the
 * hostname, the command line and the executable's path.
 *
 * When a collector elsewhere failed recently and its time to try again has
 * not come, a command installs nothing and loads no SDK module; a process
 * that serves installs the SDK all the same, so that the trace context and
 * the session still reach its images, and sends once that time has come.
 */
export async function startTelemetry(env: NodeJS.ProcessEnv, options: TelemetryOptions = {}): Promise<Telemetry> {
  const traces = tracesExport(env);
  const endpoint = tracesEndpoint(env);
  if (traces === undefined || endpoint === undefined) {
    return none;
  }
  const reachability = new Reachability(options.reachabilityFile ?? reachabilityFile(env), endpoint, options.now);
  if (!options.longLived && reachability.isOpen()) {
    return none;
  }
  const { exportTimeoutMs, deadlineMs, exitWaitMs } = exportTimings(traces, options.longLived);
  try {
    const [sdk, hooks, core, resources, exporters] = await Promise.all([
      import("@opentelemetry/sdk-trace"),
      import("@opentelemetry/context-async-hooks"),
      import("@opentelemetry/core"),
      import("@opentelemetry/resources"),
      traces.protocol === "http/json"
        ? import("@opentelemetry/exporter-trace-otlp-http")
        : import("@opentelemetry/exporter-trace-otlp-proto"),
    ]);
    const resource = resources
      .defaultResource()
      .merge(resources.detectResources({ detectors: [resources.envDetector] }))
      .merge(
        resources.resourceFromAttributes({
          "service.name": "plexus",
          "service.version": plexusVersion,
          "os.type": osType(),
          "process.runtime.name": "nodejs",
          "process.runtime.version": process.versions.node,
        }),
      );
    const provider = new sdk.TracerProvider({
      resource,
      spanProcessors: [
        new sdk.BatchSpanProcessor({
          ...traces.batch,
          exporter: new GuardedExporter(
            new exporters.OTLPTraceExporter({ timeoutMillis: exportTimeoutMs }),
            reachability,
            core.ExportResultCode,
            deadlineMs,
          ),
          exportTimeoutMillis: exportTimeoutMs,
        }),
      ],
    });
    context.setGlobalContextManager(new hooks.AsyncLocalStorageContextManager().enable());
    propagation.setGlobalPropagator(
      new core.CompositePropagator({
        propagators: [new core.W3CTraceContextPropagator(), new core.W3CBaggagePropagator()],
      }),
    );
    trace.setGlobalTracerProvider(provider);

    const parent = options.longLived ? ROOT_CONTEXT : parentFromEnvironment(env);
    return {
      within: (work) => context.with(parent, work),
      shutdown: () => within(exitWaitMs, provider.shutdown()),
    };
  } catch {
    return none;
  }
}

/** The parent a caller passes in `TRACEPARENT`, `TRACESTATE` and `BAGGAGE`, as the environment carrier has it. */
export function parentFromEnvironment(env: NodeJS.ProcessEnv) {
  const carrier: Record<string, string> = {};
  for (const [key, variable] of [
    ["traceparent", "TRACEPARENT"],
    ["tracestate", "TRACESTATE"],
    ["baggage", "BAGGAGE"],
  ] as const) {
    const value = env[variable];
    if (value !== undefined && value !== "") {
      carrier[key] = value;
    }
  }
  return propagation.extract(ROOT_CONTEXT, carrier);
}

/** The work's end, or the bound's, whichever comes first, failing never. */
async function within(boundMs: number, work: Promise<unknown>): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      work.catch(() => undefined),
      new Promise((resolve) => {
        timer = setTimeout(resolve, boundMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** The OS family, in OpenTelemetry's words. */
function osType(): string {
  const platform = os.platform();
  return platform === "win32" ? "windows" : platform === "sunos" ? "solaris" : platform;
}
