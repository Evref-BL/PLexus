/**
 * How PLexus reaches the launcher: pharo-launcher-mcp's functions, called in
 * this process on PLexus's one profile.
 */
import fs from "node:fs";
import {
  openPharoLauncher,
  type PharoLauncher,
} from "@evref-bl/pharo-launcher-mcp/launcher";
import { homeProfileEnvironment } from "./pharoLauncherProfile.js";
import { vmRenewalHint } from "./vmRenewal.js";

export type {
  LauncherCommandResult,
  LauncherProcess,
} from "@evref-bl/pharo-launcher-mcp/launcher";

/** What PLexus asks of the launcher. Tests give a fake one. */
export type LauncherPort = Pick<
  PharoLauncher,
  | "createImage"
  | "startImage"
  | "listProcesses"
  | "killProcess"
  | "listTemplateCategories"
  | "listTemplates"
  | "updateTemplates"
>;

// The launcher gives a command 30 s. Downloading a template, or a launch that
// waits while an image loads MCP and saves, takes minutes.
export const longCommandTimeoutMs = 60 * 60_000;

export function openLauncherPort(home: string): LauncherPort {
  const env = homeProfileEnvironment(home);
  let quick: PharoLauncher | undefined;
  let long: PharoLauncher | undefined;
  const quickLauncher = (): PharoLauncher => (quick ??= openPharoLauncher({ env }));
  const longLauncher = (): PharoLauncher =>
    (long ??= openPharoLauncher({ env, timeoutMs: longCommandTimeoutMs }));

  return {
    createImage: (input) => longLauncher().createImage(input),
    startImage: (input) =>
      (input.detached ? quickLauncher() : longLauncher()).startImage(input),
    listProcesses: (input) => quickLauncher().listProcesses(input),
    killProcess: (input) => quickLauncher().killProcess(input),
    listTemplateCategories: (input) => quickLauncher().listTemplateCategories(input),
    listTemplates: (input) => quickLauncher().listTemplates(input),
    updateTemplates: (input) => quickLauncher().updateTemplates(input),
  };
}

const failureDetailLength = 500;

function detailField(payload: unknown, key: string): string | undefined {
  if (!isRecord(payload)) {
    return undefined;
  }
  const value = payload[key];
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }
  const detail = value.trim();
  return detail.length > failureDetailLength
    ? `${detail.slice(0, failureDetailLength)}…`
    : detail;
}

/**
 * What the launcher said went wrong, trimmed: a diagnostic built from
 * launcher output can run to pages. A launch whose VM stopped with its own
 * fatal-error report also says how to renew that VM.
 */
export function launcherFailureMessage(
  operation: keyof LauncherPort,
  payload: unknown,
): string {
  const detail =
    detailField(payload, "message") ??
    [detailField(payload, "diagnostic"), detailField(payload, "action")]
      .filter(Boolean)
      .join(" ");
  const message = detail
    ? `Pharo Launcher ${operation} failed: ${detail}`
    : `Pharo Launcher ${operation} failed`;
  const renewal =
    operation === "startImage" ? waitedLaunchRenewalHint(payload) : undefined;
  return renewal ? `${message}\n${renewal}` : message;
}

// A launch that waited for its VM has the VM's output in the raw result,
// after the launcher's own report of which VM it ran.
function waitedLaunchRenewalHint(payload: unknown): string | undefined {
  if (!isRecord(payload) || !isRecord(payload.raw)) {
    return undefined;
  }
  const { stdout, stderr } = payload.raw;
  const report = typeof stdout === "string" ? stdout : "";
  return vmRenewalHint(`${report}\n${typeof stderr === "string" ? stderr : ""}`, report);
}

/** The launcher's report of a launch: which VM, which pid, which logs. */
export function launchReport(result: unknown): string {
  if (!isRecord(result)) {
    return "";
  }
  if (isRecord(result.raw) && typeof result.raw.stdout === "string") {
    return result.raw.stdout;
  }
  return isRecord(result.data) && typeof result.data.message === "string"
    ? result.data.message
    : "";
}

/** The VM a detached launch started, as the launcher reports its pid. */
export function launchedPid(result: unknown): number | undefined {
  const pid = /^Detached profile-scoped Pharo image pid (\d+)\./m.exec(launchReport(result))?.[1];
  return pid === undefined ? undefined : Number(pid);
}

/**
 * The end of what a waited launch's VM wrote, where it says why it stopped:
 * its errors first, then its output, each trimmed like a diagnostic.
 */
export function launchOutputTail(result: unknown): string[] {
  if (!isRecord(result) || !isRecord(result.raw)) {
    return [];
  }
  const streams: Array<[string, unknown]> = [
    ["Its error output ends with:", result.raw.stderr],
    ["Its output ends with:", result.raw.stdout],
  ];
  return streams.flatMap(([label, text]) => {
    const trimmed = typeof text === "string" ? text.trim() : "";
    if (!trimmed) {
      return [];
    }
    const tail = trimmed.length > failureDetailLength
      ? `…${trimmed.slice(-failureDetailLength)}`
      : trimmed;
    return [`${label}\n${tail}`];
  });
}

/** The log files a detached launch writes the VM's output to. */
export function launchLogPaths(result: unknown): string[] {
  const paths = launchReport(result)
    .split(/\r?\n/)
    .map((line) => /^(?:stdout|stderr):\s*(\S.*)$/.exec(line.trim())?.[1])
    .filter((value): value is string => value !== undefined);
  return [...new Set(paths)];
}

/**
 * What a detached launch's logs say about a VM that stopped: the renewal hint
 * when it stopped with its own fatal-error report, or nothing.
 */
export function exitedLaunchHint(result: unknown, logPaths: readonly string[]): string | undefined {
  const report = launchReport(result);
  return report ? vmRenewalHint(logPaths.map(logTail).join("\n"), report) : undefined;
}

// The end of a log, where a VM that stopped wrote why. A log that is gone says
// nothing.
function logTail(logPath: string): string {
  const tailLength = 64 * 1024;
  try {
    const size = fs.statSync(logPath).size;
    const descriptor = fs.openSync(logPath, "r");
    try {
      const length = Math.min(size, tailLength);
      const buffer = Buffer.alloc(length);
      fs.readSync(descriptor, buffer, 0, length, size - length);
      return buffer.toString("utf8");
    } finally {
      fs.closeSync(descriptor);
    }
  } catch {
    return "";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
