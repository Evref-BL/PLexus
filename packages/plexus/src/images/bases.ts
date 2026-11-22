/**
 * A base is a template with the pinned MCP loaded and saved, so that a create
 * copies it in seconds instead of loading MCP for minutes. It is a directory
 * of `<home>/bases` named after its template, category, pin and whether it
 * holds MCP's `Telemetry` group, built under a temporary name and renamed when
 * complete: its existence is its record.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { repairCopiedImageMetadataInDirectory } from "@evref-bl/pharo-launcher-mcp/launcher";
import * as texts from "../answers/texts.js";
import { PlexusError } from "../errors.js";
import { basesRoot, storeRoot, tmpRoot } from "../home.js";
import type { ImagesContext } from "./context.js";
import { buildPrefix } from "./names.js";
import { createFromTemplate, prepare } from "./prepare.js";
import {
  filesOfDirectory,
  isFile,
  ownedName,
  removeDirectory,
  type ImageFiles,
} from "./store.js";

const baseFileName = "base";

export function baseKey(template: string, category: string, pin: string, telemetry = false): string {
  const slug = template
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  const hash = crypto
    .createHash("sha1")
    .update(`${category}\n${template}`)
    .digest("hex")
    .slice(0, 8);
  // Before the pin, which ends every key: see evictOtherPins.
  return `${slug}-${hash}${telemetry ? "-telemetry" : ""}-mcp-${pin}`;
}

/**
 * Where an image is made from a template before it is what it is for: in the
 * store, where the launcher makes images, under a name no image can have and
 * that says which process owns it.
 */
export function newBuild(context: ImagesContext, name: string): ImageFiles {
  return filesOfDirectory(ownedName(path.join(storeRoot(context.home), buildPrefix)), name);
}

/**
 * How long a telemetry base that failed to build is not tried again, while
 * creates copy the base without it. Trying loads MCP and its `Telemetry`
 * group from the network, minutes that the create waits; whatever failed,
 * an offline machine or a group that does not load on that Pharo, rarely
 * mends within the hour. A day keeps that cost to one create a day, and a new
 * pin, which may fix the load, is tried at once.
 */
export const failedTelemetryBaseRetryMs = 24 * 60 * 60_000;

/**
 * The base for this template, built first when there is none. `built` says
 * whether this call built the one it answers. With telemetry it is the base
 * that holds MCP's `Telemetry` group, a base of its own, unless that one
 * cannot be built: telemetry never fails a create, so the base without it
 * serves, and the image is not traced. A telemetry base that failed while
 * the plain one served is remembered, and not tried again until
 * `failedTelemetryBaseRetryMs` has passed.
 */
export async function ensureBase(
  context: ImagesContext,
  template: { name: string; category: string },
  pin: string,
): Promise<{ dir: string; built: boolean }> {
  if (!context.telemetry) {
    return ensureBaseHolding(context, template, pin, false);
  }
  const failure = failureRecord(context.home, baseKey(template.name, template.category, pin, true));
  const failedAt = readFailure(failure);
  if (failedAt !== undefined && context.now() - failedAt < failedTelemetryBaseRetryMs) {
    return ensureBaseHolding(context, template, pin, false);
  }
  try {
    const base = await ensureBaseHolding(context, template, pin, true);
    fs.rmSync(failure, { force: true });
    return base;
  } catch {
    const base = await ensureBaseHolding(context, template, pin, false);
    writeFailure(failure, context.now());
    return base;
  }
}

/**
 * Where a base's failure to build is recorded: a file beside the bases whose
 * name ends with the pin, as a base's does, so that it goes with the other
 * bases of its pin.
 */
function failureRecord(home: string, key: string): string {
  return path.join(basesRoot(home), key.replace(/-mcp-([^/\\]+)$/, "-failed-mcp-$1"));
}

function readFailure(file: string): number | undefined {
  try {
    const at = Number(fs.readFileSync(file, "utf8").trim());
    return Number.isFinite(at) ? at : undefined;
  } catch {
    return undefined;
  }
}

