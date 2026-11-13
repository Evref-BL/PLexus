/**
 * A base is a template with the pinned MCP loaded and saved, so that a create
 * copies it in seconds instead of loading MCP for minutes. It is a directory
 * of `<home>/bases` named after its template, category and pin, built under a
 * temporary name and renamed when complete: its existence is its record.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
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

export function baseKey(template: string, category: string, pin: string): string {
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
  return `${slug}-${hash}-mcp-${pin}`;
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
 * The base for this template, built first when there is none. `built` says
 * whether this call built the one it answers.
 */
export async function ensureBase(
  context: ImagesContext,
  template: { name: string; category: string },
  pin: string,
): Promise<{ dir: string; built: boolean }> {
  const key = baseKey(template.name, template.category, pin);
  const dir = path.join(basesRoot(context.home), key);
  const isBase = () => isFile(path.join(dir, `${baseFileName}.image`));
  if (isBase()) {
    return { dir, built: false };
  }

  const build = newBuild(context, key);
  try {
    const failure =
      (await createFromTemplate(context, build, template)) ??
      (await prepare(context, build, { kind: "pin", version: pin }));
    if (failure !== undefined) {
      throw new PlexusError(
        "create-failed",
        `Building the base for ${template.name} failed.\n${failure}`,
      );
    }
    // What the build kept about itself is not the images' to copy.
    fs.rmSync(build.plexusDir, { recursive: true, force: true });
    renameImageFiles(build.dir, build.diskName, baseFileName);
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
    renameImageFiles(assembly, baseFileName, files.diskName);
    renameInMetaInf(path.join(assembly, "meta-inf.ston"), files.diskName);
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
      throw new PlexusError("image-exists", `Image ${files.name} already exists.`);
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

export function renameImageFiles(dir: string, from: string, to: string): void {
  for (const extension of [".image", ".changes"]) {
    const source = path.join(dir, `${from}${extension}`);
    if (fs.existsSync(source)) {
      fs.renameSync(source, path.join(dir, `${to}${extension}`));
    }
  }
}

const relativePath = /RelativePath\s*\[\s*((?:'(?:''|[^'])*'\s*,?\s*)+)\]/g;

/**
 * The launcher finds an image's file through the path its metadata names,
 * which in a copy is still the directory it was copied from.
 */
export function renameInMetaInf(file: string, disk: string): void {
  let source: string;
  try {
    source = fs.readFileSync(file, "utf8");
  } catch {
    return;
  }
  const quoted = disk.replaceAll("'", "''");
  const renamed = `RelativePath [ '${quoted}', '${quoted}.image' ]`;
  const isImagePath = (parts: string): boolean => {
    const names = [...parts.matchAll(/'((?:''|[^'])*)'/g)].map((match) =>
      match[1].replaceAll("''", "'"),
    );
    const [directory, image] = names.slice(-2);
    return names.length >= 2 && image === `${directory}.image`;
  };

  const repaired = source
    .replace(/FileLocator\s*\{[\s\S]*?\}/g, (locator) => {
      let changed = false;
      const located = locator.replace(relativePath, (match, parts: string) => {
        if (!isImagePath(parts)) {
          return match;
        }
        changed = true;
        return renamed;
      });
      // The path is now relative to the launcher's images, whatever it was
      // relative to before.
      return changed
        ? located.replace(/#origin\s*:\s*#[A-Za-z][A-Za-z0-9_]*/g, "#origin : #launcherImagesLocation")
        : located;
    })
    .replace(relativePath, (match, parts: string) => (isImagePath(parts) ? renamed : match));
  if (repaired !== source) {
    fs.writeFileSync(file, repaired, "utf8");
  }
}
