import fs from "node:fs";
import path from "node:path";
import { defaultPharoMcpVersion } from "../config/pharoMcpVersion.js";
import { PlexusError } from "../errors.js";
import { longCommandTimeoutMs } from "../launcher/pharoLauncherMcpClient.js";
import type { CreateOptions, ImageInfo } from "../types.js";
import { plexusVersion } from "../version.js";
import {
  copyBase,
  ensureBase,
  moveIntoStore,
  newBuild,
  renameImageFiles,
  renameInMetaInf,
} from "./bases.js";
import { claimContent, readClaim, type ClaimHolder, type ClaimState } from "./claims.js";
import type { ImagesContext } from "./context.js";
import { removeLeftovers } from "./leftovers.js";
import { describe } from "./list.js";
import { createFromTemplate, prepare } from "./prepare.js";
import { categoryOf } from "./templates.js";
import {
  exists,
  imageFiles,
  isFile,
  removeDirectory,
  writeCreated,
  type ImageFiles,
  type McpSource,
} from "./store.js";

export type CreateResult = ImageInfo & { fromBase: boolean; seconds: number };

// A create runs at most two long launcher commands, one making the image from
// its template and one preparing it. A building marker older than that
// outlived its create, whatever process its pid names by now.
const createMaxMs = 2 * longCommandTimeoutMs + 10 * 60_000;

/**
 * A new image with MCP in it, saved and not started. Without a script it is a
 * copy of the base for its template; with one, it is built from the template
 * and the script is filed in once.
 */
export async function create(
  context: ImagesContext,
  name: string,
  options: CreateOptions,
): Promise<CreateResult> {
  const startedAt = context.now();
  const files = imageFiles(context, name);
  if (exists(files.dir)) {
    throw new PlexusError("image-exists", `Image ${name} already exists.`);
  }
  const script = checkedScript(options);
  if (typeof options.template !== "string" || options.template.trim() === "") {
    throw new PlexusError("unknown-template", "A create needs a template.");
  }
  const template = {
    name: options.template,
    category: options.category ?? (await categoryOf(context, options.template)),
  };
  removeLeftovers(context.home);

  let fromBase = false;
  if (script === undefined) {
    const base = await ensureBase(context, template, defaultPharoMcpVersion);
    fromBase = !base.built;
    copyBase(context, base.dir, files, (assembled) =>
      recordCreation(assembled, template, { source: "pin", version: defaultPharoMcpVersion }),
    );
  } else {
    await buildWithScript(context, files, template, script, options.everyStart === true);
  }

  return {
    ...describe(files, []),
    fromBase,
    seconds: Math.round((context.now() - startedAt) / 100) / 10,
  };
}

/** Whether a create is making this image now, or made it and ended first. */
export function buildingState(context: ImagesContext, files: ImageFiles): ClaimState {
  return readClaim(context, files.building, createMaxMs);
}

export function stillBuilding(files: ImageFiles, holder: ClaimHolder | undefined): PlexusError {
  return new PlexusError(
    "building",
    `Image ${files.name} is still being created${holder ? ` by process ${holder.pid}` : ""}.`,
    holder ? { pid: holder.pid } : undefined,
  );
}

function checkedScript(options: CreateOptions): string | undefined {
  if (options.script === undefined) {
    if (options.everyStart) {
      throw new PlexusError("script-not-found", "everyStart needs a script.");
    }
    return undefined;
  }
  const script = path.resolve(options.script);
  if (!isFile(script)) {
    throw new PlexusError("script-not-found", `There is no script at ${script}.`);
  }
  return script;
}

// Made under a build name and renamed in with its building marker before the
// script runs: the image is never in the store unmarked, and a create that
// finds its name taken meanwhile removes its own build and nothing else.
// Iceberg repositories the script registers name the directory it stays in.
async function buildWithScript(
  context: ImagesContext,
  files: ImageFiles,
  template: { name: string; category: string },
  script: string,
  everyStart: boolean,
): Promise<void> {
  const build = newBuild(context, files.name);
  try {
    const created = await createFromTemplate(context, build, template);
    if (created !== undefined) {
      throw new PlexusError("create-failed", `Creating image ${files.name} failed.\n${created}`);
    }
    fs.mkdirSync(build.plexusDir, { recursive: true });
    fs.writeFileSync(build.building, claimContent(context), "utf8");
    renameImageFiles(build.dir, build.diskName, files.diskName);
    renameInMetaInf(path.join(build.dir, "meta-inf.ston"), files.diskName);
    moveIntoStore(build.dir, files);
  } catch (error) {
    removeDirectory(context.home, build.dir);
    throw error;
  }

  // The directory is this create's now: it renamed it in, and a delete
  // refuses it while its marker names this process.
  try {
    const prepared = await prepare(context, files, { kind: "script", script });
    if (prepared !== undefined) {
      throw new PlexusError("create-failed", `Preparing image ${files.name} failed.\n${prepared}`);
    }
    recordCreation(files, template, { source: "script", script });
    if (everyStart) {
      fs.writeFileSync(files.onStart, `${script}\n`, "utf8");
    }
    fs.rmSync(files.building, { force: true });
  } catch (error) {
    removeDirectory(context.home, files.dir);
    throw error;
  }
}

function recordCreation(
  files: ImageFiles,
  template: { name: string; category: string },
  mcp: McpSource,
): void {
  writeCreated(files, {
    template: template.name,
    category: template.category,
    mcp,
    plexus: plexusVersion,
    at: new Date(),
  });
}