function writeFailure(file: string, at: number): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${at}\n`, "utf8");
  } catch {
    // Not remembered: the next create tries again.
  }
}

async function ensureBaseHolding(
  context: ImagesContext,
  template: { name: string; category: string },
  pin: string,
  telemetry: boolean,
): Promise<{ dir: string; built: boolean }> {
  const key = baseKey(template.name, template.category, pin, telemetry);
  const dir = path.join(basesRoot(context.home), key);
  const isBase = () => isFile(path.join(dir, `${baseFileName}.image`));
  if (isBase()) {
    return { dir, built: false };
  }

  const build = newBuild(context, key);
  try {
    const failure =
      (await createFromTemplate(context, build, template)) ??
      (await prepare(context, build, { kind: "pin", version: pin, telemetry }));
    if (failure !== undefined) {
      throw new PlexusError(
        "create-failed",
        `Building the base for ${template.name} failed.\n${failure}`,
      );
    }
    // What the build kept about itself is not the images' to copy.
    fs.rmSync(build.plexusDir, { recursive: true, force: true });
    renameImage(build.dir, build.diskName, baseFileName);
    fs.mkdirSync(basesRoot(context.home), { recursive: true });
    fs.renameSync(build.dir, dir);
  } catch (error) {
    removeDirectory(context.home, build.dir);
    if (error instanceof PlexusError || !isBase()) {
      throw error;
    }
    // Another create built the same base meanwhile, and it is as good.
    return { dir, built: true };
  }
  evictOtherPins(context.home, pin);
  return { dir, built: true };
}

/** Bases of another pin are never used again once this one is built. */
export function evictOtherPins(home: string, pin: string): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(basesRoot(home));
  } catch {
    return;
  }
  for (const entry of entries) {
    if (/-mcp-[^/\\]+$/.test(entry) && !entry.endsWith(`-mcp-${pin}`)) {
      removeDirectory(home, path.join(basesRoot(home), entry));
    }
  }
}

/**
 * A copy of the base as the image `files` names, assembled outside the store
 * and renamed in, so that a half-copied image is never listed. `finish` adds
 * what the image keeps about itself before the rename.
 */
export function copyBase(
  context: ImagesContext,
  base: string,
  files: ImageFiles,
  finish: (assembled: ImageFiles) => void,
): void {
  const assembly = ownedName(path.join(tmpRoot(context.home), `${files.diskName}-`));
  const assembled = filesOfDirectory(assembly, files.name, files.diskName);
  try {
    copyTree(base, assembly);
    renameImage(assembly, baseFileName, files.diskName);
    finish(assembled);
    moveIntoStore(assembly, files);
  } finally {
    fs.rmSync(assembly, { recursive: true, force: true });
  }
}

/**
 * Rename a directory in as the image `files` names, whole: a name another
 * create took meanwhile is refused, and that create's image left alone.
 */
export function moveIntoStore(dir: string, files: ImageFiles): void {
  fs.mkdirSync(path.dirname(files.dir), { recursive: true });
  try {
    fs.renameSync(dir, files.dir);
  } catch (error) {
    if (fs.existsSync(files.dir)) {
      throw new PlexusError("image-exists", texts.imageExists(files.name));
    }
    throw error;
  }
}

// Clone where the filesystem can: an image is hundreds of megabytes that the
// copy then rewrites a little of at a time.
function copyTree(source: string, target: string): void {
  fs.mkdirSync(target, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    if (entry.isDirectory()) {
      copyTree(from, to);
    } else if (entry.isSymbolicLink()) {
      fs.symlinkSync(fs.readlinkSync(from), to);
    } else {
      fs.copyFileSync(from, to, fs.constants.COPYFILE_FICLONE);
    }
  }
}

/**
 * Rename the image a directory holds: its files, and the path the launcher's
 * metadata names it by, which in a copy is still the image it was copied from.
 */
export function renameImage(dir: string, from: string, to: string): void {
  for (const extension of [".image", ".changes"]) {
    const source = path.join(dir, `${from}${extension}`);
    if (fs.existsSync(source)) {
      fs.renameSync(source, path.join(dir, `${to}${extension}`));
    }
  }
  repairCopiedImageMetadataInDirectory(dir, from, to);
}
