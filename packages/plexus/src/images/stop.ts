import fs from "node:fs";
import { PlexusError } from "../errors.js";
import type { ImagesContext } from "./context.js";
import { hostProcesses, killFailureLines, killVms, vmsOn } from "./processes.js";
import { exists, imageFiles, noSuchImage } from "./store.js";

/**
 * Kill every VM running the image. A kill does not save: an agent that wants
 * the image saved saves it through the image first. Not running is not an
 * error.
 */
export async function stop(
  context: ImagesContext,
  name: string,
): Promise<{ name: string; killed: number[] }> {
  const files = imageFiles(context, name);
  if (!exists(files.dir)) {
    throw noSuchImage(files);
  }
  const pids = vmsOn(files.imagePath, await hostProcesses(context)).map((vm) => vm.pid);
  if (pids.length === 0) {
    return { name, killed: [] };
  }

  // A VM the launcher would not kill is still there, and waiting for it to
  // go would only hide why.
  const failures = await killVms(context, pids);
  if (failures.length > 0) {
    const survivors = failures.map((failure) => failure.pid);
    throw new PlexusError(
      "stop-failed",
      [`Image ${name} still runs as pid ${survivors.join(", ")}.`, ...killFailureLines(failures)].join("\n"),
      { pids: survivors },
    );
  }

  const startedAt = context.now();
  for (;;) {
    const survivors = vmsOn(files.imagePath, await hostProcesses(context))
      .map((vm) => vm.pid)
      .filter((pid) => pids.includes(pid));
    if (survivors.length === 0) {
      break;
    }
    if (context.now() - startedAt >= context.stopWaitMs) {
      throw new PlexusError(
        "stop-failed",
        `Image ${name} still runs as pid ${survivors.join(", ")} after being killed.`,
        { pids: survivors },
      );
    }
    await context.sleep(context.pollMs);
  }

  fs.rmSync(files.endpoint, { force: true });
  return { name, killed: pids };
}
