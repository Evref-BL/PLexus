import fs from "node:fs";
import { PlexusError } from "../errors.js";
import {
  exitedLaunchHint,
  launcherFailureMessage,
  launchLogPaths,
  type LauncherProcess,
} from "../launcher/pharoLauncherMcpClient.js";
import type { Display, Endpoint, StartOptions } from "../types.js";
import type { ImagesContext } from "./context.js";
import { observeEndpoint } from "./endpoint.js";
import { hostProcesses, killVms, vmsOn } from "./processes.js";
import { startScript } from "./scripts.js";
import {
  errorCode,
  existingImage,
  isPidAlive,
  readProperties,
  type ImageFiles,
} from "./store.js";

export const defaultStartTimeoutMs = 300_000;

export interface StartResult {
  name: string;
  pids: number[];
  endpoint: Endpoint;
  display: Display;
  seconds: number;
}

/**
 * Launch the image with the start script and wait until its MCP server
 * answers, or fail as soon as the VM reports a failure or exits. Nothing is
 * recorded: the next look at the host is what says it runs.
 */
export async function start(
  context: ImagesContext,
  name: string,
  options: StartOptions = {},
): Promise<StartResult> {
  const startedAt = context.now();
  const display = options.display ?? "headless";
  const timeoutMs = options.timeoutMs ?? defaultStartTimeoutMs;
  const files = existingImage(context, name);
  if (fs.existsSync(files.building)) {
    throw new PlexusError("building", `Image ${name} is still being created.`);
  }
  const running = vmsOn(files.imagePath, await hostProcesses(context));
  if (running.length > 0) {
    throw alreadyRunning(files, running);
  }

  const release = takeLaunchLock(context, files, timeoutMs);
  try {
    fs.rmSync(files.endpoint, { force: true });
    fs.rmSync(files.startStatus, { force: true });
    fs.writeFileSync(files.startScript, startScript, "utf8");

    const launch = await context.launcher().startImage({
      imageName: files.diskName,
      detached: true,
      displayMode: display,
      script: files.startScript,
      includeRaw: true,
    });
    if (!launch.ok) {
      throw new PlexusError("start-failed", launcherFailureMessage("startImage", launch));
    }
    const logs = launchLogPaths(launch);
    const endpoint = await waitForEndpoint(context, files, { timeoutMs, startedAt, launch, logs });
    return {
      name,
      pids: endpoint.pids,
      endpoint: endpoint.endpoint,
      display,
      seconds: Math.round((context.now() - startedAt) / 100) / 10,
    };
  } finally {
    release();
  }
}

function alreadyRunning(files: ImageFiles, vms: readonly LauncherProcess[]): PlexusError {
  const pids = vms.map((vm) => vm.pid);
  const observed = observeEndpoint(files, vms);
  return new PlexusError(
    "image-running",
    `Image ${files.name} is already running as pid ${pids.join(", ")}. Stop it first to start it again.`,
    { pids, ...("endpoint" in observed ? { endpoint: observed.endpoint } : {}) },
  );
}

async function waitForEndpoint(
  context: ImagesContext,
  files: ImageFiles,
  launch: { timeoutMs: number; startedAt: number; launch: unknown; logs: string[] },
): Promise<{ endpoint: Endpoint; pids: number[] }> {
  const logLine = launch.logs.length > 0 ? `\nLauncher logs: ${launch.logs.join(", ")}` : "";
  let sawVm = false;
  let pids: number[] = [];

  for (;;) {
    // The host first: a VM that wrote its failure and exited between the two
    // looks is then caught by the status, not reported as a silent exit.
    const vms = vmsOn(files.imagePath, await hostProcesses(context));
    pids = vms.map((vm) => vm.pid);
    const elapsed = context.now() - launch.startedAt;

    const status = readProperties(files.startStatus);
    if (status?.status === "failed") {
      await killVms(context, pids);
      throw new PlexusError(
        "start-failed",
        `Image ${files.name} failed to start: ${status.message || "it gave no message"}${logLine}`,
      );
    }

    if (vms.length > 0) {
      sawVm = true;
      const observed = observeEndpoint(files, vms);
      if ("endpoint" in observed && (await context.ping(observed.endpoint))) {
        return { endpoint: observed.endpoint, pids };
      }
    } else if (sawVm || elapsed >= context.vmAppearMs) {
      const hint = exitedLaunchHint(launch.launch, launch.logs);
      throw new PlexusError(
        "start-failed",
        `Image ${files.name} exited during start.${logLine}${hint ? `\n${hint}` : ""}`,
      );
    }

    if (elapsed >= launch.timeoutMs) {
      await killVms(context, pids);
      throw new PlexusError(
        "start-failed",
        `Image ${files.name} did not answer within ${Math.round(launch.timeoutMs / 1000)} s.${logLine}`,
      );
    }
    await context.sleep(context.pollMs);
  }
}

interface LaunchLock {
  pid: number;
  at: string;
}

/**
 * Two starts of one image would launch two VMs on one file. The lock is held
 * for one start, and one left by a process that died, or that has had longer
 * than any start, is taken over.
 */
function takeLaunchLock(
  context: ImagesContext,
  files: ImageFiles,
  timeoutMs: number,
): () => void {
  fs.mkdirSync(files.plexusDir, { recursive: true });
  const content = JSON.stringify({ pid: process.pid, at: new Date(context.now()).toISOString() });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.writeFileSync(files.launchLock, content, { flag: "wx" });
      return () => fs.rmSync(files.launchLock, { force: true });
    } catch (error) {
      if (errorCode(error) !== "EEXIST") {
        throw error;
      }
    }
    const holder = liveLaunchLock(context, files, timeoutMs);
    if (holder !== undefined) {
      throw beingStarted(files, holder);
    }
    fs.rmSync(files.launchLock, { force: true });
  }
  throw beingStarted(files, liveLaunchLock(context, files, timeoutMs));
}

/** The start that holds this image's launch lock, while it is still one. */
export function liveLaunchLock(
  context: ImagesContext,
  files: ImageFiles,
  timeoutMs = defaultStartTimeoutMs,
): LaunchLock | undefined {
  let lock: LaunchLock;
  try {
    lock = JSON.parse(fs.readFileSync(files.launchLock, "utf8")) as LaunchLock;
  } catch {
    return undefined;
  }
  const age = context.now() - Date.parse(lock.at);
  return Number.isInteger(lock.pid) && isPidAlive(lock.pid) && age < timeoutMs + 60_000
    ? lock
    : undefined;
}

export function beingStarted(files: ImageFiles, holder: LaunchLock | undefined): PlexusError {
  return new PlexusError(
    "being-started",
    `Image ${files.name} is being started${holder ? ` by process ${holder.pid}` : ""}.`,
    holder ? { pid: holder.pid } : undefined,
  );
}
