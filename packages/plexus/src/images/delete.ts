import * as texts from "../answers/texts.js";
import { PlexusError } from "../errors.js";
import type { ImagesContext } from "./context.js";
import { buildingState, stillBuilding } from "./create.js";
import { hostProcesses, vmsOn } from "./processes.js";
import { beingStarted, launchLockState } from "./start.js";
import { exists, imageFiles, noSuchImage, removeDirectory, type ImageFiles } from "./store.js";

/**
 * Remove the image's directory, complete or not, unless a VM runs it, or a
 * create or a start is still working on it, and then the launcher's logs of
 * its starts. An image whose create ended before it was done is removed like
 * any other.
 */
export async function deleteImage(
  context: ImagesContext,
  name: string,
): Promise<{ name: string }> {
  const files = imageFiles(context, name);
  if (!exists(files.dir)) {
    throw noSuchImage(files);
  }
  const building = buildingState(context, files);
  if (building.state === "held") {
    throw stillBuilding(files, building.holder);
  }
  const pids = vmsOn(files.imagePath, await hostProcesses(context)).map((vm) => vm.pid);
  if (pids.length > 0) {
    throw new PlexusError("image-running", texts.deleteRunning(name, pids), { pids });
  }
  const lock = launchLockState(context, files);
  if (lock.state === "held") {
    throw beingStarted(files, lock.holder);
  }
  removeDirectory(context.home, files.dir);
  await deleteLaunchLogs(context, files);
  return { name };
}

// The image is gone whatever happens to its logs: a launcher that cannot be
// opened leaves them to the sweep of the next start.
async function deleteLaunchLogs(context: ImagesContext, files: ImageFiles): Promise<void> {
  try {
    await context.launcher().deleteLaunchLogs({ image: files.diskName });
  } catch {
    // Left for the launcher's next start.
  }
}
