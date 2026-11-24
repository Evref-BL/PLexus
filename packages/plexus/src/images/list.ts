import fs from "node:fs";
import path from "node:path";
import {
  readImageDirectory,
  readLauncherImage,
  type LauncherImage,
} from "@evref-bl/pharo-launcher-mcp/launcher";
import { storeRoot } from "../home.js";
import type { LauncherProcess } from "../launcher/pharoLauncherMcpClient.js";
import type { Endpoint, ImageInfo, ImageState, ImageTelemetry } from "../types.js";
import type { ImagesContext } from "./context.js";
import { parseEndpointHandoff, type EndpointHandoff } from "../forward/endpointHandoffFormat.js";
import { endpointUrl, observeEndpoint, type EndpointObservation } from "./endpoint.js";
import { nameOfDisk } from "./names.js";
import { displayOf, hostProcesses, vmsOn } from "./processes.js";
import {
  existingImage,
  filesOfDirectory,
  isImage,
  mcpSourceOf,
  readFirstLine,
  readProperties,
  telemetryOf,
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

/** Where a forwarded call goes: the image and its endpoint. */
export interface Answering {
  name: string;
  endpoint: Endpoint;
}

/**
 * The image a forwarded call goes to when the endpoint files alone can say:
 * the image named, or, naming none, the only image whose endpoint names a
 * live process, when that process is the VM an earlier look saw running the
 * image (`seen`, by image name). Undefined whenever only the look `list`
 * takes can say, refusals included. Listing the host's processes reads every
 * process's command line, tens of milliseconds where there are many, which
 * each call would pay; a VM keeps its pid and its endpoint while it runs.
 */
export function answeringFromEndpoints(
  context: ImagesContext,
  seen: ReadonlyMap<string, number>,
  name?: string,
): Answering | undefined {
  let images: ImageFiles[];
  try {
    images = name === undefined ? imagesInScope(context) : [existingImage(context, name)];
  } catch {
    return undefined;
  }
  const live: Array<{ files: ImageFiles; url: string; pid: number }> = [];
  for (const files of images) {
    if (fs.existsSync(files.building)) {
      if (name !== undefined) {
        return undefined;
      }
      continue;
    }
    let text: string;
    try {
      text = fs.readFileSync(files.endpoint, "utf8");
    } catch {
      continue;
    }
    let handoff: EndpointHandoff;
    try {
      handoff = parseEndpointHandoff(text);
    } catch {
      return undefined;
    }
    if (handoff.pid === undefined) {
      return undefined;
    }
    if (isAlive(handoff.pid)) {
      live.push({ files, url: endpointUrl(handoff), pid: handoff.pid });
    }
  }
  if (live.length !== 1 || seen.get(live[0].files.name) !== live[0].pid) {
    return undefined;
  }
  return { name: live[0].files.name, endpoint: { url: live[0].url, pid: live[0].pid } };
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
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
  const telemetry = imageTelemetry(observed, telemetryOf(created));
  const { lastUsed, imageBytes } = usageOf(files);

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
    ...(telemetry === undefined ? {} : { telemetry }),
    ...(lastUsed === undefined ? {} : { lastUsed }),
    ...(imageBytes === undefined ? {} : { imageBytes }),
  };
}

/**
 * When it was last used, the later of its last start, when the start script
 * every start writes was written, and its last save, when its image file
 * was; and the size of its image file.
 */
function usageOf(files: ImageFiles): { lastUsed?: string; imageBytes?: number } {
  const image = statOf(files.imagePath);
  const times = [statOf(files.startScript), image].flatMap((stat) => (stat === undefined ? [] : [stat.mtimeMs]));
  return {
    ...(times.length === 0 ? {} : { lastUsed: new Date(Math.max(...times)).toISOString() }),
    ...(image === undefined ? {} : { imageBytes: image.size }),
  };
}

function statOf(file: string): fs.Stats | undefined {
  try {
    return fs.statSync(file);
  } catch {
    return undefined;
  }
}

/**
 * Whether the image records its calls: running, what its start said, else
 * what its create said. A server with no backend to record with, in an image
 * whose create said why it has none, is said by that reason, which says what
 * to do.
 */
export function imageTelemetry(
  observed: EndpointObservation | undefined,
  created: ImageTelemetry | undefined,
): ImageTelemetry | undefined {
  const started = observed !== undefined && "endpoint" in observed ? observed.telemetry : undefined;
  if (started === undefined) {
    return created;
  }
  return !started.on && started.reason === "no-backend" && created?.on === false && created.reason !== undefined
    ? created
    : started;
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
