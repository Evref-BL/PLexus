/**
 * How PLexus reaches the launcher: pharo-launcher-mcp's functions, called in
 * this process on PLexus's one profile.
 */
import fs from "node:fs";
import {
  openPharoLauncher,
  type LauncherLaunchReport,
  type PharoLauncher,
} from "@evref-bl/pharo-launcher-mcp";
import { homeProfile } from "./pharoLauncherProfile.js";
import { vmRenewalHint } from "./vmRenewal.js";

export type {
  LauncherCommandResult,
  LauncherProcess,
} from "@evref-bl/pharo-launcher-mcp";

/** What PLexus asks of the launcher. Tests give a fake one. */
export type LauncherPort = Pick<
  PharoLauncher,
  | "createImage"
  | "startImage"
  | "deleteLaunchLogs"
  | "listProcesses"
  | "killProcess"
  | "listTemplateCategories"
  | "listTemplates"
  | "updateTemplates"
>;

// The launcher gives a command 30 s. Downloading a template, or a launch that
// waits while an image loads MCP and saves, takes minutes.
export const longCommandTimeoutMs = 60 * 60_000;

export function openLauncherPort(home: string, launcherDir?: string): LauncherPort {
  const installation = { profile: homeProfile(home), ...(launcherDir === undefined ? {} : { launcherDir }) };
  let quick: PharoLauncher | undefined;
  let long: PharoLauncher | undefined;
  const quickLauncher = (): PharoLauncher => (quick ??= openPharoLauncher(installation));
  const longLauncher = (): PharoLauncher =>
    (long ??= openPharoLauncher({ ...installation, timeoutMs: longCommandTimeoutMs }));

  return {
    createImage: (input) => longLauncher().createImage(input),
    startImage: (input) =>
      (input.detached ? quickLauncher() : longLauncher()).startImage(input),
    deleteLaunchLogs: (input) => quickLauncher().deleteLaunchLogs(input),
    listProcesses: () => quickLauncher().listProcesses(),
    killProcess: (input) => quickLauncher().killProcess(input),
    listTemplateCategories: () => quickLauncher().listTemplateCategories(),
    listTemplates: (input) => quickLauncher().listTemplates(input),
    updateTemplates: () => quickLauncher().updateTemplates(),
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

/** The launcher's report of what a start ran: which VM, its pid, its logs, its output. */
export function launchOf(result: unknown): LauncherLaunchReport | undefined {
  return isRecord(result) && isRecord(result.launch)
    ? (result.launch as LauncherLaunchReport)
    : undefined;
}

// A launch that waited for its VM reports what the VM wrote.
function waitedLaunchRenewalHint(payload: unknown): string | undefined {
  const launch = launchOf(payload);
  return launch?.by === "vm" && launch.output
    ? vmRenewalHint(`${launch.output.stdout}\n${launch.output.stderr}`, launch)
    : undefined;
}

/** The VM a detached launch started. */
export function launchedPid(result: unknown): number | undefined {
  const launch = launchOf(result);
  return launch?.by === "vm" ? launch.pid : undefined;
}

/**
 * The end of what a waited launch's VM wrote, where it says why it stopped:
 * its errors first, then its output, each trimmed like a diagnostic.
 */
export function launchOutputTail(result: unknown): string[] {
  const launch = launchOf(result);
  if (launch?.by !== "vm" || !launch.output) {
    return [];
  }
  const streams: Array<[string, string]> = [
    ["Its error output ends with:", launch.output.stderr],
    ["Its output ends with:", launch.output.stdout],
  ];
  return streams.flatMap(([label, text]) => {
    const trimmed = text.trim();
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
  const logs = launchOf(result)?.logs;
  return logs ? [...new Set([logs.stdout, logs.stderr])] : [];
}

/**
 * What a detached launch's logs say about a VM that stopped: the renewal hint
 * when it stopped with its own fatal-error report, or nothing.
 */
export function exitedLaunchHint(result: unknown, logPaths: readonly string[]): string | undefined {
  const launch = launchOf(result);
  return launch ? vmRenewalHint(logPaths.map(logTail).join("\n"), launch) : undefined;
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
