import fs from "node:fs";
import * as texts from "../answers/texts.js";
import { PlexusError } from "../errors.js";
import {
  exitedLaunchHint,
  launchedPid,
  launcherFailureMessage,
  launchLogPaths,
  type LauncherProcess,
} from "../launcher/pharoLauncherMcpClient.js";
import type { Endpoint, ImageTelemetry, StartOptions, StartResult } from "../types.js";
import { buildingState, readClaim, takeClaim, type ClaimHolder, type ClaimState } from "./claims.js";
import type { ImagesContext } from "./context.js";
import { stillBuilding } from "./create.js";
import { observeEndpoint } from "./endpoint.js";
import { imageTelemetry } from "./list.js";
import { displayOf, hostProcesses, killFailureLines, killVms, vmsOn } from "./processes.js";
import { startScript } from "./scripts.js";
import {
  errorCode,
  existingImage,
  isPidAlive,
  noSuchImage,
  readProperties,
  telemetryOf,
  type ImageFiles,
} from "./store.js";

export const defaultStartTimeoutMs = 300_000;

export type { StartResult } from "../types.js";

/**
 * Launch the image with the start script and wait until its MCP server
 * answers, or fail as soon as the VM reports a failure or exits. An image
 * whose server already answers is what a start is for, and is answered as
 * it is (`alreadyRunning`); one a VM runs that does not answer is refused.
 * Nothing is recorded: the next look at the host is what says it runs, and
 * whether it records its calls.
 */
export async function start(
  context: ImagesContext,
  name: string,
  options: StartOptions = {},
): Promise<StartResult> {
  const startedAt = context.now();
  const display = options.display ?? "headless";
  const timeoutMs = options.timeoutMs ?? defaultStartTimeoutMs;
  if (display !== "headless" && display !== "interactive") {
    throw new PlexusError("invalid-arguments", `display is headless or interactive, not ${String(display)}.`);
  }
  if (!(Number.isFinite(timeoutMs) && timeoutMs > 0)) {
    throw new PlexusError("invalid-arguments", `timeoutMs is a positive number of milliseconds, not ${String(timeoutMs)}.`);
  }
  const files = existingImage(context, name);
  const building = buildingState(context, files);
  if (building.state === "held") {
    throw stillBuilding(files, building.holder);
  }
  if (building.state === "stale") {
    throw new PlexusError("building", texts.neverFinished(name));
  }

  const release = await takeLaunchLock(context, files, timeoutMs, startedAt);
  try {
    // Under the lock: a start that looked before another released it would
    // find no VM yet, and launch a second one on the same file.
    const running = vmsOn(files.imagePath, await hostProcesses(context));
    if (running.length > 0) {
      const observed = observeEndpoint(files, running);
      if (!("endpoint" in observed)) {
        throw notAnswering(files, running, observed);
      }
      const telemetry = imageTelemetry(observed, telemetryOf(readProperties(files.created)));
      return {
        name,
        pids: running.map((vm) => vm.pid),
        endpoint: observed.endpoint,
        display: displayOf(running[0]),
        seconds: Math.round((context.now() - startedAt) / 100) / 10,
        ...(telemetry === undefined ? {} : { telemetry }),
        alreadyRunning: true,
      };
    }

    fs.rmSync(files.endpoint, { force: true });
    fs.rmSync(files.startStatus, { force: true });
    fs.writeFileSync(files.startScript, startScript({ telemetry: context.telemetry }), "utf8");

    const launch = await context.launcher().startImage({
      image: files.diskName,
      detached: true,
      displayMode: display,
      script: files.startScript,
    });
    if (!launch.ok) {
      throw new PlexusError("start-failed", launcherFailureMessage("startImage", launch));
    }
    // The VM the launcher started, which the process list may not show on
    // this image (a path it cannot read back), and which a failed start must
    // not leave running unseen.
    const launched = launchedPid(launch);
    const killOnFailure = (pids: readonly number[]) =>
      killVms(context, [
        ...new Set([
          ...pids,
          ...(launched !== undefined && isPidAlive(launched) ? [launched] : []),
        ]),
      ]);

    let outcome: WaitOutcome;
    try {
      outcome = await waitForEndpoint(context, files, {
        timeoutMs,
        startedAt,
        launch,
        logs: launchLogPaths(launch),
      });
    } catch (error) {
      await killOnFailure([]);
      throw error;
    }
    if ("failure" in outcome) {
      const failures = await killOnFailure(outcome.pids);
      throw new PlexusError(
        "start-failed",
        [outcome.failure, ...killFailureLines(failures)].join("\n"),
      );
    }
    const telemetry = imageTelemetry(outcome, telemetryOf(readProperties(files.created)));
    return {
      name,
      pids: outcome.pids,
      endpoint: outcome.endpoint,
      display,
      seconds: Math.round((context.now() - startedAt) / 100) / 10,
      ...(telemetry === undefined ? {} : { telemetry }),
    };
  } finally {
    release();
  }
}

