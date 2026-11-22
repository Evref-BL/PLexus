/**
 * What the `plexus` command remembers of a collector it could not reach, so
 * that an unreachable collector costs a command nothing: while an endpoint's
 * time to try again is in the future, no SDK is installed for it, and a
 * process that already failed to reach it sends nothing more until then.
 *
 * The state is a JSON object in the user's cache directory, keyed by the
 * traces endpoint, whose values are `{ "failures": n, "retryAt": epochMillis }`.
 * Reading it and writing it never fail: a missing, unreadable or malformed
 * file is no state, and a write that fails is skipped.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExportResult } from "@opentelemetry/core";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace";

/** An endpoint's failures in a row, and when to try it again. */
export interface Unreachable {
  failures: number;
  retryAt: number;
}

export type ReachabilityState = Record<string, Unreachable>;

const firstDelayMs = 5 * 60_000;
const longestDelayMs = 6 * 60 * 60_000;

/** How long to leave an endpoint alone after its `failures`-th failure in a row: five minutes, doubling, at most six hours. */
export function retryDelayMs(failures: number): number {
  return Math.min(firstDelayMs * 2 ** Math.max(failures - 1, 0), longestDelayMs);
}

/**
 * Where the state lives: `$XDG_CACHE_HOME/plexus`, else `~/.cache/plexus`, or
 * `%LOCALAPPDATA%\plexus` on Windows.
 */
export function reachabilityFile(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
  home: string = os.homedir(),
): string {
  const paths = platform === "win32" ? path.win32 : path.posix;
  const directory =
    env.XDG_CACHE_HOME?.trim() ||
    (platform === "win32"
      ? env.LOCALAPPDATA?.trim() || paths.join(home, "AppData", "Local")
      : paths.join(home, ".cache"));
  return paths.join(directory, "plexus", "otel-reachability.json");
}

/**
 * The traces endpoint the OTLP exporter sends to, as it resolves it:
 * `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` as it is, else
 * `OTEL_EXPORTER_OTLP_ENDPOINT` with `v1/traces` appended.
 */
export function tracesEndpoint(env: NodeJS.ProcessEnv): string | undefined {
  const specific = env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim();
  if (specific) {
    return specific;
  }
  const general = env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  if (!general) {
    return undefined;
  }
  return `${general.endsWith("/") ? general : `${general}/`}v1/traces`;
}

/** The state in `file`, or none when it is missing, unreadable or not a JSON object. */
export function readReachability(file: string): ReachabilityState {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const state: ReachabilityState = {};
    for (const [endpoint, value] of Object.entries(parsed)) {
      const entry = unreachable(value);
      if (entry !== undefined) {
        state[endpoint] = entry;
      }
    }
    return state;
  } catch {
    return {};
  }
}

function unreachable(value: unknown): Unreachable | undefined {
  if (value === null || typeof value !== "object") {
    return undefined;
  }
  const { failures, retryAt } = value as Record<string, unknown>;
  return typeof failures === "number" && Number.isFinite(failures) && failures >= 0 &&
    typeof retryAt === "number" && Number.isFinite(retryAt)
    ? { failures, retryAt }
    : undefined;
}

/** Writes `state` to `file` through a temporary file renamed over it, so no reader sees half of it; does nothing when that fails. */
export function writeReachability(file: string, state: ReachabilityState): void {
  const temporary = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(temporary, JSON.stringify(state));
    fs.renameSync(temporary, file);
  } catch {
    try {
      fs.rmSync(temporary, { force: true });
    } catch {
      // Nothing to clean, or nothing that can be.
    }
  }
}

/** One endpoint's breaker: whether to send to it, and what each export says of it. */
export class Reachability {
  private retryAt: number | undefined;

  constructor(
    private readonly file: string,
    private readonly endpoint: string,
    private readonly now: () => number = Date.now,
  ) {}

  /** Whether the state says to leave the endpoint alone for now. */
  isOpen(): boolean {
    const entry = readReachability(this.file)[this.endpoint];
    return entry !== undefined && entry.retryAt > this.now();
  }

  /** Whether this process may send now: not before the time to try again its last failure set. */
  allows(): boolean {
    return this.retryAt === undefined || this.now() >= this.retryAt;
  }

  failed(): void {
    const state = readReachability(this.file);
    const failures = (state[this.endpoint]?.failures ?? 0) + 1;
    const retryAt = this.now() + retryDelayMs(failures);
    this.retryAt = retryAt;
    writeReachability(this.file, { ...state, [this.endpoint]: { failures, retryAt } });
  }

  succeeded(): void {
    this.retryAt = undefined;
    const state = readReachability(this.file);
    if (this.endpoint in state) {
      delete state[this.endpoint];
      writeReachability(this.file, state);
    }
  }
}

/** The export result codes, from the SDK the exporter came with. */
export interface ResultCodes {
  SUCCESS: ExportResult["code"];
  FAILED: ExportResult["code"];
}

/**
 * An exporter that tells `reachability` how each export went, and fails an
 * export at once, without the network, while `reachability` does not allow
 * sending. An export that has not ended `deadlineMs` after it began has
 * failed: the OTLP exporter's own timeout does not cover a connection that
 * is still being made, nor an answer that trickles in.
 */
export class GuardedExporter implements SpanExporter {
  constructor(
    private readonly exporter: SpanExporter,
    private readonly reachability: Reachability,
    private readonly codes: ResultCodes,
    private readonly deadlineMs?: number,
  ) {}

  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    if (!this.reachability.allows()) {
      resultCallback({ code: this.codes.FAILED });
      return;
    }
    let settled = false;
    let deadline: NodeJS.Timeout | undefined;
    const settle = (result: ExportResult) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(deadline);
      if (result.code === this.codes.SUCCESS) {
        this.reachability.succeeded();
      } else {
        this.reachability.failed();
      }
      resultCallback(result);
    };
    const failure = (error: unknown) =>
      settle({ code: this.codes.FAILED, error: error instanceof Error ? error : new Error(String(error)) });
    if (this.deadlineMs !== undefined) {
      deadline = setTimeout(() => failure(new Error(`no answer within ${this.deadlineMs} ms`)), this.deadlineMs);
      deadline.unref();
    }
    try {
      const returned: unknown = (this.exporter.export as (...args: unknown[]) => unknown)(spans, settle);
      if (returned instanceof Promise) {
        returned.catch(failure);
      }
    } catch (error) {
      failure(error);
    }
  }

  shutdown(): Promise<void> {
    return this.exporter.shutdown();
  }

  forceFlush(): Promise<void> {
    return this.exporter.forceFlush?.() ?? Promise.resolve();
  }
}
