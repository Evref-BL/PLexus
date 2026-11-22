import fs from "node:fs";
import path from "node:path";
import {
  readImageDirectory,
  readLauncherImage,
  type LauncherImage,
} from "@evref-bl/pharo-launcher-mcp/launcher";
import { storeRoot } from "../home.js";
import type { LauncherProcess } from "../launcher/pharoLauncherMcpClient.js";
import type { ImageInfo, ImageState } from "../types.js";
import type { ImagesContext } from "./context.js";
import { observeEndpoint, type EndpointObservation } from "./endpoint.js";
import { nameOfDisk } from "./names.js";
import { displayOf, hostProcesses, vmsOn } from "./processes.js";
import {
  existingImage,
  filesOfDirectory,
  isImage,
  mcpSourceOf,
  readFirstLine,
  readProperties,
  type ImageFiles,
} from "./store.js";

/**
 * The images in scope, or the one named, with what runs them now: one look
 * at the store and one at the host's processes. It pings nothing and writes
 * nothing.
 */
export async function list(context: ImagesContext, name?: string): Promise<ImageInfo[]> {
  const images =
    name === undefined ? imagesInScope(context) : [existingImage(context, name)];
  if (images.length === 0) {
    return [];
  }
  const processes = await hostProcesses(context);
  return images.map((files) => describe(files, processes));
}

function imagesInScope(context: ImagesContext): ImageFiles[] {
  const store = storeRoot(context.home);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(store, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ entry, name: nameOfDisk(entry.name, context.scope) }))
    .filter((item): item is { entry: fs.Dirent; name: string } => item.name !== undefined)
    .map(({ entry, name }) => filesOfDirectory(path.join(store, entry.name), name))
    .filter(isImage)
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function describe(files: ImageFiles, processes: readonly LauncherProcess[]): ImageInfo {
  const vms = vmsOn(files.imagePath, processes);
  const created = readProperties(files.created);
  const recorded = launcherRecord(files);
  const template = recorded?.template?.name ?? created?.template;
  const pharoVersion = recorded?.pharoVersion;
  const mcp = mcpSourceOf(created?.mcp);
  const everyStart = readFirstLine(files.onStart) !== undefined;
  const observed = vms.length > 0 ? observeEndpoint(files, vms) : undefined;

  return {
    name: files.name,
    path: files.imagePath,
    state: stateOf(fs.existsSync(files.building), observed),
    running: vms.length > 0,
    pids: vms.map((vm) => vm.pid),
    ...(vms.length > 0 ? { display: displayOf(vms[0]) } : {}),
    ...(observed && "endpoint" in observed ? { endpoint: observed.endpoint } : {}),
    ...(observed && "problem" in observed ? { endpointProblem: observed.problem } : {}),
    ...(template === undefined ? {} : { template }),
    ...(pharoVersion === undefined ? {} : { pharoVersion: pharoVersionOf(pharoVersion) }),
    ...(mcp === undefined ? {} : { mcp: mcp.source === "script" && everyStart ? { ...mcp, everyStart: true } : mcp }),
  };
}

/**
 * A create still making the image wins whatever VM runs it: a script
 * create's own VM runs the image it prepares.
 */
function stateOf(building: boolean, observed: EndpointObservation | undefined): ImageState {
  if (building) {
    return "creating";
  }
  if (observed === undefined) {
    return "stopped";
  }
  return "endpoint" in observed ? "running" : "starting" in observed ? "starting" : "unreachable";
}

/** The Pharo version as Pharo says it: "140" is 14.0 and "61" is 6.1; anything else as it is. */
function pharoVersionOf(raw: string): string {
  return /^\d{2,3}$/.test(raw) ? `${raw.slice(0, -1)}.${raw.slice(-1)}` : raw;
}

/**
 * What the launcher records about an image, read as the launcher reads it:
 * the template it came from and its Pharo version.
 */
function launcherRecord(files: ImageFiles): LauncherImage | undefined {
  const directory = readImageDirectory(path.dirname(files.dir), files.diskName);
  return directory.kind === "image" ? readLauncherImage(directory.image) : undefined;
}