/** A VM runs the image and takes no calls yet, or never will through PLexus. */
function notAnswering(
  files: ImageFiles,
  vms: readonly LauncherProcess[],
  observed: { starting: true } | { problem: string },
): PlexusError {
  const pids = vms.map((vm) => vm.pid);
  const message =
    "starting" in observed ? texts.starting(files.name, pids) : texts.takesNoCalls(files.name, pids, observed.problem);
  return new PlexusError("starting" in observed ? "starting" : "no-endpoint", message, { pids });
}

/** The endpoint that answered and what its start said of telemetry, or why the start failed and which VMs ran then. */
type WaitOutcome =
  | { endpoint: Endpoint; telemetry?: ImageTelemetry; pids: number[] }
  | { failure: string; pids: number[] };

async function waitForEndpoint(
  context: ImagesContext,
  files: ImageFiles,
  launch: { timeoutMs: number; startedAt: number; launch: unknown; logs: string[] },
): Promise<WaitOutcome> {
  const logLine = launch.logs.length > 0 ? `\nLauncher logs: ${launch.logs.join(", ")}` : "";
  let sawVm = false;

  for (;;) {
    // The host first: a VM that wrote its failure and exited between the two
    // looks is then caught by the status, not reported as a silent exit.
    const vms = vmsOn(files.imagePath, await hostProcesses(context));
    const pids = vms.map((vm) => vm.pid);
    const elapsed = context.now() - launch.startedAt;

    const status = readProperties(files.startStatus);
    if (status?.status === "failed") {
      return {
        failure: `Image ${files.name} failed to start: ${status.message || "it gave no message"}${logLine}`,
        pids,
      };
    }

    if (vms.length > 0) {
      sawVm = true;
      const observed = observeEndpoint(files, vms);
      if ("endpoint" in observed && (await context.ping(observed.endpoint))) {
        return { ...observed, pids };
      }
    } else if (sawVm || elapsed >= context.vmAppearMs) {
      const hint = exitedLaunchHint(launch.launch, launch.logs);
      return {
        failure: `Image ${files.name} exited during start.${logLine}${hint ? `\n${hint}` : ""}`,
        pids,
      };
    }

    if (elapsed >= launch.timeoutMs) {
      return {
        failure: `Image ${files.name} did not answer within ${Math.round(launch.timeoutMs / 1000)} s.${logLine}`,
        pids,
      };
    }
    await context.sleep(context.pollMs);
  }
}

/** How long a launch lock holds: longer than any start it was taken for. */
function launchLockMs(timeoutMs: number): number {
  return timeoutMs + 60_000;
}

/**
 * Two starts of one image would launch two VMs on one file, so a start holds
 * the image's launch lock while it launches. A start another holds is waited
 * for, within this start's time: what it leaves running is then this one's
 * answer.
 */
async function takeLaunchLock(
  context: ImagesContext,
  files: ImageFiles,
  timeoutMs: number,
  startedAt: number,
): Promise<() => void> {
  try {
    // Not recursive: a delete that took the image away since it was found
    // must not get its directory back, empty, from a start.
    fs.mkdirSync(files.plexusDir);
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      throw noSuchImage(files);
    }
    if (errorCode(error) !== "EEXIST") {
      throw error;
    }
  }
  for (;;) {
    let taken: ReturnType<typeof takeClaim>;
    try {
      taken = takeClaim(context, files.launchLock, launchLockMs(timeoutMs));
    } catch (error) {
      throw errorCode(error) === "ENOENT" ? noSuchImage(files) : error;
    }
    if ("release" in taken) {
      return taken.release;
    }
    if (context.now() - startedAt >= timeoutMs) {
      throw beingStarted(files, taken.heldBy, true);
    }
    await context.sleep(context.pollMs);
  }
}

/** Whether a start holds this image's launch lock now. */
export function launchLockState(context: ImagesContext, files: ImageFiles): ClaimState {
  return readClaim(context, files.launchLock, launchLockMs(defaultStartTimeoutMs));
}

export function beingStarted(files: ImageFiles, holder: ClaimHolder | undefined, outwaited = false): PlexusError {
  return new PlexusError(
    "being-started",
    (outwaited ? texts.startOutwaited : texts.beingStarted)(files.name, holder?.pid),
    holder ? { pid: holder.pid } : undefined,
  );
}
