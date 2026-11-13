/**
 * An image is a directory of the store holding `<dir>/<dir>.image`. What
 * PLexus keeps about it is in `<dir>/plexus/` and goes with it.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { PlexusError } from "../errors.js";
import { storeRoot, tmpRoot } from "../home.js";
import type { ImageInfo } from "../types.js";
import type { ImagesContext } from "./context.js";
import { diskName } from "./names.js";

export interface ImageFiles {
  name: string;
  diskName: string;
  dir: string;
  imagePath: string;
  plexusDir: string;
  created: string;
  onStart: string;
  endpoint: string;
  startScript: string;
  startStatus: string;
  launchLock: string;
  building: string;
  prepareScript: string;
  prepareStatus: string;
}

export function imageFiles(context: ImagesContext, name: string): ImageFiles {
  const disk = diskName(name, context.scope);
  return filesOfDirectory(path.join(storeRoot(context.home), disk), name);
}

export function filesOfDirectory(
  dir: string,
  name: string,
  disk = path.basename(dir),
): ImageFiles {
  const plexusDir = path.join(dir, "plexus");
  return {
    name,
    diskName: disk,
    dir,
    imagePath: path.join(dir, `${disk}.image`),
    plexusDir,
    created: path.join(plexusDir, "created.properties"),
    onStart: path.join(plexusDir, "on-start"),
    endpoint: path.join(plexusDir, "endpoint.properties"),
    startScript: path.join(plexusDir, "start.st"),
    startStatus: path.join(plexusDir, "start-status.properties"),
    launchLock: path.join(plexusDir, "launch.lock"),
    building: path.join(plexusDir, "building"),
    prepareScript: path.join(plexusDir, "prepare.st"),
    prepareStatus: path.join(plexusDir, "prepare-status.properties"),
  };
}

/** The image's directory holds its image file. */
export function isImage(files: ImageFiles): boolean {
  return isFile(files.imagePath);
}

/** The image a caller names, refused when the store has no such image. */
export function existingImage(context: ImagesContext, name: string): ImageFiles {
  const files = imageFiles(context, name);
  if (!isImage(files)) {
    throw noSuchImage(files);
  }
  return files;
}

export function noSuchImage(files: ImageFiles): PlexusError {
  return new PlexusError("no-such-image", `There is no image ${files.name}.`);
}

export function isFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

export function exists(file: string): boolean {
  try {
    fs.lstatSync(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * `key=value` lines, as Pharo writes them with a bare cr and Node with lf.
 * Nothing when the file is absent.
 */
export function readProperties(file: string): Record<string, string> | undefined {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  const properties: Record<string, string> = {};
  for (const line of text.split(/\r\n|\n|\r/)) {
    const separator = line.indexOf("=");
    if (separator > 0 && !line.startsWith("#")) {
      properties[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
    }
  }
  return properties;
}

export function writeProperties(file: string, properties: Record<string, string>): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    Object.entries(properties)
      .map(([key, value]) => `${key}=${value.replace(/[\r\n]+/g, " ")}\n`)
      .join(""),
    "utf8",
  );
}

export function readFirstLine(file: string): string | undefined {
  try {
    return fs
      .readFileSync(file, "utf8")
      .split(/\r\n|\n|\r/)
      .map((line) => line.trim())
      .find((line) => line.length > 0);
  } catch {
    return undefined;
  }
}

export type McpSource = NonNullable<ImageInfo["mcp"]>;

export function writeCreated(
  files: ImageFiles,
  created: { template: string; category: string; mcp: McpSource; plexus: string; at: Date },
): void {
  writeProperties(files.created, {
    template: created.template,
    category: created.category,
    mcp:
      created.mcp.source === "pin"
        ? `pin:${created.mcp.version}`
        : `script:${created.mcp.script}`,
    plexus: created.plexus,
    created: created.at.toISOString(),
  });
}

export function mcpSourceOf(value: string | undefined): McpSource | undefined {
  if (value?.startsWith("pin:")) {
    return { source: "pin", version: value.slice("pin:".length) };
  }
  if (value?.startsWith("script:")) {
    return { source: "script", script: value.slice("script:".length) };
  }
  return undefined;
}

export function randomSuffix(): string {
  return crypto.randomBytes(4).toString("hex");
}

/**
 * Remove a directory: rename it out of the store first, so that nothing
 * lists or launches a half-removed image while the files go.
 */
export function removeDirectory(home: string, dir: string): void {
  const doomed = path.join(tmpRoot(home), `${path.basename(dir)}-${randomSuffix()}`);
  fs.mkdirSync(tmpRoot(home), { recursive: true });
  try {
    fs.renameSync(dir, doomed);
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return;
    }
    throw error;
  }
  fs.rmSync(doomed, { recursive: true, force: true });
}

export function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

/** Whether a process is still running. */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM is a process this one may not signal, which still exists.
    return errorCode(error) !== "ESRCH";
  }
}
