import fs from "node:fs";
import path from "node:path";
import { storeRoot } from "../home.js";
import type { LauncherProcess } from "../launcher/pharoLauncherMcpClient.js";
import type { ImageInfo } from "../types.js";
import type { ImagesContext } from "./context.js";
import { observeEndpoint } from "./endpoint.js";
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
  const template = originTemplate(files.dir) ?? created?.template;
  const pharoVersion = readFirstLine(path.join(files.dir, "pharo.version"));
  const mcp = mcpSourceOf(created?.mcp);
  const everyStart = readFirstLine(files.onStart);
  const observed = vms.length > 0 ? observeEndpoint(files, vms) : undefined;

  return {
    name: files.name,
    diskName: files.diskName,
    path: files.imagePath,
    running: vms.length > 0,
    pids: vms.map((vm) => vm.pid),
    ...(vms.length > 0 ? { display: displayOf(vms[0]) } : {}),
    ...(observed && "endpoint" in observed ? { endpoint: observed.endpoint } : {}),
    ...(observed && "problem" in observed ? { endpointProblem: observed.problem } : {}),
    ...(fs.existsSync(files.building) ? { building: true as const } : {}),
    ...(template === undefined ? {} : { template }),
    ...(pharoVersion === undefined ? {} : { pharoVersion }),
    ...(mcp === undefined ? {} : { mcp }),
    ...(everyStart === undefined ? {} : { everyStart }),
  };
}

// The launcher records the template an image came from in its metadata.
function originTemplate(dir: string): string | undefined {
  let metadata: string;
  try {
    metadata = fs.readFileSync(path.join(dir, "meta-inf.ston"), "utf8");
  } catch {
    return undefined;
  }
  const name = /#originTemplate\s*:\s*\w+\s*\{[\s\S]*?#name\s*:\s*'((?:''|[^'])*)'/.exec(metadata)?.[1];
  return name?.replaceAll("''", "'");
}
