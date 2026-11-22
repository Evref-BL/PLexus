import fs from "node:fs";
import * as texts from "../answers/texts.js";
import { PlexusError } from "../errors.js";
import { evaluationTool } from "../forward/index.js";
import type { ForwardError } from "../forward/jsonRpc.js";
import type { LauncherProcess } from "../launcher/pharoLauncherMcpClient.js";
import type { Endpoint, ImageToolResult, StopOptions } from "../types.js";
import type { ImagesContext } from "./context.js";
import { endpointOf } from "./endpoint.js";
import { describe } from "./list.js";
import { hostProcesses, killFailureLines, killVms, vmsOn } from "./processes.js";
import { exists, imageFiles, noSuchImage, type ImageFiles } from "./store.js";

export interface StopResult {
  name: string;
  /** The VMs killed: those left after the image quit or saved, or every one that ran it when it did neither. */
  killed: number[];
  /** The image quit without saving when asked. */
  quit?: true;
  /** The image saved itself and quit. */
  saved?: true;
}

/** What an image evaluates to save itself and quit. */
const saveAndQuitCode = "Smalltalk snapshot: true andQuit: true";

/**
 * What an image evaluates to quit without saving. Quitting runs what the
 * image does before it goes, such as sending the telemetry it still holds,
 * which a kill skips.
 */
const quitCode = "Smalltalk snapshot: false andQuit: true";

/**
 * How long a stop that does not save waits for the image to take the quit.
 * An image too busy to answer in that time is killed: a stop is often what
 * ends one that hangs.
 */
const quitAskMs = 2_000;

/**
 * Stop the image without saving: it is asked to quit through its MCP server,
 * and every VM still running it after `quitWaitMs` is killed, as is one that
 * takes no calls. Asked to save, have the image save itself and quit through
 * its MCP server, and wait until its VM is gone and its image file was
 * written; an image that does not save and quit in time is left running. Not
 * running is not an error.
 */
export async function stop(
  context: ImagesContext,
  name: string,
  options: StopOptions = {},
): Promise<StopResult> {
  const files = imageFiles(context, name);
  if (!exists(files.dir)) {
    throw noSuchImage(files);
  }
  const processes = await hostProcesses(context);
  const pids = vmsOn(files.imagePath, processes).map((vm) => vm.pid);
  if (pids.length === 0) {
    return { name, killed: [] };
  }
  if (options.save) {
    return saveAndStop(context, files, processes);
  }

  const quitters = await askToQuit(context, files, processes);
  const left = quitters === undefined ? pids : await vmsLeftAfterQuit(context, files, quitters);
  if (left.length > 0) {
    await killAndWait(context, files, left);
  }
  fs.rmSync(files.endpoint, { force: true });
  return { name, killed: left, ...(quitters !== undefined && left.length < pids.length ? { quit: true as const } : {}) };
}

/**
 * Has the image evaluate `quitCode`, and answers the VMs that took it, or
 * nothing when the image was not asked or did not take it. The connection
 * closing, an answer that is not an error, or no answer in time may each come
 * from a VM that is quitting; a call the image never got, or an error it
 * answered, did not quit it. Only an image that runs and wrote its endpoint is
 * asked.
 */
async function askToQuit(
  context: ImagesContext,
  files: ImageFiles,
  processes: readonly LauncherProcess[],
): Promise<number[] | undefined> {
  const row = describe(files, processes);
  if (row.state !== "running" || row.endpoint === undefined) {
    return undefined;
  }
  const endpoint = row.endpoint;
  try {
    const answer = await context.callTool(endpoint, "evaluate", { code: quitCode }, { minimumMs: quitAskMs });
    if (answer.isError === true) {
      return undefined;
    }
  } catch (error) {
    const kind = (error as Partial<ForwardError>).kind;
    if (kind !== "closed" && kind !== "timeout") {
      return undefined;
    }
  }
  return endpoint.pid === undefined ? row.pids : [endpoint.pid];
}

/**
 * Waits up to `quitWaitMs` for the VMs that took the quit to go, and answers
 * the VMs that still run the image then: those beside them, and those that
 * took it but did not go.
 */
async function vmsLeftAfterQuit(
  context: ImagesContext,
  files: ImageFiles,
  quitters: readonly number[],
): Promise<number[]> {
  const startedAt = context.now();
  for (;;) {
    const running = vmsOn(files.imagePath, await hostProcesses(context)).map((vm) => vm.pid);
    if (!running.some((pid) => quitters.includes(pid)) || context.now() - startedAt >= context.quitWaitMs) {
      return running;
    }
    await context.sleep(context.pollMs);
  }
}

async function killAndWait(context: ImagesContext, files: ImageFiles, pids: readonly number[]): Promise<void> {
  // A VM the launcher would not kill is still there, and waiting for it to
  // go would only hide why.
  const failures = await killVms(context, pids);
  if (failures.length > 0) {
    const survivors = failures.map((failure) => failure.pid);
    throw new PlexusError(
      "stop-failed",
      [`Image ${files.name} still runs as pid ${survivors.join(", ")}.`, ...killFailureLines(failures)].join("\n"),
      { pids: survivors },
    );
  }

  const startedAt = context.now();
  for (;;) {
    const survivors = vmsOn(files.imagePath, await hostProcesses(context))
      .map((vm) => vm.pid)
      .filter((pid) => pids.includes(pid));
    if (survivors.length === 0) {
      return;
    }
    if (context.now() - startedAt >= context.stopWaitMs) {
      throw new PlexusError(
        "stop-failed",
        `Image ${files.name} still runs as pid ${survivors.join(", ")} after being killed.`,
        { pids: survivors },
      );
    }
    await context.sleep(context.pollMs);
  }
}

