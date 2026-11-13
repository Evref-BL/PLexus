/**
 * A running image is a process whose command line names its image file. The
 * host's process list, asked once per call, is the only source.
 */
import fs from "node:fs";
import path from "node:path";
import { PlexusError } from "../errors.js";
import {
  launcherFailureMessage,
  type LauncherProcess,
} from "../launcher/pharoLauncherMcpClient.js";
import type { Display } from "../types.js";
import type { ImagesContext } from "./context.js";

export async function hostProcesses(context: ImagesContext): Promise<LauncherProcess[]> {
  const result = await context.launcher().listProcesses();
  if (!result.ok) {
    throw new PlexusError(
      "launcher-failed",
      launcherFailureMessage("listProcesses", result),
    );
  }
  return result.data ?? [];
}

/**
 * The VMs running this image file. Matched on the real path, never on a
 * basename or a substring: those took `plugin-mcp-eval` for `mcp-eval`.
 */
export function vmsOn(
  imagePath: string,
  processes: readonly LauncherProcess[],
): LauncherProcess[] {
  const image = realPath(imagePath);
  return processes.filter((process) => {
    const candidate = imagePathOf(process);
    return candidate !== undefined && samePath(realPath(candidate), image);
  });
}

export function displayOf(process: LauncherProcess): Display {
  return /(^|\s|")--headless(\s|"|$)/.test(process.commandLine)
    ? "headless"
    : "interactive";
}

export async function killVms(context: ImagesContext, pids: readonly number[]): Promise<void> {
  for (const pid of pids) {
    // A VM that is already gone is what a kill asks for.
    await context.launcher().killProcess({ pid }).catch(() => undefined);
  }
}

// A relative path names a file only from the VM's working directory, which
// the process list does not say.
function imagePathOf(process: LauncherProcess): string | undefined {
  const candidate = process.imagePath ?? imageArgument(process.commandLine);
  return candidate !== undefined && path.isAbsolute(candidate) ? candidate : undefined;
}

function imageArgument(commandLine: string): string | undefined {
  const quoted = [...commandLine.matchAll(/"([^"]+)"|'([^']+)'/g)]
    .map((match) => match[1] ?? match[2])
    .find((value) => value.toLowerCase().endsWith(".image"));
  return (
    quoted ??
    commandLine.split(/\s+/).find((token) => token.toLowerCase().endsWith(".image"))
  );
}

function realPath(file: string): string {
  try {
    return fs.realpathSync.native(file);
  } catch {
    return path.resolve(file);
  }
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}
