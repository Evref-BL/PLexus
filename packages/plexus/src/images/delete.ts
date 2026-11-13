import { PlexusError } from "../errors.js";
import type { ImagesContext } from "./context.js";
import { hostProcesses, vmsOn } from "./processes.js";
import { beingStarted, launchLockState } from "./start.js";
import { exists, imageFiles, noSuchImage, removeDirectory } from "./store.js";

/**
 * Remove the image's directory, complete or not, unless a VM runs it or a
 * start is launching one.
 */
export async function deleteImage(
  context: ImagesContext,
  name: string,
): Promise<{ name: string }> {
  const files = imageFiles(context, name);
  if (!exists(files.dir)) {
    throw noSuchImage(files);
  }
  const pids = vmsOn(files.imagePath, await hostProcesses(context)).map((vm) => vm.pid);
  if (pids.length > 0) {
    throw new PlexusError(
      "image-running",
      `Image ${name} is running as pid ${pids.join(", ")}. Stop it before deleting it.`,
      { pids },
    );
  }
  const lock = launchLockState(context, files);
  if (lock.state === "held") {
    throw beingStarted(files, lock.holder);
  }
  removeDirectory(context.home, files.dir);
  return { name };
}
