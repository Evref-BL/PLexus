/**
 * The `plexus` command is an application, so it may install an OpenTelemetry
 * SDK, which the library never does. It installs one only when the standard
 * `OTEL_*` environment asks for an OTLP traces exporter, loading the SDK then
 * and not before; with nothing configured, nothing is loaded or sent.
 *
 * Nothing here reaches a command's answer or its exit status: an SDK that is
 * missing, fails to load, or fails to export leaves the command as it was.
 */
import os from "node:os";
import { context, propagation, ROOT_CONTEXT, trace } from "@opentelemetry/api";
import { plexusVersion } from "../version.js";

/** The SDK the command installed, or none: what to run the command in, and how to end it. */
export interface Telemetry {
  /** Runs the command's work under the parent `TRACEPARENT` names, when it names one. */
  within<T>(work: () => T): T;
  /** Exports what is left, waiting no longer than the export timeout. */
  shutdown(): Promise<void>;
}

const none: Telemetry = {
  within: (work) => work(),
  shutdown: async () => undefined,
};

/** The export timeout unless `OTEL_EXPORTER_OTLP_TIMEOUT` says otherwise: a command never waits long on telemetry. */
const defaultTimeoutMs = 2_000;

export interface TracesExport {
  protocol: "http/protobuf" | "http/json";
  timeoutMs: number;
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
  return { protocol, timeoutMs };
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
 * The resource is `service.name`, `service.version`, `os.type` and what
 * `OTEL_RESOURCE_ATTRIBUTES` and `OTEL_SERVICE_NAME` add. The host and process
 * detectors are not used: they would send the hostname, the command line and
 * the executable's path.
 */
export async function startTelemetry(env: NodeJS.ProcessEnv): Promise<Telemetry> {
  const traces = tracesExport(env);
  if (traces === undefined) {
    return none;
  }
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
      .merge(
        resources.resourceFromAttributes({
          "service.name": "plexus",
          "service.version": plexusVersion,
          "os.type": osType(),
        }),
      )
      .merge(
        resources.detectResources({
          detectors: [resources.envDetector],
        }),
      );
    const provider = new sdk.TracerProvider({
      resource,
      spanProcessors: [
        new sdk.BatchSpanProcessor({
          exporter: new exporters.OTLPTraceExporter({ timeoutMillis: traces.timeoutMs }),
          exportTimeoutMillis: traces.timeoutMs,
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

    const parent = parentFromEnvironment(env);
    return {
      within: (work) => context.with(parent, work),
      shutdown: () => within(traces.timeoutMs, provider.shutdown()),
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
