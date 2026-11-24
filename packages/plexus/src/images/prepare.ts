import fs from "node:fs";
import path from "node:path";
import {
  launcherFailureMessage,
  launchLogPaths,
  launchOutputTail,
} from "../launcher/pharoLauncherMcpClient.js";
import type { ImagesContext } from "./context.js";
import { prepareScript, type PrepareSource } from "./scripts.js";
import { readProperties, type ImageFiles } from "./store.js";
import { ensureTemplateSources } from "./templates.js";

/**
 * Make an image from a template in the store, under the name the launcher
 * knows it by. What failed, when it did.
 */
export async function createFromTemplate(
  context: ImagesContext,
  files: ImageFiles,
  template: { name: string; category: string },
): Promise<string | undefined> {
  const missing = await ensureTemplateSources(context);
  if (missing !== undefined) {
    return missing;
  }
  const result = await context.launcher().createImage({
    templateName: template.name,
    templateCategory: template.category,
    newImageName: files.diskName,
  });
  return result.ok ? undefined : launcherFailureMessage("createImage", result);
}

/**
 * Run the preparation in the image, which loads MCP, saves and quits. What
 * failed, when it did: the image's own report first, since it names the
 * Smalltalk error, then the launcher's. Otherwise whether MCP has its
 * OpenTelemetry backend, as the image said, once the clones it forgot are
 * deleted.
 */
export async function prepare(
  context: ImagesContext,
  files: ImageFiles,
  source: PrepareSource,
): Promise<{ failure: string } | { failure?: undefined; telemetry?: boolean }> {
  fs.mkdirSync(files.plexusDir, { recursive: true });
  fs.rmSync(files.prepareStatus, { force: true });
  fs.writeFileSync(files.prepareScript, prepareScript(source), "utf8");

  const result = await context.launcher().startImage({
    imageName: files.diskName,
    script: files.prepareScript,
    detached: false,
    displayMode: "headless",
  });
  const status = readProperties(files.prepareStatus);
  if (result.ok && status?.status === "ok") {
    deleteForgottenClones(files);
    fs.rmSync(files.prepareScript, { force: true });
    fs.rmSync(files.prepareStatus, { force: true });
    return status.telemetry === "on" || status.telemetry === "off" ? { telemetry: status.telemetry === "on" } : {};
  }

  const reasons = [
    status?.status === "failed"
      ? `Loading MCP failed: ${status.message || "the image gave no message"}`
      : undefined,
    result.ok ? undefined : launcherFailureMessage("startImage", result),
  ].filter((reason): reason is string => reason !== undefined);
  const logs = launchLogPaths(result);
  const failure = [
    // A launch that failed says how in its own message. One that ended well
    // without a status leaves only what the VM printed to say why.
    ...(reasons.length > 0
      ? reasons
      : ["The preparation ended without saying whether MCP loaded.", ...launchOutputTail(result)]),
    ...(logs.length > 0 ? [`Launcher logs: ${logs.join(", ")}`] : []),
  ].join("\n");
  return { failure };
}

/**
 * Deletes the clones the preparation forgot, which its status names one per
 * `clone=` line: each within the image's directory, and nothing else. A clone
 * that cannot be deleted is left.
 */
function deleteForgottenClones(files: ImageFiles): void {
  let text: string;
  try {
    text = fs.readFileSync(files.prepareStatus, "utf8");
  } catch {
    return;
  }
  const dir = realPath(files.dir);
  for (const line of text.split(/\r\n|\n|\r/)) {
    if (!line.startsWith("clone=")) {
      continue;
    }
    const clone = realPath(line.slice("clone=".length).trim());
    const inside = path.relative(dir, clone);
    if (inside !== "" && !inside.startsWith("..") && !path.isAbsolute(inside)) {
      try {
        fs.rmSync(clone, { recursive: true, force: true, maxRetries: 3 });
      } catch {
        // Left: a later load of that project may then need it deleted by hand.
      }
    }
  }
}

function realPath(file: string): string {
  try {
    return fs.realpathSync.native(file);
  } catch {
    return path.resolve(file);
  }
}
