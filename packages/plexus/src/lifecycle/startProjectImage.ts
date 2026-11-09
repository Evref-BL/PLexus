import type { LauncherProcess } from "@evref-bl/pharo-launcher-mcp/launcher";
import fs from "node:fs";
import { joinPathLike } from "../support/pathStyle.js";
import path from "node:path";
import {
  loadProjectConfig,
  projectImageDisplayMode,
  projectMcpStartupMode,
  type ProjectConfig,
  type ProjectImageDisplayMode,
  type ProjectImageConfig,
} from "../config/projectConfig.js";
import {
  openPharoLauncherClient,
  PharoLauncherMcpToolError,
  type PharoLauncherMcpToolClient,
} from "../launcher/pharoLauncherMcpClient.js";
import {
  copyProjectImageFromPreparedCache,
  type PreparedImageCacheMutationApproval,
} from "../images/preparedImageCache.js";
import {
  materializeProjectImageFromHomeCache,
  projectImageCanUseHomeImageCache,
  projectImagePharoMcpLoad,
  recordHomeImageCacheBase,
  sameHomeImageCachePharoMcpLoad,
  type HomeImageCacheMutationApproval,
  type HomeImageCachePharoMcpLoad,
} from "../images/homeImageCache.js";
import { isPidAlive } from "../gateway/server/support/processLiveness.js";
import { pharoLauncherMcpProfileEnvironment } from "../launcher/pharoLauncherProfile.js";
import {
  HttpPharoMcpHealthClient,
  type PharoMcpHealthClient,
} from "../mcp/pharoMcpHealth.js";
import {
  type ImageMcpClient,
} from "../mcp/imageOperations.js";
import {
  imageMcpEndpointHandoffPath,
  readImageMcpEndpointHandoff,
  removeImageMcpEndpointHandoff,
} from "../gateway/projectImageMcpEndpoint.js";
import {
  createProjectState,
  defaultWorkspaceId,
  loadProjectState,
  projectStatePath,
  runtimeStatusForImages,
  sanitizeRuntimeId,
  saveProjectState,
  type ProjectImageMcpEndpoint,
  type ProjectImageState,
  type ProjectState,
} from "../workspace/projectState.js";
import { writeProjectImageStartupScript } from "../workspace/projectStartupScript.js";

/**
 * What PLexus reads from a launcher result, not the launcher's result.
 *
 * `@evref-bl/pharo-launcher-mcp` answers a richer shape, and a value of it
 * satisfies this one. Asking only for what is read keeps a caller — a test
 * double included — from having to build fields nobody here looks at.
 */
export interface LauncherCommandResult<T = unknown> {
  ok: boolean;
  data?: T;
}

export type { LauncherProcess };

export interface StartProjectImagePollOptions {
  intervalMs?: number;
  processTimeoutMs?: number;
  healthTimeoutMs?: number;
}

export type StartProjectImageMcpClient = ImageMcpClient;

export interface StartProjectImageOptions {
  projectRoot: string;
  sourcePath?: string;
  stateRoot?: string;
  workspaceId?: string;
  imageId: string;
  displayMode?: ProjectImageDisplayMode;
  pharoLauncherMcpClient?: PharoLauncherMcpToolClient;
  imageMcpClient?: StartProjectImageMcpClient;
  healthClient?: PharoMcpHealthClient;
  now?: () => Date;
  poll?: StartProjectImagePollOptions;
  sleep?: (durationMs: number) => Promise<void>;
  preparedImageCacheApproval?: PreparedImageCacheMutationApproval;
  homeImageCacheApproval?: HomeImageCacheMutationApproval;
  homeImageCacheClient?: PharoLauncherMcpToolClient;
}

export interface StartProjectImageFailure {
  imageId: string;
  imageName: string;
  message: string;
  launcherToolName?: string;
  launcherResult?: unknown;
  diagnostic?: string;
  action?: string;
  process?: LauncherProcess;
}

export interface StartProjectImageResult {
  ok: boolean;
  projectRoot: string;
  statePath: string;
  state: ProjectState;
  failures: StartProjectImageFailure[];
}

export class StartProjectImageError extends Error {
  constructor(
    message: string,
    public readonly result: StartProjectImageResult,
  ) {
    super(message);
    this.name = "StartProjectImageError";
  }
}