/**
 * The save is the image's own: it evaluates `saveAndQuitCode` with the tool
 * it lists for evaluating. Its VM quits in the middle of the call, so the
 * connection closing is what a save looks like, and the wait for the VM to
 * exit starts there. Whether it saved is read from the image file, whose
 * modification time moves. A VM beside the one that saved, which a stop
 * would kill, is killed once it has.
 */
async function saveAndStop(
  context: ImagesContext,
  files: ImageFiles,
  processes: readonly LauncherProcess[],
): Promise<StopResult> {
  const name = files.name;
  const row = describe(files, processes);
  if (row.state === "unreachable") {
    throw new PlexusError(
      "save-failed",
      texts.saveTakesNoCalls(name, row.pids, row.endpointProblem ?? "it wrote no endpoint"),
      { pids: row.pids },
    );
  }
  // An image still being created or starting is refused as a call to it is.
  const endpoint = endpointOf(row);
  const savers = endpoint.pid === undefined ? row.pids : [endpoint.pid];
  const before = modifiedAt(files.imagePath);
  const asked = await askToSave(context, endpoint);
  const startedAt = context.now();

  // Whatever came of the call, a VM that has gone has stopped, so the host
  // is looked at before an image is said to run.
  let left: number[];
  for (;;) {
    const running = vmsOn(files.imagePath, await hostProcesses(context)).map((vm) => vm.pid);
    if (!running.some((pid) => savers.includes(pid))) {
      left = running;
      break;
    }
    if ("notTaken" in asked) {
      throw new PlexusError("save-failed", texts.notSaved(name, asked.notTaken), { pids: running });
    }
    if (context.now() - startedAt >= asked.exitWaitMs) {
      throw new PlexusError(
        "save-failed",
        texts.saveTimedOut(name, Math.round(context.saveWaitMs / 1000), modifiedAt(files.imagePath) !== before),
        { pids: running },
      );
    }
    await context.sleep(context.pollMs);
  }

  if (left.length > 0) {
    await killAndWait(context, files, left);
  }
  fs.rmSync(files.endpoint, { force: true });
  if (modifiedAt(files.imagePath) === before) {
    throw new PlexusError("stopped-unsaved", texts.stoppedUnsaved(name));
  }
  return { name, killed: left, saved: true };
}

/**
 * Has the image evaluate `saveAndQuitCode`, and says what came of it: how
 * long its VM may take to exit, or why it did not take the save. Only the
 * connection closing, or an answer that is not an error, can come from a VM
 * that is quitting, and it gets the whole wait. A call left unanswered for
 * the whole wait gets no more. Anything else is the image not taking the
 * save.
 */
async function askToSave(
  context: ImagesContext,
  endpoint: Endpoint,
): Promise<{ exitWaitMs: number } | { notTaken: string }> {
  let tool: string | undefined;
  try {
    tool = evaluationTool(await context.listTools(endpoint));
  } catch (error) {
    return { notTaken: notTakenReason(error) };
  }
  if (tool === undefined) {
    return { notTaken: "it lists no evaluate tool, so it cannot save" };
  }
  try {
    const answer = await context.callTool(endpoint, tool, { code: saveAndQuitCode }, { minimumMs: context.saveWaitMs });
    if (answer.isError === true) {
      const line = firstLine(answer);
      return { notTaken: line === undefined ? `${tool} answered an error with no text` : `${tool} answered "${line}"` };
    }
  } catch (error) {
    const kind = (error as Partial<ForwardError>).kind;
    if (kind === "timeout") {
      return { exitWaitMs: 0 };
    }
    if (kind !== "closed") {
      return { notTaken: notTakenReason(error) };
    }
  }
  return { exitWaitMs: context.saveWaitMs };
}

/**
 * Why the image did not take a call it was sent, or never got, in the words
 * of the answers rather than the socket's or the parser's.
 */
function notTakenReason(error: unknown): string {
  const failure = error as Partial<ForwardError> & { message?: unknown; waitedMs?: number };
  switch (failure.kind) {
    case "no-handshake":
    case "timeout":
      return `it did not answer within ${Math.round((failure.waitedMs ?? 0) / 1000)} s`;
    case "refused":
      return "it refused the connection";
    case "closed":
      return "it closed the connection";
    case "answered":
      return `it answered ${String(failure.message).replace(/\.$/, "")}`;
    default:
      return "it gave no answer an MCP client can read";
  }
}

/** The first line of a tool's text answer, or nothing for an answer with no text. */
function firstLine(result: ImageToolResult): string | undefined {
  const part = result.content.find((each) => each.type === "text");
  const line = typeof part?.text === "string" ? part.text.trim().split(/\r\n|\n|\r/)[0].trim() : "";
  return line === "" ? undefined : line;
}

/** When the file was last written, or nothing for a file that is not there. */
function modifiedAt(file: string): number | undefined {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return undefined;
  }
}
