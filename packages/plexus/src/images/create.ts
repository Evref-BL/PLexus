import fs from "node:fs";
import path from "node:path";
import { defaultPharoMcpVersion } from "../config/pharoMcpVersion.js";
import { PlexusError } from "../errors.js";
import type { CreateOptions, ImageInfo } from "../types.js";
import { plexusVersion } from "../version.js";
import { copyBase, ensureBase } from "./bases.js";
import type { ImagesContext } from "./context.js";
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

// Built where it stays, not renamed in: Iceberg repositories the script
// registers name the image's directory.
async function buildWithScript(
  context: ImagesContext,
  files: ImageFiles,
  template: { name: string; category: string },
  script: string,
  everyStart: boolean,
): Promise<void> {
  const created = await createFromTemplate(context, files, template);
  if (created !== undefined) {
    removeDirectory(context.home, files.dir);
    throw new PlexusError("create-failed", `Creating image ${files.name} failed.\n${created}`);
  }

  fs.mkdirSync(files.plexusDir, { recursive: true });
  fs.writeFileSync(files.building, "", "utf8");
  const prepared = await prepare(context, files, { kind: "script", script });
  if (prepared !== undefined) {
    removeDirectory(context.home, files.dir);
    throw new PlexusError("create-failed", `Preparing image ${files.name} failed.\n${prepared}`);
  }

  recordCreation(files, template, { source: "script", script });
  if (everyStart) {
    fs.writeFileSync(files.onStart, `${script}\n`, "utf8");
  }
  fs.rmSync(files.building, { force: true });
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
