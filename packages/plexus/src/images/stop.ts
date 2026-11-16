import fs from "node:fs";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import * as texts from "../answers/texts.js";
import { PlexusError } from "../errors.js";
import { evaluationTool } from "../forward/index.js";
import type { ForwardError } from "../forward/jsonRpc.js";
import type { LauncherProcess } from "../launcher/pharoLauncherMcpClient.js";
import type { StopOptions } from "../types.js";
import type { ImagesContext } from "./context.js";
import { endpointOf, noEndpointYet } from "./endpoint.js";
import { describe } from "./list.js";
import { hostProcesses, killFailureLines, killVms, vmsOn } from "./processes.js";
import { exists, imageFiles, noSuchImage, type ImageFiles } from "./store.js";

export interface StopResult {
  name: string;
  /** The VMs killed: every one that ran the image, or, after a save, those left beside the one that saved. */
  killed: number[];
  /** The image saved itself and quit. */
  saved?: true;
}

/** What an image evaluates to save itself and quit. */
const saveAndQuitCode = "Smalltalk snapshot: true andQuit: true";

/**
 * Kill every VM running the image, which does not save; or, asked to save,
 * have the image save itself and quit through its MCP server, and wait until
 * its VM is gone and its image file was written. An image that does not save
 * and quit in time is left running. Not running is not an error.
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

  await killAndWait(context, files, pids);
  fs.rmSync(files.endpoint, { force: true });
  return { name, killed: pids };
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
 * connection closing is what a save looks like; whether it saved is read from
 * the image file, whose modification time moves. A VM beside the one that
 * saved, which a stop would kill, is killed once it has.
 */
async function saveAndStop(
  context: ImagesContext,
  files: ImageFiles,
  processes: readonly LauncherProcess[],
): Promise<StopResult> {
  const name = files.name;
  const row = describe(files, processes);
  if (row.endpoint === undefined && !row.building && row.endpointProblem !== noEndpointYet) {
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
  const notSaved = (reason: string) =>
    new PlexusError("save-failed", texts.notSaved(name, reason), { pids: row.pids });

  let tool: string;
  try {
    tool = evaluationTool(await context.listTools(endpoint));
  } catch (error) {
    throw notSaved(notTakenReason(error));
  }

  const startedAt = context.now();
  let answer: CallToolResult | undefined;
  try {
    answer = await context.callTool(endpoint, tool, { code: saveAndQuitCode }, { minimumMs: context.saveWaitMs });
  } catch (error) {
    const kind = (error as Partial<ForwardError>).kind;
    // The call was not sent, or the image refused it; any other failure is
    // what a VM that quits does to the call.
    if (kind === "no-handshake" || kind === "refused" || kind === "answered") {
      throw notSaved(notTakenReason(error));
    }
  }
  if (answer?.isError === true) {
    const line = firstLine(answer);
    throw notSaved(line === undefined ? `${tool} answered an error with no text` : `${tool} answered "${line}"`);
  }

  let left: number[];
  for (;;) {
    const running = vmsOn(files.imagePath, await hostProcesses(context)).map((vm) => vm.pid);
    if (!running.some((pid) => savers.includes(pid))) {
      left = running;
      break;
    }
    if (context.now() - startedAt >= context.saveWaitMs) {
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
    throw new PlexusError("save-failed", texts.stoppedUnsaved(name));
  }
  return { name, killed: left, saved: true };
}

/** Why the image did not take a call it was sent, or never got. */
function notTakenReason(error: unknown): string {
  const failure = (error instanceof Error ? error : new Error(String(error))) as Error & {
    kind?: ForwardError["kind"];
    waitedMs?: number;
  };
  const message = failure.message.replace(/\.$/, "");
  switch (failure.kind) {
    case "no-handshake":
    case "timeout":
      return `it did not answer within ${Math.round((failure.waitedMs ?? 0) / 1000)} s`;
    case "refused":
      return "it refused the connection";
    case "answered":
      return `it answered ${message}`;
    default:
      return message;
  }
}

/** The first line of a tool's text answer, or nothing for an answer with no text. */
function firstLine(result: CallToolResult): string | undefined {
  const part = result.content.find((each) => each.type === "text");
  const line = part?.type === "text" ? part.text.trim().split(/\r\n|\n|\r/)[0].trim() : "";
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
