import fs from "node:fs";
import {
  launcherFailureMessage,
  launchLogPaths,
} from "../launcher/pharoLauncherMcpClient.js";
import type { ImagesContext } from "./context.js";
import { prepareScript, type PrepareSource } from "./scripts.js";
import { readProperties, type ImageFiles } from "./store.js";

/**
 * Make an image from a template in the store, under the name the launcher
 * knows it by. What failed, when it did.
 */
export async function createFromTemplate(
  context: ImagesContext,
  files: ImageFiles,
  template: { name: string; category: string },
): Promise<string | undefined> {
  const result = await context.launcher().createImage({
    templateName: template.name,
    templateCategory: template.category,
    newImageName: files.diskName,
    noLaunch: true,
  });
  return result.ok ? undefined : launcherFailureMessage("createImage", result);
}

/**
 * Run the preparation in the image, which loads MCP, saves and quits. What
 * failed, when it did: the image's own report first, since it names the
 * Smalltalk error, then the launcher's.
 */
export async function prepare(
  context: ImagesContext,
  files: ImageFiles,
  source: PrepareSource,
): Promise<string | undefined> {
  fs.mkdirSync(files.plexusDir, { recursive: true });
  fs.rmSync(files.prepareStatus, { force: true });
  fs.writeFileSync(files.prepareScript, prepareScript(source), "utf8");

  const result = await context.launcher().startImage({
    imageName: files.diskName,
    script: files.prepareScript,
    detached: false,
    displayMode: "headless",
    // The VM's output and the launcher's report of which VM it ran: a VM that
    // cannot run an image says there how to renew it.
    includeRaw: true,
  });
  const status = readProperties(files.prepareStatus);
  if (result.ok && status?.status === "ok") {
    fs.rmSync(files.prepareScript, { force: true });
    fs.rmSync(files.prepareStatus, { force: true });
    return undefined;
  }

  const reasons = [
    status?.status === "failed"
      ? `Loading MCP failed: ${status.message || "the image gave no message"}`
      : undefined,
    result.ok ? undefined : launcherFailureMessage("startImage", result),
  ].filter((reason): reason is string => reason !== undefined);
  const logs = launchLogPaths(result);
  return [
    reasons.length > 0
      ? reasons.join("\n")
      : "The preparation ended without saying whether MCP loaded.",
    ...(logs.length > 0 ? [`Launcher logs: ${logs.join(", ")}`] : []),
  ].join("\n");
}
