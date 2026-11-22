/**
 * A base is a template with the pinned MCP loaded and saved, so that a create
 * copies it in seconds instead of loading MCP for minutes. It is a directory
 * of `<home>/bases/shared` named after its template, category, pin and
 * whether it holds MCP's `Telemetry` group, built under a temporary name and
 * renamed when complete: its existence is its record. Beside it,
 * `<key>.used` says when a create last copied it.
 *
 * Releases of PLexus with other pins share the home, as when an agent host
 * runs an older one beside a newer, so a base goes only once no create has
 * used it for a while, whatever its pin (see `evictBases`).
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { repairCopiedImageMetadataInDirectory } from "@evref-bl/pharo-launcher-mcp/launcher";
import * as texts from "../answers/texts.js";
import { PlexusError } from "../errors.js";
import { basesRoot, legacyBasesRoot, storeRoot, tmpRoot } from "../home.js";
import type { ImageTelemetry } from "../types.js";
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
  // The pin ends every key, as it did when bases were removed by pin.
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
 * whether this call built the one it answers, and `telemetry` whether the
 * images copied from it can record their calls. With telemetry it is the
 * base that holds MCP's `Telemetry` group, a base of its own, unless that one
 * cannot be built: telemetry never fails a create, so the base without it
 * serves, and `telemetry` says why its images record nothing. A telemetry
 * base that failed while the plain one served is remembered with why, and not
 * tried again until `failedTelemetryBaseRetryMs` has passed.
 */
export async function ensureBase(
  context: ImagesContext,
  template: { name: string; category: string },
  pin: string,
): Promise<{ dir: string; built: boolean; telemetry: ImageTelemetry }> {
  if (!context.telemetry) {
    return { ...(await ensureBaseHolding(context, template, pin, false)), telemetry: { on: false, reason: "not-asked" } };
  }
  const record = failureRecord(context.home, baseKey(template.name, template.category, pin, true));
  const failure = readFailure(record);
  if (failure !== undefined && context.now() - failure.at < failedTelemetryBaseRetryMs) {
    return { ...(await ensureBaseHolding(context, template, pin, false)), telemetry: baseFailed(failure.detail) };
  }
  try {
    const base = await ensureBaseHolding(context, template, pin, true);
    fs.rmSync(record, { force: true });
    return { ...base, telemetry: { on: true } };
  } catch (error) {
    const base = await ensureBaseHolding(context, template, pin, false);
    const detail = failureDetail(error);
    writeFailure(record, context.now(), detail);
    return { ...base, telemetry: baseFailed(detail) };
  }
}

function baseFailed(detail: string | undefined): ImageTelemetry {
  return { on: false, reason: "base-failed", ...(detail ? { detail } : {}) };
}

/** The longest a failure's own words are kept: a launcher's diagnostic can run to pages. */
const detailLength = 300;

/** What a failure said, on one line, after the line saying which base failed. */
function failureDetail(error: unknown): string {
  const lines = (error instanceof Error ? error.message : String(error)).split(/\r?\n/);
  const said = error instanceof PlexusError && lines.length > 1 ? lines.slice(1) : lines;
  const text = said.join(" ").replace(/\s+/g, " ").trim();
  return text.length > detailLength ? `${text.slice(0, detailLength)}…` : text;
}

/** Where a base's failure to build is recorded: a file beside the bases. */
function failureRecord(home: string, key: string): string {
  return path.join(basesRoot(home), `${key}${failedSuffix}`);
}

const failedSuffix = ".failed";
const usedSuffix = ".used";

/** When the base failed, on the record's first line, and why, on its second. */
function readFailure(file: string): { at: number; detail?: string } | undefined {
  try {
    const [first, detail] = fs.readFileSync(file, "utf8").split(/\r?\n/);
    const at = Number(first.trim());
    return Number.isFinite(at) ? { at, ...(detail?.trim() ? { detail: detail.trim() } : {}) } : undefined;
  } catch {
    return undefined;
  }
}