function defaultSleep(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function launcherFailureDetails(
  error: unknown,
): Pick<
  StartProjectImageFailure,
  "launcherToolName" | "launcherResult" | "diagnostic" | "action"
> {
  if (!(error instanceof PharoLauncherMcpToolError)) {
    return {};
  }

  const result = error.result;
  const objectResult = isObject(result) ? result : undefined;

  return {
    launcherToolName: error.toolName,
    launcherResult: result,
    ...(typeof objectResult?.diagnostic === "string"
      ? { diagnostic: objectResult.diagnostic }
      : {}),
    ...(typeof objectResult?.action === "string"
      ? { action: objectResult.action }
      : {}),
  };
}

function closeClientQuietly(client: PharoLauncherMcpToolClient): void {
  void client.close?.().catch(() => undefined);
}

function processDirectlyMatchesImage(
  process: LauncherProcess,
  imageName: string,
): boolean {
  return (
    process.imageName === imageName ||
    path.basename(process.imagePath ?? "", ".image") === imageName ||
    process.commandLine.includes(`${imageName}.image`)
  );
}

function launcherResultData<T>(result: LauncherCommandResult<T>): T | undefined {
  return result.ok ? result.data : undefined;
}

function assertLauncherOk(
  result: LauncherCommandResult | undefined,
  toolName: string,
): void {
  if (result && result.ok === false) {
    throw new Error(`${toolName} returned ok: false`);
  }
}

type LaunchOutcome =
  | { kind: "launch"; result: LauncherCommandResult | undefined }
  | { kind: "launchError"; error: unknown };

type StartupProcessOutcome =
  | { kind: "process"; process: LauncherProcess }
  | { kind: "exited"; process: LauncherProcess };

interface ImageLaunchRuntime {
  process: LauncherProcess;
  launcherResult: LauncherCommandResult | undefined;
}

class ImageStartupExitedBeforeHealthError extends Error {
  constructor(
    message: string,
    public readonly launcherResult: LauncherCommandResult | undefined,
    public readonly process: LauncherProcess,
  ) {
    super(message);
    this.name = "ImageStartupExitedBeforeHealthError";
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function imageMcpEndpointForImage(
  image: ProjectImageState,
): ProjectImageMcpEndpoint | undefined {
  return image.mcpServers?.find((server) => server.id === image.id)?.endpoint;
}

function hostForUrl(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function imageMcpEndpointUrl(endpoint: ProjectImageMcpEndpoint): string {
  return `http://${hostForUrl(endpoint.host)}:${endpoint.port}${endpoint.path}`;
}

function jsonRpcErrorText(value: unknown): string {
  if (isObject(value) && typeof value.message === "string") {
    return value.message;
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

class HttpStartProjectImageMcpClient implements StartProjectImageMcpClient {
  constructor(
    private readonly fetchFn: typeof fetch = fetch,
    private readonly timeoutMs = 60_000,
  ) {}

  async callTool(
    image: ProjectImageState,
    toolName: string,
    argumentsValue: Record<string, unknown>,
  ): Promise<unknown> {
    const endpoint = imageMcpEndpointForImage(image);
    if (!endpoint) {
      throw new Error(`Image ${image.id} has no routable Pharo MCP endpoint`);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchFn(imageMcpEndpointUrl(endpoint), {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: `plexus-open-${image.id}-${Date.now()}`,
          method: "tools/call",
          params: {
            name: toolName,
            arguments: argumentsValue,
          },
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`MCP tools/call failed with HTTP ${response.status}`);
      }

      const payload = (await response.json()) as unknown;
      if (!isObject(payload)) {
        throw new Error("MCP tools/call response was not a JSON object");
      }

      if ("error" in payload) {
        throw new Error(`MCP error ${jsonRpcErrorText(payload.error)}`);
      }

      if (!("result" in payload)) {
        throw new Error("MCP tools/call response did not include a result");
      }

      return payload.result;
    } finally {
      clearTimeout(timeout);
    }
  }
}



function logPathFromLine(line: string): string | undefined {
  const separator = line.indexOf(":");
  if (separator < 0) {
    return undefined;
  }

  const key = line.slice(0, separator).trim().toLowerCase();
  if (key !== "stdout" && key !== "stderr" && key !== "log" && key !== "logpath") {
    return undefined;
  }

  const value = line.slice(separator + 1).trim();
  return value.length > 0 ? value : undefined;
}

function logPathsFromText(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map(logPathFromLine)
    .filter((path): path is string => Boolean(path));
}

function profileScopedImagePidFromText(value: string): number | undefined {
  const match = value.match(
    /\bDetached\s+profile-scoped\s+Pharo\s+image\s+pid\s+(\d+)\b/i,
  );
  if (!match) {
    return undefined;
  }

  return Number.parseInt(match[1], 10);
}

function launcherPidFromValue(
  value: unknown,
  fieldName?: string,
): number | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    const normalizedFieldName = fieldName?.toLowerCase() ?? "";
    return normalizedFieldName === "pid" || normalizedFieldName === "processid"
      ? value
      : undefined;
  }

  if (typeof value === "string") {
    const normalizedFieldName = fieldName?.toLowerCase() ?? "";
    if (normalizedFieldName === "pid" || normalizedFieldName === "processid") {
      const parsed = Number.parseInt(value, 10);
      return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
    }

    return profileScopedImagePidFromText(value);
  }

  if (!isObject(value)) {
    return undefined;
  }

  for (const [key, fieldValue] of Object.entries(value)) {
    const pid = launcherPidFromValue(fieldValue, key);
    if (pid !== undefined) {
      return pid;
    }
  }

  return undefined;
}

function launcherProcessFromResult(
  result: LauncherCommandResult | undefined,
  imageName: string,
): LauncherProcess | undefined {
  const pid = launcherPidFromValue(result);
  if (pid === undefined) {
    return undefined;
  }

  return {
    pid,
    imageName,
    commandLine: `pharo_launcher_image_start ${imageName}`,
  };
}

function collectLauncherLogPaths(
  value: unknown,
  fieldName?: string,
): string[] {
  if (typeof value === "string") {
    if (value.length === 0) {
      return [];
    }

    const paths = logPathsFromText(value);
    if (paths.length > 0) {
      return paths;
    }

    const normalizedFieldName = fieldName?.toLowerCase() ?? "";
    return normalizedFieldName.includes("log") ||
      normalizedFieldName.includes("stdout") ||
      normalizedFieldName.includes("stderr")
      ? [value]
      : [];
  }

  if (!isObject(value)) {
    return [];
  }

  const paths: string[] = [];
  for (const [key, fieldValue] of Object.entries(value)) {
    paths.push(...collectLauncherLogPaths(fieldValue, key));
  }

  return [...new Set(paths)];
}

function startupFailureDetails(
  error: unknown,
): Pick<StartProjectImageFailure, "launcherToolName" | "launcherResult" | "process"> {
  if (!(error instanceof ImageStartupExitedBeforeHealthError)) {
    return {};
  }

  return {
    launcherToolName: "pharo_launcher_image_start",
    launcherResult: error.launcherResult,
    process: error.process,
  };
}





function parseStatusProperties(filePath: string): Record<string, string> {
  return Object.fromEntries(
    fs
      .readFileSync(filePath, "utf8")
      .split(/\r\n|\n|\r/)
      .map((line): [string, string] | undefined => {
        if (!line || line.startsWith("#")) {
          return undefined;
        }

        const separator = line.indexOf("=");
        if (separator <= 0) {
          return undefined;
        }

        return [line.slice(0, separator), line.slice(separator + 1)];
      })
      .filter((entry): entry is [string, string] => entry !== undefined),
  );
}

function clearPharoMcpLoadStatus(
  imageState: ProjectImageState,
  statusPath: string | undefined,
): void {
  if (!statusPath) {
    return;
  }

  fs.rmSync(statusPath, { force: true });
  delete imageState.pharoMcpLoad;
}

function clearDependencyRepositoryDetachStatus(
  imageState: ProjectImageState,
  statusPath: string | undefined,
): void {
  if (!statusPath) {
    return;
  }

  fs.rmSync(statusPath, { force: true });
  delete imageState.dependencyRepositoryDetach;
}

function pharoMcpLoadStatusDetails(
  properties: Record<string, string>,
  statusPath: string,
) {
  return {
    statusPath,
    ...(properties.source ? { source: properties.source } : {}),
    ...(properties.loadScript ? { loadScript: properties.loadScript } : {}),
    ...(properties.loadPolicy ? { loadPolicy: properties.loadPolicy } : {}),
    ...(properties.repository ? { repository: properties.repository } : {}),
    ...(properties.configuredRepositoryHint
      ? { configuredRepositoryHint: properties.configuredRepositoryHint }
      : {}),
    ...(properties.baseline ? { baseline: properties.baseline } : {}),
  };
}

// An MCP the image already had is the project's own when the base the image
// was copied from loaded what the project loads now. Without a recorded base,
// nothing says what the image holds, and this says nothing either.
function preparedBaseOf(
  imageState: ProjectImageState,
  loadNow: HomeImageCachePharoMcpLoad | undefined,
) {
  const loaded = imageState.homeImageCacheBase?.pharoMcpLoad;
  if (!loaded || !loadNow) {
    return undefined;
  }
  return sameHomeImageCachePharoMcpLoad(loaded, loadNow) ? "current" : "outdated";
}

function refreshPharoMcpLoadStatus(
  imageState: ProjectImageState,
  statusPath: string | undefined,
  loadNow?: HomeImageCachePharoMcpLoad,
): string | undefined {
  if (!statusPath || !fs.existsSync(statusPath)) {
    return undefined;
  }

  const properties = parseStatusProperties(statusPath);
  const status = properties.status;
  const details = pharoMcpLoadStatusDetails(properties, statusPath);

  if (status === "provided" || status === "loaded") {
    const preparedBase =
      status === "provided" ? preparedBaseOf(imageState, loadNow) : undefined;
    imageState.pharoMcpLoad = {
      state: status,
      ...details,
      ...(preparedBase ? { preparedBase } : {}),
    };
    return undefined;
  }

  if (status === "failed") {
    const message =
      properties.message ?? "Pharo MCP load failed without a reported message.";
    imageState.pharoMcpLoad = {
      state: "failed",
      ...details,
      error: message,
    };
    return `Pharo MCP load failed for image ${imageState.id}: ${message}`;
  }

  const message = `Invalid Pharo MCP load status at ${statusPath}: ${status ?? "(missing)"}`;
  imageState.pharoMcpLoad = {
    state: "failed",
    ...details,
    error: message,
  };
  return message;
}

function dependencyRepositoryDetachRepositories(
  properties: Record<string, string>,
): Array<{ location: string; name?: string }> {
  const byIndex = new Map<number, { location?: string; name?: string }>();
  for (const [key, value] of Object.entries(properties)) {
    const match = /^repository\.(\d+)\.(name|location)$/.exec(key);
    if (!match) {
      continue;
    }

    const index = Number.parseInt(match[1], 10);
    const entry = byIndex.get(index) ?? {};
    entry[match[2] as "name" | "location"] = value;
    byIndex.set(index, entry);
  }

  return [...byIndex.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, entry]) => entry)
    .filter((entry): entry is { location: string; name?: string } =>
      Boolean(entry.location),
    )
    .map((entry) => ({
      location: entry.location,
      ...(entry.name ? { name: entry.name } : {}),
    }));
}

function dependencyRepositoryDetachCount(
  properties: Record<string, string>,
  repositories: readonly unknown[],
): number {
  const parsed = Number.parseInt(properties.detachedCount ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : repositories.length;
}

function refreshDependencyRepositoryDetachStatus(
  imageState: ProjectImageState,
  statusPath: string | undefined,
): string | undefined {
  if (!statusPath || !fs.existsSync(statusPath)) {
    return undefined;
  }

  const properties = parseStatusProperties(statusPath);
  const status = properties.status;
  const repositories = dependencyRepositoryDetachRepositories(properties);
  const details = {
    statusPath,
    ...(properties.cachePath ? { cachePath: properties.cachePath } : {}),
    detachedCount: dependencyRepositoryDetachCount(properties, repositories),
    repositories,
    ...(properties.message ? { message: properties.message } : {}),
  };

  if (status === "detached" || status === "skipped") {
    imageState.dependencyRepositoryDetach = {
      state: status,
      ...details,
    };
    return undefined;
  }

  if (status === "failed") {
    const message =
      properties.message ??
      "Dependency repository detach failed without a reported message.";
    imageState.dependencyRepositoryDetach = {
      state: "failed",
      ...details,
      error: message,
    };
    return `Dependency repository detach failed for image ${imageState.id}: ${message}`;
  }

  const message = `Invalid dependency repository detach status at ${statusPath}: ${status ?? "(missing)"}`;
  imageState.dependencyRepositoryDetach = {
    state: "failed",
    ...details,
    error: message,
  };
  return message;
}

async function pollUntil<T>(
  timeoutMs: number,
  intervalMs: number,
  sleep: (durationMs: number) => Promise<void>,
  attempt: () => Promise<T | undefined>,
): Promise<T | undefined> {
  const startedAt = Date.now();

  while (Date.now() - startedAt <= timeoutMs) {
    const result = await attempt();
    if (result !== undefined) {
      return result;
    }

    await sleep(intervalMs);
  }

  return undefined;
}

async function pollProcessForImage(
  client: PharoLauncherMcpToolClient,
  imageName: string,
  timeoutMs: number,
  intervalMs: number,
  sleep: (durationMs: number) => Promise<void>,
): Promise<LauncherProcess | undefined> {
  return pollUntil(timeoutMs, intervalMs, sleep, async () => {
    return processForImage(client, imageName);
  });
}

async function pollStartupProcessForImage(
  client: PharoLauncherMcpToolClient,
  imageName: string,
  launchedProcess: () => LauncherProcess | undefined,
  timeoutMs: number,
  intervalMs: number,
  sleep: (durationMs: number) => Promise<void>,
): Promise<StartupProcessOutcome | undefined> {
  return pollUntil(timeoutMs, intervalMs, sleep, async () => {
    const process = await processForImage(client, imageName);
    if (process) {
      return { kind: "process", process };
    }

    const knownLaunchedProcess = launchedProcess();
    if (knownLaunchedProcess && !isPidAlive(knownLaunchedProcess.pid)) {
      return { kind: "exited", process: knownLaunchedProcess };
    }

    if (knownLaunchedProcess) {
      return { kind: "process", process: knownLaunchedProcess };
    }

    return undefined;
  });
}

/**
 * Every VM the host has on this image, ours or not. PLexus owns at most one of
 * them, so the rest are only ever read — to refuse a launch that would make a
 * second, and to name what is in the way.
 */
export async function processesForImage(
  client: PharoLauncherMcpToolClient,
  imageName: string,
): Promise<LauncherProcess[]> {
  return processesOnImage(await hostPharoProcesses(client), imageName);
}

/**
 * Every Pharo VM the host is running, asked once. A caller with several images
 * to answer for asks this and matches locally, rather than asking the host per
 * image.
 */
export async function hostPharoProcesses(
  client: PharoLauncherMcpToolClient,
): Promise<LauncherProcess[]> {
  const result = await client.callTool(
    "pharo_launcher_process_list",
    {},
  );
  assertLauncherOk(result, "pharo_launcher_process_list");

  return launcherResultData(result) ?? [];
}

/** Which of those VMs are on this image. One rule, used wherever it is asked. */
export function processesOnImage(
  processes: readonly LauncherProcess[],
  imageName: string,
): LauncherProcess[] {
  return processes.filter((process) =>
    processDirectlyMatchesImage(process, imageName),
  );
}

async function processForImage(
  client: PharoLauncherMcpToolClient,
  imageName: string,
): Promise<LauncherProcess | undefined> {
  return (await processesForImage(client, imageName))[0];
}

/**
 * Two VMs on one image file overwrite each other's saves, so a launch that
 * would make the second is refused rather than reported: reporting it would
 * mean an image has N runtimes, and every tool would need a pid to say which.
 */
export class ImageAlreadyRunningError extends Error {
  constructor(
    readonly imageName: string,
    readonly processes: readonly LauncherProcess[],
  ) {
    const pids = processes.map((process) => process.pid).join(", ");
    super(
      `Image ${imageName} is already running as pid ${pids}. ` +
        `Saving from two VMs on one image file overwrites the file, so PLexus ` +
        `will not start a second. Stop it with pharo_launcher_image_stop if ` +
        `PLexus started it, or end pid ${pids} yourself if something else did.`,
    );
    this.name = "ImageAlreadyRunningError";
  }
}

function processTimeoutError(imageName: string): Error {
  return new Error(
    `Timed out waiting for PharoLauncher process for image ${imageName}`,
  );
}

async function observeLaunchedProcess(options: {
  processClient: PharoLauncherMcpToolClient;
  imageName: string;
  launcherResult: LauncherCommandResult | undefined;
  timeoutMs: number;
  intervalMs: number;
  sleep: (durationMs: number) => Promise<void>;
}): Promise<LauncherProcess> {
  const launchedProcess = launcherProcessFromResult(
    options.launcherResult,
    options.imageName,
  );
  const outcome = await pollStartupProcessForImage(
    options.processClient,
    options.imageName,
    () => launchedProcess,
    options.timeoutMs,
    options.intervalMs,
    options.sleep,
  );

  if (outcome?.kind === "process") {
    return outcome.process;
  }

  if (outcome?.kind === "exited") {
    throw imageStartupExitedBeforeProcessObservedError({
      imageName: options.imageName,
      launcherResult: options.launcherResult,
      process: outcome.process,
    });
  }

  throw processTimeoutError(options.imageName);
}

async function pollEndpointHealth(
  healthClient: PharoMcpHealthClient,
  endpoint: ProjectImageMcpEndpoint,
): Promise<boolean> {
  if (healthClient.checkEndpoint) {
    return healthClient.checkEndpoint(endpoint);
  }

  return healthClient.check(endpoint.port);
}

type ImageMcpReadiness =
  | { kind: "endpoint"; endpoint: ProjectImageMcpEndpoint }
  | { kind: "loadFailed"; message: string }
  | { kind: "processExited" };

interface PollPharoMcpReadinessOptions {
  imageState: ProjectImageState;
  endpointHandoffPath: string;
  healthClient: PharoMcpHealthClient;
  processClient?: PharoLauncherMcpToolClient;
  imageName?: string;
  launchedProcess?: LauncherProcess;
  pharoMcpLoadStatusPath?: string;
  failOnLoadFailure: boolean;
  timeoutMs: number;
  intervalMs: number;
  sleep: (durationMs: number) => Promise<void>;
}

function pharoMcpLoadFailureReadiness(
  options: PollPharoMcpReadinessOptions,
): ImageMcpReadiness | undefined {
  const loadFailure = refreshPharoMcpLoadStatus(
    options.imageState,
    options.pharoMcpLoadStatusPath,
  );
  if (!loadFailure) {
    return undefined;
  }

  if (options.failOnLoadFailure) {
    throw new Error(loadFailure);
  }
  return { kind: "loadFailed", message: loadFailure };
}

async function endpointHandoffReadiness(
  options: PollPharoMcpReadinessOptions,
): Promise<ImageMcpReadiness | undefined> {
  const handoff = readImageMcpEndpointHandoff(options.endpointHandoffPath);
  if (handoff.status === "invalid") {
    throw new Error(
      `Invalid Pharo MCP endpoint handoff at ${handoff.path}: ${handoff.error}`,
    );
  }
  if (
    handoff.status === "valid" &&
    (await pollEndpointHealth(options.healthClient, handoff.endpoint))
  ) {
    return { kind: "endpoint", endpoint: handoff.endpoint };
  }

  return undefined;
}

async function processExitReadiness(
  options: PollPharoMcpReadinessOptions,
): Promise<ImageMcpReadiness | undefined> {
  if (!options.processClient || !options.imageName) {
    return undefined;
  }

  const process = await processForImage(options.processClient, options.imageName);
  if (process) {
    return undefined;
  }
  if (!options.launchedProcess) {
    return { kind: "processExited" };
  }
  if (!isPidAlive(options.launchedProcess.pid)) {
    return { kind: "processExited" };
  }

  return undefined;
}

async function pollPharoMcpReadiness(
  options: PollPharoMcpReadinessOptions,
): Promise<ImageMcpReadiness | undefined> {
  return pollUntil(
    options.timeoutMs,
    options.intervalMs,
    options.sleep,
    async () => {
      const loadFailure = pharoMcpLoadFailureReadiness(options);
      if (loadFailure) {
        return loadFailure;
      }

      const handoff = await endpointHandoffReadiness(options);
      if (handoff) {
        return handoff;
      }

      return processExitReadiness(options);
    },
  );
}

async function launchImageAndPollProcess(
  launchClient: PharoLauncherMcpToolClient,
  processClient: PharoLauncherMcpToolClient,
  imageName: string,
  displayMode: ProjectImageDisplayMode,
  startupScriptPath: string,
  timeoutMs: number,
  intervalMs: number,
  sleep: (durationMs: number) => Promise<void>,
): Promise<ImageLaunchRuntime> {
  // Ask the host, not the record: a VM started from PharoLauncher or by another
  // agent counts just as much as one of ours.
  const running = await processesForImage(processClient, imageName);
  if (running.length > 0) {
    throw new ImageAlreadyRunningError(imageName, running);
  }

  const launchOutcome = launchClient
    .callTool("pharo_launcher_image_start", {
      imageName,
      detached: true,
      displayMode,
      script: startupScriptPath,
    })
    .then(
      (result): LaunchOutcome => ({ kind: "launch", result }),
      (error): LaunchOutcome => ({ kind: "launchError", error }),
    );
  const immediateLaunch = await Promise.race([
    launchOutcome,
    new Promise<undefined>((resolve) =>
      setTimeout(() => resolve(undefined), 0),
    ),
  ]);

  if (immediateLaunch?.kind === "launchError") {
    throw immediateLaunch.error;
  }

  if (immediateLaunch?.kind === "launch") {
    assertLauncherOk(
      immediateLaunch.result,
      "pharo_launcher_image_start",
    );

    return {
      process: await observeLaunchedProcess({
        processClient,
        imageName,
        launcherResult: immediateLaunch.result,
        timeoutMs,
        intervalMs,
        sleep,
      }),
      launcherResult: immediateLaunch.result,
    };
  }

  let launchedProcess: LauncherProcess | undefined;
  const processOutcome = pollStartupProcessForImage(
    processClient,
    imageName,
    () => launchedProcess,
    timeoutMs,
    intervalMs,
    sleep,
  );
  const first = await Promise.race([launchOutcome, processOutcome]);

  if (!first) {
    throw processTimeoutError(imageName);
  }

  if (first.kind === "launchError") {
    throw first.error;
  }

  if (first.kind === "launch") {
    assertLauncherOk(first.result, "pharo_launcher_image_start");
    launchedProcess = launcherProcessFromResult(first.result, imageName);

    const outcome = await processOutcome;
    if (outcome?.kind === "process") {
      return { process: outcome.process, launcherResult: first.result };
    }

    if (outcome?.kind === "exited") {
      throw imageStartupExitedBeforeProcessObservedError({
        imageName,
        launcherResult: first.result,
        process: outcome.process,
      });
    }

    throw processTimeoutError(imageName);
  }

  if (first.kind === "process") {
    return { process: first.process, launcherResult: undefined };
  }

  throw imageStartupExitedBeforeProcessObservedError({
    imageName,
    launcherResult: undefined,
    process: first.process,
  });
}

function imageStartupExitedBeforeProcessObservedError(options: {
  imageName: string;
  launcherResult: LauncherCommandResult | undefined;
  process: LauncherProcess;
}): ImageStartupExitedBeforeHealthError {
  const logPaths = collectLauncherLogPaths(options.launcherResult);
  const logHint =
    logPaths.length > 0 ? `. Launcher logs: ${logPaths.join(", ")}` : "";

  return new ImageStartupExitedBeforeHealthError(
    `Image ${options.imageName} process ${options.process.pid} exited before PLexus observed the launcher process${logHint}`,
    options.launcherResult,
    options.process,
  );
}

function imageStartupExitedBeforeHealthError(options: {
  imageName: string;
  endpointHandoffPath: string;
  launcherResult: LauncherCommandResult | undefined;
  process: LauncherProcess;
}): ImageStartupExitedBeforeHealthError {
  const logPaths = collectLauncherLogPaths(options.launcherResult);
  const logHint =
    logPaths.length > 0 ? `. Launcher logs: ${logPaths.join(", ")}` : "";

  return new ImageStartupExitedBeforeHealthError(
    `Image ${options.imageName} process ${options.process.pid} exited before Pharo MCP became healthy or wrote its endpoint to ${options.endpointHandoffPath}${logHint}`,
    options.launcherResult,
    options.process,
  );
}

/**
 * The image this call was asked to start. Starting is an action, so it takes
 * its subject from the request; a declaration no longer decides it.
 */
function imageToStart(
  state: ProjectState,
  imageId: string,
): ProjectImageState | undefined {
  const image = state.images.find((candidate) => candidate.id === imageId);
  if (image) {
    image.status = "starting";
  }

  return image;
}

function imageRequiresPharoMcpHealth(
  imageConfig: ProjectImageConfig,
  image: ProjectImageState,
): boolean {
  return (
    projectMcpStartupMode(imageConfig.mcp) === "required" &&
    image.pharoMcpContract?.status !== "unsupported"
  );
}

function imageCanRouteToPharoMcp(
  imageConfig: ProjectImageConfig,
  image: ProjectImageState,
): boolean {
  return (
    projectMcpStartupMode(imageConfig.mcp) !== "disabled" &&
    image.pharoMcpContract?.status !== "unsupported"
  );
}

function applyScopedImageSelection(
  state: ProjectState,
  previousState: ProjectState | undefined,
  imageId: string,
): void {
  state.images = state.images.filter((image) => {
    if (image.id === imageId) {
      return true;
    }

    const previousImage = previousState?.images.find(
      (candidate) => candidate.id === image.id,
    );
    // An image this open did not touch and nothing has created yet has no
    // runtime at all. Recording it as `stopped` would claim it exists, which
    // is how a created image that is not running reads, and would leave it
    // with no way back: creation refuses an id that already holds runtime
    // state, and nothing can start an image whose files were never made.
    if (!previousImage) {
      return false;
    }

    Object.assign(image, previousImage);
    return true;
  });
}

function previousImageState(
  previousState: ProjectState | undefined,
  imageId: string,
): ProjectImageState | undefined {
  return previousState?.images.find((image) => image.id === imageId);
}

// Whether the launcher already holds this image is the launcher's answer, not
// the record's: a state file left behind by an earlier config names an image id
// that no longer corresponds to any launcher image, and keying on the id alone
// then skips materialization for an image nothing ever created.
function launcherImageMaterialized(options: {
  imagesDirectory: string | undefined;
  previousState: ProjectState | undefined;
  imageState: ProjectImageState;
}): boolean {
  if (options.imagesDirectory === undefined) {
    return Boolean(previousImageState(options.previousState, options.imageState.id));
  }

  return fs.existsSync(
    joinPathLike(options.imagesDirectory, options.imageState.imageName),
  );
}

function shouldMaterializeImageFromHomeCache(options: {
  imagesDirectory: string | undefined;
  previousState: ProjectState | undefined;
  imageConfig: ProjectImageConfig;
  imageState: ProjectImageState;
  approval: HomeImageCacheMutationApproval | undefined;
}): boolean {
  return Boolean(
    options.approval &&
      projectImageCanUseHomeImageCache(options.imageConfig) &&
      !launcherImageMaterialized(options),
  );
}

interface StartProjectImageContext {
  options: StartProjectImageOptions;
  projectRoot: string;
  config: ProjectConfig;
  previousState: ProjectState | undefined;
  sourcePath: string | undefined;
  loadSourcePath: string;
  workspaceId: string;
  resolvedStateRoot: string | undefined;
  statePath: string;
  state: ProjectState;
  launcherProfileEnvironment: ReturnType<
    typeof pharoLauncherMcpProfileEnvironment
  >;
  client: PharoLauncherMcpToolClient;
  ownsClient: boolean;
  healthClient: PharoMcpHealthClient;
  imageMcpClient: StartProjectImageMcpClient;
  poll: Required<StartProjectImagePollOptions>;
  sleep: (durationMs: number) => Promise<void>;
  failures: StartProjectImageFailure[];
  now: () => Date;
}

interface ProjectImageStartSetup {
  displayMode: ProjectImageDisplayMode;
  endpointHandoffPath: string;
  pharoMcpLoadStatusPath?: string;
  /** What the project's configuration loads into this image now. */
  pharoMcpLoadNow?: HomeImageCachePharoMcpLoad;
  dependencyRepositoryDetachStatusPath?: string;
  startupScript: ReturnType<typeof writeProjectImageStartupScript>;
  launchClient: PharoLauncherMcpToolClient;
  ownsLaunchClient: boolean;
}

function resolveStartWorkspace(
  projectRoot: string,
  workspaceId: string | undefined,
): string {
  return workspaceId ? sanitizeRuntimeId(workspaceId) : defaultWorkspaceId(projectRoot);
}

function resolveStartSourcePath(options: {
  requestedSourcePath: string | undefined;
  projectRoot: string;
}): string | undefined {
  return options.requestedSourcePath
    ? path.resolve(options.requestedSourcePath)
    : undefined;
}

function applyProjectImageDisplayMode(
  imageConfig: ProjectImageConfig,
  imageState: ProjectImageState,
  displayMode: ProjectImageDisplayMode,
  requestedDisplayMode: ProjectImageDisplayMode | undefined,
): void {
  if (
    requestedDisplayMode !== undefined ||
    imageConfig.displayMode !== undefined ||
    imageState.displayMode !== undefined
  ) {
    imageState.displayMode = displayMode;
  }
}

async function materializeProjectImageForStart(
  context: StartProjectImageContext,
  imageConfig: ProjectImageConfig,
  imageState: ProjectImageState,
): Promise<void> {
  const existed = launcherImageMaterialized({
    imagesDirectory:
      context.launcherProfileEnvironment?.PHARO_LAUNCHER_MCP_IMAGES_DIR,
    previousState: context.previousState,
    imageState,
  });
  const homeMaterialization = shouldMaterializeImageFromHomeCache({
    imagesDirectory:
      context.launcherProfileEnvironment?.PHARO_LAUNCHER_MCP_IMAGES_DIR,
    previousState: context.previousState,
    imageConfig,
    imageState,
    approval: context.options.homeImageCacheApproval,
  })
    ? await materializeProjectImageFromHomeCache({
        runtimeClient: context.client,
        homeClient:
          context.options.homeImageCacheClient ??
          (context.options.pharoLauncherMcpClient ? context.client : undefined),
        projectRoot: context.projectRoot,
        config: context.config,
        imageConfig,
        imageState,
        workspaceId: context.workspaceId,
        stateRoot: context.resolvedStateRoot,
        approval: context.options.homeImageCacheApproval,
        now: context.now,
      })
    : undefined;

  // An image that existed keeps the base it was recorded with; one made now
  // records the base it was copied from, or that it was not copied from one.
  if (homeMaterialization || !existed) {
    recordHomeImageCacheBase(imageState, homeMaterialization);
  }

  if (!homeMaterialization) {
    await copyProjectImageFromPreparedCache({
      client: context.client,
      projectRoot: context.projectRoot,
      config: context.config,
      imageConfig,
      imageState,
      approval: context.options.preparedImageCacheApproval,
    });
  }

}

async function setupProjectImageForStart(
  context: StartProjectImageContext,
  imageConfig: ProjectImageConfig,
  imageState: ProjectImageState,
  displayMode: ProjectImageDisplayMode,
): Promise<ProjectImageStartSetup> {
  await materializeProjectImageForStart(context, imageConfig, imageState);

  const endpointHandoffPath = imageMcpEndpointHandoffPath({
    projectRoot: context.projectRoot,
    imageId: imageState.id,
    stateRoot: context.resolvedStateRoot,
  });
  removeImageMcpEndpointHandoff(endpointHandoffPath);
  delete imageState.mcpServers;

  const startupScript = writeProjectImageStartupScript({
    projectRoot: context.projectRoot,
    sourcePath: context.loadSourcePath,
    config: context.config,
    imageId: imageState.id,
    imageState,
    workspaceId: context.workspaceId,
    stateRoot: context.resolvedStateRoot,
  });
  clearPharoMcpLoadStatus(imageState, startupScript.pharoMcpLoadStatusPath);
  clearDependencyRepositoryDetachStatus(
    imageState,
    startupScript.dependencyRepositoryDetachStatusPath,
  );

  const launchClient = context.options.pharoLauncherMcpClient
    ? context.client
    : openPharoLauncherClient({
        profileEnvironment: context.launcherProfileEnvironment,
      });

  return {
    displayMode,
    endpointHandoffPath,
    pharoMcpLoadStatusPath: startupScript.pharoMcpLoadStatusPath,
    pharoMcpLoadNow: projectImagePharoMcpLoad({
      projectRoot: context.projectRoot,
      config: context.config,
      imageConfig,
    }),
    dependencyRepositoryDetachStatusPath:
      startupScript.dependencyRepositoryDetachStatusPath,
    startupScript,
    launchClient,
    ownsLaunchClient: !context.options.pharoLauncherMcpClient,
  };
}


function handlePharoMcpReadinessResult(options: {
  imageState: ProjectImageState;
  readiness: ImageMcpReadiness | undefined;
  endpointHandoffPath: string;
  requiresHealth: boolean;
  launchRuntime: ImageLaunchRuntime;
}): void {
  if (!options.readiness) {
    if (options.requiresHealth) {
      throw new Error(
        `Timed out waiting for Pharo MCP to write its endpoint to ${options.endpointHandoffPath}`,
      );
    }

    delete options.imageState.mcpServers;
    return;
  }

  if (options.readiness.kind === "processExited") {
    throw imageStartupExitedBeforeHealthError({
      imageName: options.imageState.imageName,
      endpointHandoffPath: options.endpointHandoffPath,
      launcherResult: options.launchRuntime.launcherResult,
      process: options.launchRuntime.process,
    });
  }

  if (options.readiness.kind === "loadFailed") {
    delete options.imageState.mcpServers;
  }

  if (options.readiness.kind === "endpoint") {
    options.imageState.mcpServers = [
      { id: options.imageState.id, endpoint: options.readiness.endpoint },
    ];
  }
}

async function routeProjectImageMcp(options: {
  context: StartProjectImageContext;
  imageConfig: ProjectImageConfig;
  imageState: ProjectImageState;
  setup: ProjectImageStartSetup;
  launchRuntime: ImageLaunchRuntime;
}): Promise<void> {
  if (!imageCanRouteToPharoMcp(options.imageConfig, options.imageState)) {
    return;
  }

  const requiresHealth = imageRequiresPharoMcpHealth(
    options.imageConfig,
    options.imageState,
  );
  const readiness = await pollPharoMcpReadiness({
    imageState: options.imageState,
    endpointHandoffPath: options.setup.endpointHandoffPath,
    healthClient: options.context.healthClient,
    processClient: options.context.client,
    imageName: options.imageState.imageName,
    launchedProcess: options.launchRuntime.process,
    pharoMcpLoadStatusPath: options.setup.pharoMcpLoadStatusPath,
    failOnLoadFailure: requiresHealth,
    timeoutMs: requiresHealth ? options.context.poll.healthTimeoutMs : 0,
    intervalMs: options.context.poll.intervalMs,
    sleep: options.context.sleep,
  });
  handlePharoMcpReadinessResult({
    imageState: options.imageState,
    readiness,
    endpointHandoffPath: options.setup.endpointHandoffPath,
    requiresHealth,
    launchRuntime: options.launchRuntime,
  });
}

function assertProjectImageLoadStatuses(options: {
  imageConfig: ProjectImageConfig;
  imageState: ProjectImageState;
  pharoMcpLoadStatusPath: string | undefined;
  pharoMcpLoadNow: HomeImageCachePharoMcpLoad | undefined;
  dependencyRepositoryDetachStatusPath: string | undefined;
}): void {
  const pharoMcpLoadFailure = refreshPharoMcpLoadStatus(
    options.imageState,
    options.pharoMcpLoadStatusPath,
    options.pharoMcpLoadNow,
  );
  if (
    pharoMcpLoadFailure &&
    imageRequiresPharoMcpHealth(options.imageConfig, options.imageState)
  ) {
    throw new Error(pharoMcpLoadFailure);
  }

  const detachFailure = refreshDependencyRepositoryDetachStatus(
    options.imageState,
    options.dependencyRepositoryDetachStatusPath,
  );
  if (detachFailure) {
    throw new Error(detachFailure);
  }
}

async function launchProjectImage(options: {
  context: StartProjectImageContext;
  imageConfig: ProjectImageConfig;
  imageState: ProjectImageState;
  setup: ProjectImageStartSetup;
}): Promise<void> {
  const { context, imageConfig, imageState, setup } = options;
  try {
    const launchRuntime = await launchImageAndPollProcess(
      setup.launchClient,
      context.client,
      imageState.imageName,
      setup.displayMode,
      setup.startupScript.filePath,
      context.poll.processTimeoutMs,
      context.poll.intervalMs,
      context.sleep,
    );
    const process = launchRuntime.process;
    imageState.pid = process.pid;
    await routeProjectImageMcp({
      context,
      imageConfig,
      imageState,
      setup,
      launchRuntime,
    });
    assertProjectImageLoadStatuses({
      imageConfig,
      imageState,
      pharoMcpLoadStatusPath: setup.pharoMcpLoadStatusPath,
      pharoMcpLoadNow: setup.pharoMcpLoadNow,
      dependencyRepositoryDetachStatusPath:
        setup.dependencyRepositoryDetachStatusPath,
    });
  } finally {
    if (setup.ownsLaunchClient) {
      closeClientQuietly(setup.launchClient);
    }
  }
}

async function recordProjectImageStartFailure(options: {
  context: StartProjectImageContext;
  imageState: ProjectImageState;
  setup: ProjectImageStartSetup | undefined;
  error: unknown;
}): Promise<void> {
  options.imageState.status = "failed";
  const pharoMcpLoadFailure = refreshPharoMcpLoadStatus(
    options.imageState,
    options.setup?.pharoMcpLoadStatusPath,
    options.setup?.pharoMcpLoadNow,
  );
  const detachFailure = refreshDependencyRepositoryDetachStatus(
    options.imageState,
    options.setup?.dependencyRepositoryDetachStatusPath,
  );
  options.context.failures.push({
    imageId: options.imageState.id,
    imageName: options.imageState.imageName,
    message:
      detachFailure ?? pharoMcpLoadFailure ??
      errorMessage(options.error),
    ...(detachFailure || pharoMcpLoadFailure
      ? {}
      : launcherFailureDetails(options.error)),
    ...(detachFailure || pharoMcpLoadFailure
      ? {}
      : startupFailureDetails(options.error)),
  });
}

async function startSelectedImage(
  context: StartProjectImageContext,
  imageState: ProjectImageState,
): Promise<void> {
  const imageConfig = context.config.images.find(
    (image) => image.id === imageState.id,
  );
  if (!imageConfig) {
    return;
  }

  const displayMode =
    context.options.displayMode ?? projectImageDisplayMode(imageConfig);
  applyProjectImageDisplayMode(
    imageConfig,
    imageState,
    displayMode,
    context.options.displayMode,
  );

  let setup: ProjectImageStartSetup | undefined;
  try {
    setup = await setupProjectImageForStart(
      context,
      imageConfig,
      imageState,
      displayMode,
    );
    await launchProjectImage({ context, imageConfig, imageState, setup });
    imageState.status = "running";
  } catch (error) {
    await recordProjectImageStartFailure({ context, imageState, setup, error });
  }
}

/**
 * Start one image the project declares. This is the operation: PLexus acts on
 * an image, named by the caller, and reports what happened to that image.
 */
export async function startProjectImage(
  options: StartProjectImageOptions,
): Promise<StartProjectImageResult> {
  const projectRoot = path.resolve(options.projectRoot);
  const config = loadProjectConfig(projectRoot);
  const workspaceId = resolveStartWorkspace(
    projectRoot,
    options.workspaceId,
  );
  const statePath = projectStatePath({
    projectRoot,
    stateRoot: options.stateRoot,
  });
  const resolvedStateRoot = options.stateRoot;
  const previousState = loadProjectState(statePath);
  const requestedSourcePath = options.sourcePath ?? previousState?.sourcePath;
  const sourcePath = resolveStartSourcePath({
    requestedSourcePath,
    projectRoot,
  });
  const loadSourcePath = sourcePath ?? projectRoot;
  const now = options.now ?? (() => new Date());
  const state = createProjectState(config, {
    updatedAt: now().toISOString(),
    previousState,
    workspaceId,
    sourcePath,
  });
  applyScopedImageSelection(state, previousState, options.imageId);
  const imageState = imageToStart(state, options.imageId);
  const failures: StartProjectImageFailure[] = [];

  // The project does not declare this image, so there is nothing to start and
  // nothing to report about it beyond the state as it stands.
  if (!imageState) {
    state.runtimeStatus = runtimeStatusForImages(state.images);
    state.updatedAt = now().toISOString();
    saveProjectState(statePath, state);

    return {
      ok: true,
      projectRoot,
      statePath,
      state,
      failures,
    };
  }

  const launcherProfileEnvironment = pharoLauncherMcpProfileEnvironment({
    projectRoot,
    config,
    workspaceId,
    stateRoot: resolvedStateRoot,
  });
  const client =
    options.pharoLauncherMcpClient ??
    openPharoLauncherClient({
      profileEnvironment: launcherProfileEnvironment,
    });
  const ownsClient = !options.pharoLauncherMcpClient;
  const healthClient =
    options.healthClient ?? new HttpPharoMcpHealthClient();
  const imageMcpClient =
    options.imageMcpClient ?? new HttpStartProjectImageMcpClient();
  const poll = {
    intervalMs: options.poll?.intervalMs ?? 500,
    processTimeoutMs: options.poll?.processTimeoutMs ?? 30_000,
    healthTimeoutMs: options.poll?.healthTimeoutMs ?? 5 * 60_000,
  };
  const sleep = options.sleep ?? defaultSleep;
  const context: StartProjectImageContext = {
    options,
    projectRoot,
    config,
    previousState,
    sourcePath,
    loadSourcePath,
    workspaceId,
    resolvedStateRoot,
    statePath,
    state,
    launcherProfileEnvironment,
    client,
    ownsClient,
    healthClient,
    imageMcpClient,
    poll,
    sleep,
    failures,
    now,
  };

  try {
    await startSelectedImage(context, imageState);
    state.runtimeStatus = runtimeStatusForImages(state.images);
    state.updatedAt = now().toISOString();
    saveProjectState(statePath, state);

    const result: StartProjectImageResult = {
      ok: failures.length === 0,
      projectRoot,
      statePath,
      state,
      failures,
    };
    if (!result.ok) {
      // One image, so one failure, and its message is the one a caller can
      // act on. An aggregate sentence here said nothing and hid that.
      throw new StartProjectImageError(failures[0].message, result);
    }
    return result;
  } finally {
    if (context.ownsClient) {
      await client.close?.();
    }
  }
}