function writeFailure(file: string, at: number, detail: string): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${at}\n${detail}\n`, "utf8");
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
  if (isBase() || adoptLegacyBase(context, key, dir)) {
    used(context, key);
    evictBases(context);
    return { dir, built: false };
  }

  const build = newBuild(context, key);
  try {
    const failure =
      (await createFromTemplate(context, build, template)) ??
      (await prepare(context, build, { kind: "pin", version: pin, telemetry })).failure;
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
    used(context, key);
    return { dir, built: true };
  }
  used(context, key);
  evictBases(context);
  return { dir, built: true };
}

/**
 * Says that a create is copying the base now. Written before the copy, so a
 * base being copied was used within the last day, which `evictBases` never
 * removes.
 */
function used(context: ImagesContext, key: string): void {
  try {
    fs.writeFileSync(path.join(basesRoot(context.home), `${key}${usedSuffix}`), `${context.now()}\n`, "utf8");
  } catch {
    // Unstamped, the base counts as used when its directory last changed.
  }
}

/**
 * The same base as PLexus 0.16 to 0.20 left it in `<home>/bases`, copied in,
 * clones where the filesystem can, rather than built again; theirs is left
 * to them. Answers whether there is one now.
 */
function adoptLegacyBase(context: ImagesContext, key: string, dir: string): boolean {
  const legacy = path.join(legacyBasesRoot(context.home), key);
  if (!isFile(path.join(legacy, `${baseFileName}.image`))) {
    return false;
  }
  const assembly = ownedName(path.join(tmpRoot(context.home), `${key}-`));
  try {
    copyTree(legacy, assembly);
    fs.mkdirSync(basesRoot(context.home), { recursive: true });
    fs.renameSync(assembly, dir);
  } catch {
    // Gone meanwhile, or another create adopted it first.
  } finally {
    fs.rmSync(assembly, { recursive: true, force: true });
  }
  return isFile(path.join(dir, `${baseFileName}.image`));
}

/** How long a base no create has used is kept. */
export const unusedBaseMs = 30 * 24 * 60 * 60_000;

/** How much the bases may hold before the least recently used go, oldest first. */
export const basesCapBytes = 5 * 1024 ** 3;

/** A base used this recently is never removed: a create may still be copying it. */
export const recentlyUsedBaseMs = 24 * 60 * 60_000;

/**
 * Removes the bases no create has used for `unusedMs`, and, while the bases
 * hold more than `capBytes`, the least recently used, but never one used
 * within `recentlyUsedBaseMs`. A pin plays no part: another PLexus sharing
 * the home may be creating from a base of its own pin. A failure record goes
 * once it no longer holds a base back.
 */
export function evictBases(
  context: ImagesContext,
  limits: { unusedMs?: number; capBytes?: number } = {},
): void {
  const unusedMs = limits.unusedMs ?? unusedBaseMs;
  const capBytes = limits.capBytes ?? basesCapBytes;
  const root = basesRoot(context.home);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  const now = context.now();
  const bases = entries
    .filter((entry) => entry.isDirectory() && isFile(path.join(root, entry.name, `${baseFileName}.image`)))
    .map((entry) => {
      const dir = path.join(root, entry.name);
      return { key: entry.name, dir, usedAt: lastUsed(root, entry.name), bytes: treeBytes(dir) };
    })
    .sort((left, right) => left.usedAt - right.usedAt);
  let held = bases.reduce((total, base) => total + base.bytes, 0);
  for (const base of bases) {
    if (now - base.usedAt < recentlyUsedBaseMs) {
      break;
    }
    if (now - base.usedAt >= unusedMs || held > capBytes) {
      try {
        removeDirectory(context.home, base.dir);
        fs.rmSync(path.join(root, `${base.key}${usedSuffix}`), { force: true });
        held -= base.bytes;
      } catch {
        // Left for a later create to remove.
      }
    }
  }
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith(failedSuffix)) {
      const failure = readFailure(path.join(root, entry.name));
      if (failure === undefined || now - failure.at >= failedTelemetryBaseRetryMs) {
        fs.rmSync(path.join(root, entry.name), { force: true });
      }
    }
  }
}

/** When a create last used the base: its stamp, else when its directory last changed. */
function lastUsed(root: string, key: string): number {
  try {
    const at = Number(fs.readFileSync(path.join(root, `${key}${usedSuffix}`), "utf8").trim());
    if (Number.isFinite(at)) {
      return at;
    }
  } catch {
    // No stamp: a base this release did not copy yet.
  }
  try {
    return fs.statSync(path.join(root, key)).mtimeMs;
  } catch {
    return 0;
  }
}

/** The bytes a directory's files hold, links not followed. */
function treeBytes(dir: string): number {
  let total = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      total += treeBytes(file);
    } else {
      try {
        total += fs.lstatSync(file).size;
      } catch {
        // Gone meanwhile.
      }
    }
  }
  return total;
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
