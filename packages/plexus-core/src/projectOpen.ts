import fs from "node:fs";
import path from "node:path";
import {
  loadProjectConfig,
  projectImageDisplayMode,
  projectConfigId,
  projectMcpStartupMode,
  resolveProjectRuntimePolicy,
  type ProjectImageDisplayMode,
  type ProjectImageConfig,
} from "./projectConfig.js";
import {
  dirnamePathLike,
  isAbsolutePathLike,
  joinPathLike,
  resolvePathLike,
} from "./pathStyle.js";
import {
  defaultImagePortClaimChecks,
  imagePortClaimsRootForConfig,
  prepareImagePortClaims,
  recordImagePortClaimProcess,
  releaseImagePortClaimIfOwned,
  releasePreparedImagePortClaims,
  type PreparedImagePortClaim,
} from "./imagePortClaims.js";
import {
  createStdioPharoLauncherMcpClient,
  PharoLauncherMcpToolError,
  type PharoLauncherMcpToolClient,
} from "./pharoLauncherMcpClient.js";
import {
  copyProjectImageFromPreparedCache,
  type PreparedImageCacheMutationApproval,
} from "./preparedImageCache.js";
import {
  materializeProjectImageFromHomeCache,
  projectImageCanUseHomeImageCache,
  type HomeImageCacheMutationApproval,
} from "./homeImageCache.js";
import { pharoLauncherMcpProfileEnvironment } from "./pharoLauncherProfile.js";
import {
  HttpPharoMcpHealthClient,
  type PharoMcpHealthClient,
} from "./pharoMcpHealth.js";
import {
  imageMcpEndpointHandoffPath,
  readImageMcpEndpointHandoff,
  removeImageMcpEndpointHandoff,
} from "./projectImageMcpEndpoint.js";
import {
  collectReservedProjectPortOwners,
  createProjectState,
  defaultWorkspaceId,
  loadProjectState,
  projectImageRepositoryWorkspaces,
  projectStatePathForConfig,
  projectStateRootForConfig,
  runtimeStatusForImages,
  sanitizeRuntimeId,
  saveProjectState,
  type ProjectImageMcpEndpoint,
  type ProjectImageRepositoryWorkspaceState,
  type ProjectImageState,
  type ProjectPortRange,
  type ProjectState,
} from "./projectState.js";
import { writeProjectImageStartupScript } from "./projectStartupScript.js";
import { materializeProjectImageRepositoryWorkspaces } from "./projectRepositoryWorkspace.js";
import type { PortClaimChecks } from "./portClaims.js";

export interface LauncherCommandResult<T = unknown> {
  ok: boolean;
  data?: T;
}

interface LauncherImageInfo {
  imagePath?: string;
  imageDirectoryPath?: string;
  changesPath?: string;
  localDirectoryPath?: string;
  ombuDirectoryPath?: string;
  pharoVersion?: string | number;
  vmId?: string;
  originTemplate?: {
    name?: string;
    url?: string;
  };
}

export interface LauncherProcess {
  pid: number;
  imageName?: string;
  imagePath?: string;
  commandLine: string;
}

export interface ProjectOpenPollOptions {
  intervalMs?: number;
  processTimeoutMs?: number;
  healthTimeoutMs?: number;
}

export interface ProjectOpenImageMcpClient {
  callTool(
    image: ProjectImageState,
    toolName: string,
    argumentsValue: Record<string, unknown>,
  ): Promise<unknown>;
}

export interface ProjectOpenOptions {
  projectRoot: string;
  sourcePath?: string;
  stateRoot?: string;
  workspaceId?: string;
  targetId?: string;
  imageIds?: string[];
  displayMode?: ProjectImageDisplayMode;
  pharoLauncherMcpClient?: PharoLauncherMcpToolClient;
  imageMcpClient?: ProjectOpenImageMcpClient;
  healthClient?: PharoMcpHealthClient;
  portRange?: ProjectPortRange;
  now?: () => Date;
  poll?: ProjectOpenPollOptions;
  sleep?: (durationMs: number) => Promise<void>;
  portClaimChecks?: PortClaimChecks;
  preparedImageCacheApproval?: PreparedImageCacheMutationApproval;
  homeImageCacheApproval?: HomeImageCacheMutationApproval;
  homeImageCacheClient?: PharoLauncherMcpToolClient;
}

export interface ProjectOpenFailure {
  imageId: string;
  imageName: string;
  message: string;
  launcherToolName?: string;
  launcherResult?: unknown;
  diagnostic?: string;
  action?: string;
  process?: LauncherProcess;
}

export interface ProjectOpenResult {
  ok: boolean;
  projectRoot: string;
  statePath: string;
  state: ProjectState;
  failures: ProjectOpenFailure[];
}

export class ProjectOpenError extends Error {
  constructor(
    message: string,
    public readonly result: ProjectOpenResult,
  ) {
    super(message);
    this.name = "ProjectOpenError";
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
  ProjectOpenFailure,
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
  if (image.mcpEndpoint) {
    return image.mcpEndpoint;
  }

  if (image.assignedPort !== undefined) {
    return {
      transport: "http",
      host: "127.0.0.1",
      port: image.assignedPort,
      path: "/",
    };
  }

  return undefined;
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

class HttpProjectOpenImageMcpClient implements ProjectOpenImageMcpClient {
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

function optionalStringField(
  value: Record<string, unknown>,
  key: string,
): string | undefined {
  return typeof value[key] === "string" && value[key].length > 0
    ? value[key]
    : undefined;
}

function launcherImageInfo(value: unknown): LauncherImageInfo | undefined {
  if (!isObject(value)) {
    return undefined;
  }

  const originTemplate = isObject(value.originTemplate)
    ? {
        ...(optionalStringField(value.originTemplate, "name")
          ? { name: optionalStringField(value.originTemplate, "name") }
          : {}),
        ...(optionalStringField(value.originTemplate, "url")
          ? { url: optionalStringField(value.originTemplate, "url") }
          : {}),
      }
    : undefined;
  const pharoVersion =
    typeof value.pharoVersion === "string" || typeof value.pharoVersion === "number"
      ? value.pharoVersion
      : undefined;

  return {
    imagePath: optionalStringField(value, "imagePath"),
    imageDirectoryPath: optionalStringField(value, "imageDirectoryPath"),
    changesPath: optionalStringField(value, "changesPath"),
    localDirectoryPath: optionalStringField(value, "localDirectoryPath"),
    ombuDirectoryPath: optionalStringField(value, "ombuDirectoryPath"),
    ...(pharoVersion !== undefined ? { pharoVersion } : {}),
    vmId: optionalStringField(value, "vmId"),
    ...(originTemplate ? { originTemplate } : {}),
  };
}

function logPathsFromText(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*(?:stdout|stderr|log(?:Path)?):\s*(.+?)\s*$/i)?.[1])
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
    commandLine: `pharo_launcher_image_launch ${imageName}`,
  };
}

function isPidAlive(pid: number): boolean {
  try {
    globalThis.process.kill(pid, 0);
    return true;
  } catch (error) {
    return isObject(error) && error.code === "ESRCH" ? false : true;
  }
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
): Pick<ProjectOpenFailure, "launcherToolName" | "launcherResult" | "process"> {
  if (!(error instanceof ImageStartupExitedBeforeHealthError)) {
    return {};
  }

  return {
    launcherToolName: "pharo_launcher_image_launch",
    launcherResult: error.launcherResult,
    process: error.process,
  };
}

function profileImagesDirectory(value: unknown): string | undefined {
  if (!isObject(value) || !isObject(value.profile) || !isObject(value.profile.imagesDir)) {
    return undefined;
  }

  return optionalStringField(value.profile.imagesDir, "path");
}

async function launcherImagesDirectory(
  client: PharoLauncherMcpToolClient,
): Promise<string | undefined> {
  const result =
    await client.callTool<LauncherCommandResult<Record<string, unknown>>>(
      "pharo_launcher_config",
      {},
    );
  assertLauncherOk(result, "pharo_launcher_config");
  return profileImagesDirectory(launcherResultData(result));
}

function normalizeImagePath(imagePath: string, imagesDirectory?: string): string {
  if (isAbsolutePathLike(imagePath)) {
    return resolvePathLike(imagePath);
  }

  return imagesDirectory ? joinPathLike(imagesDirectory, imagePath) : imagePath;
}

function applyLauncherImageInfo(
  imageState: ProjectImageState,
  info: LauncherImageInfo | undefined,
  imagesDirectory?: string,
): void {
  if (!info) {
    return;
  }

  const imagePath = info.imagePath
    ? normalizeImagePath(info.imagePath, imagesDirectory)
    : undefined;
  const imageDirectoryPath =
    info.imageDirectoryPath ??
    (imagePath ? dirnamePathLike(imagePath) : undefined);
  imageState.imagePath = imagePath ?? imageState.imagePath;
  imageState.imageDirectoryPath =
    imageDirectoryPath ?? imageState.imageDirectoryPath;
  imageState.changesPath =
    info.changesPath ??
    (imagePath ? imagePath.replace(/\.image$/i, ".changes") : imageState.changesPath);
  imageState.localDirectoryPath =
    info.localDirectoryPath ??
    (imageDirectoryPath
      ? joinPathLike(imageDirectoryPath, "pharo-local")
      : imageState.localDirectoryPath);
  imageState.ombuDirectoryPath =
    info.ombuDirectoryPath ??
    (imageDirectoryPath
      ? joinPathLike(imageDirectoryPath, "ombu")
      : imageState.ombuDirectoryPath);
  imageState.vmId = info.vmId ?? imageState.vmId;
  imageState.pharoVersion =
    info.pharoVersion !== undefined
      ? String(info.pharoVersion)
      : imageState.pharoVersion;
  imageState.originTemplate = info.originTemplate ?? imageState.originTemplate;
}

function applyLauncherProfileImagePathFallback(
  imageState: ProjectImageState,
  imagesDirectory: string | undefined,
): void {
  if (!imagesDirectory || !repositoryWorkspaceNeedsLauncherPaths(imageState)) {
    return;
  }

  const imageDirectoryPath = joinPathLike(imagesDirectory, imageState.imageName);
  const imagePath = joinPathLike(
    imageDirectoryPath,
    `${imageState.imageName}.image`,
  );
  if (!fs.existsSync(imagePath)) {
    return;
  }

  applyLauncherImageInfo(imageState, {
    imagePath,
    imageDirectoryPath,
    changesPath: joinPathLike(
      imageDirectoryPath,
      `${imageState.imageName}.changes`,
    ),
    localDirectoryPath: joinPathLike(imageDirectoryPath, "pharo-local"),
    ombuDirectoryPath: joinPathLike(imageDirectoryPath, "ombu"),
  });
}

function repositoryWorkspaceNeedsLauncherPaths(imageState: ProjectImageState): boolean {
  return (
    !imageState.localDirectoryPath &&
    projectImageRepositoryWorkspaces(imageState).some((workspace) =>
      workspace.path.startsWith("image-local://"),
    )
  );
}

function appendRepositoryWorkspaceDiagnostic(
  workspace: ProjectImageRepositoryWorkspaceState,
  message: string,
): void {
  if (workspace.diagnostics.includes(message)) {
    return;
  }

  workspace.diagnostics = [...workspace.diagnostics, message];
}

function repositoryWorkspaceSourcePath(
  workspace: ProjectImageRepositoryWorkspaceState,
): string {
  return workspace.loadSourcePath ?? joinPathLike(
    workspace.path,
    workspace.sourceDirectory,
  );
}

function inferTonelPackageNames(sourcePath: string): string[] {
  if (!fs.existsSync(sourcePath)) {
    return [];
  }

  return fs
    .readdirSync(sourcePath, { withFileTypes: true })
    .filter((entry) =>
      entry.isDirectory() &&
      fs.existsSync(joinPathLike(sourcePath, entry.name, "package.st"))
    )
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
}

function toolStructuredContent(result: unknown): Record<string, unknown> | undefined {
  if (!isObject(result) || !isObject(result.structuredContent)) {
    return undefined;
  }

  return result.structuredContent;
}

function toolTextContent(result: unknown): string | undefined {
  if (!isObject(result) || !Array.isArray(result.content)) {
    return undefined;
  }

  const item = result.content.find(
    (candidate): candidate is { type: "text"; text: string } =>
      isObject(candidate) &&
      candidate.type === "text" &&
      typeof candidate.text === "string",
  );
  return item?.text;
}

function toolErrorMessage(result: unknown, toolName: string): string {
  const structuredContent = toolStructuredContent(result);
  if (typeof structuredContent?.summary === "string") {
    return structuredContent.summary;
  }

  const text = toolTextContent(result);
  if (text) {
    return text;
  }

  return `${toolName} returned an error result`;
}

function assertToolResultOk(result: unknown, toolName: string): void {
  const structuredContent = toolStructuredContent(result);
  if (
    structuredContent?.status !== "error" &&
    (!isObject(result) || result.isError !== true)
  ) {
    return;
  }

  throw new Error(toolErrorMessage(result, toolName));
}

function toolResultData(result: unknown): Record<string, unknown> {
  const structuredContent = toolStructuredContent(result);
  if (isObject(structuredContent?.data)) {
    return structuredContent.data;
  }

  if (isObject(result) && isObject(result.data)) {
    return result.data;
  }

  return {};
}

function repositoryEntriesFromToolResult(result: unknown): Record<string, unknown>[] {
  const repositories = toolResultData(result).repositories;
  return Array.isArray(repositories)
    ? repositories.filter((entry): entry is Record<string, unknown> => isObject(entry))
    : [];
}

async function callImageMcpToolForOpen(options: {
  imageMcpClient: ProjectOpenImageMcpClient;
  imageState: ProjectImageState;
  toolName: string;
  argumentsValue: Record<string, unknown>;
}): Promise<unknown> {
  const result = await options.imageMcpClient.callTool(
    options.imageState,
    options.toolName,
    options.argumentsValue,
  );
  assertToolResultOk(result, options.toolName);
  return result;
}

async function callDiscoverableImageMcpToolForOpen(options: {
  imageMcpClient: ProjectOpenImageMcpClient;
  imageState: ProjectImageState;
  toolName: string;
  argumentsValue: Record<string, unknown>;
}): Promise<unknown> {
  return callImageMcpToolForOpen({
    imageMcpClient: options.imageMcpClient,
    imageState: options.imageState,
    toolName: "tool_call",
    argumentsValue: {
      toolName: options.toolName,
      arguments: options.argumentsValue,
    },
  });
}

function repositoryEntryName(
  entry: Record<string, unknown> | undefined,
  fallback: string,
): string {
  return typeof entry?.name === "string" && entry.name.length > 0
    ? entry.name
    : fallback;
}

function matchingRepositoryEntry(
  entries: Record<string, unknown>[],
  repositoryPath: string,
): Record<string, unknown> | undefined {
  return entries.find((entry) => entry.location === repositoryPath) ?? entries[0];
}

async function ensureRepositoryWorkspaceRegistered(options: {
  imageConfig: ProjectImageConfig;
  imageState: ProjectImageState;
  workspace: ProjectImageRepositoryWorkspaceState;
  imageMcpClient: ProjectOpenImageMcpClient;
}): Promise<void> {
  const workspace = options.workspace;
  if (!workspace || workspace.loadState !== "loaded") {
    return;
  }

  const endpoint = imageMcpEndpointForImage(options.imageState);
  if (!endpoint) {
    const message = `Repository workspace registration skipped for image ${options.imageState.id}: image has no routable Pharo MCP endpoint.`;
    workspace.registrationState = "skipped";
    workspace.registrationError = message;
    appendRepositoryWorkspaceDiagnostic(workspace, message);
    if (imageRequiresPharoMcpHealth(options.imageConfig, options.imageState)) {
      workspace.registrationState = "failed";
      throw new Error(message);
    }
    return;
  }

  if (!imageCanRouteToPharoMcp(options.imageConfig, options.imageState)) {
    const message = `Repository workspace registration skipped for image ${options.imageState.id}: Pharo MCP startup is disabled or unsupported.`;
    workspace.registrationState = "skipped";
    workspace.registrationError = message;
    appendRepositoryWorkspaceDiagnostic(workspace, message);
    return;
  }

  workspace.registrationState = "pending";
  delete workspace.registrationError;
  delete workspace.registeredRepositoryName;
  delete workspace.registeredPackageNames;

  const packageNames = inferTonelPackageNames(
    repositoryWorkspaceSourcePath(workspace),
  );
  const repositoryPath = workspace.path;
  const repositoryId = workspace.repository.id;

  try {
    const findResult = await callDiscoverableImageMcpToolForOpen({
      imageMcpClient: options.imageMcpClient,
      imageState: options.imageState,
      toolName: "repository_search",
      argumentsValue: {
        directoryPaths: [repositoryPath],
        limit: 1000,
      },
    });
    const existingRepository = matchingRepositoryEntry(
      repositoryEntriesFromToolResult(findResult),
      repositoryPath,
    );
    const repositoryName = repositoryEntryName(existingRepository, repositoryId);
    const repositoryArguments = {
      location: repositoryPath,
      subdirectory: workspace.sourceDirectory,
      packageNames,
    };

    if (existingRepository) {
      await callDiscoverableImageMcpToolForOpen({
        imageMcpClient: options.imageMcpClient,
        imageState: options.imageState,
        toolName: "repository_update",
        argumentsValue: {
          repositoryName,
          ...repositoryArguments,
        },
      });
    } else {
      await callDiscoverableImageMcpToolForOpen({
        imageMcpClient: options.imageMcpClient,
        imageState: options.imageState,
        toolName: "repository_attach",
        argumentsValue: {
          name: repositoryName,
          ...repositoryArguments,
        },
      });
    }

    await callDiscoverableImageMcpToolForOpen({
      imageMcpClient: options.imageMcpClient,
      imageState: options.imageState,
      toolName: "repository_identity_verify",
      argumentsValue: {
        repositoryName,
        ...repositoryArguments,
      },
    });

    workspace.registrationState = "registered";
    workspace.registeredRepositoryName = repositoryName;
    workspace.registeredPackageNames = packageNames;
  } catch (error) {
    const message = errorMessage(error);
    workspace.registrationState = "failed";
    workspace.registrationError = message;
    appendRepositoryWorkspaceDiagnostic(workspace, message);
    throw new Error(
      `Repository workspace registration failed for image ${options.imageState.id}: ${message}`,
    );
  }
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

function refreshPharoMcpLoadStatus(
  imageState: ProjectImageState,
  statusPath: string | undefined,
): string | undefined {
  if (!statusPath || !fs.existsSync(statusPath)) {
    return undefined;
  }

  const properties = parseStatusProperties(statusPath);
  const status = properties.status;
  const details = pharoMcpLoadStatusDetails(properties, statusPath);

  if (status === "provided" || status === "loaded") {
    imageState.pharoMcpLoad = {
      state: status,
      ...details,
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

function clearRepositoryWorkspaceLoadStatuses(
  statusPaths: Record<string, string> | undefined,
): void {
  if (!statusPaths) {
    return;
  }

  for (const statusPath of Object.values(statusPaths)) {
    fs.rmSync(statusPath, { force: true });
  }
}

function prepareRepositoryWorkspaceLoadStatuses(
  imageState: ProjectImageState,
  statusPaths: Record<string, string> | undefined,
): void {
  if (!statusPaths) {
    return;
  }

  for (const workspace of projectImageRepositoryWorkspaces(imageState)) {
    const statusPath = statusPaths[workspace.repository.id];
    if (!statusPath) {
      continue;
    }

    workspace.loadState = "pending";
    workspace.loadStatusPath = statusPath;
    workspace.loadSourcePath = joinPathLike(
      workspace.path,
      workspace.sourceDirectory,
    );
    delete workspace.loadError;
  }
}

function refreshRepositoryWorkspaceLoadStatus(
  imageState: ProjectImageState,
  workspace: ProjectImageRepositoryWorkspaceState,
): string | undefined {
  if (!workspace?.loadStatusPath) {
    return undefined;
  }

  if (!fs.existsSync(workspace.loadStatusPath)) {
    appendRepositoryWorkspaceDiagnostic(
      workspace,
      `Pharo project load has not reported status at ${workspace.loadStatusPath}.`,
    );
    return undefined;
  }

  const properties = parseStatusProperties(workspace.loadStatusPath);
  const status = properties.status;
  workspace.loadSourcePath = properties.sourcePath ?? workspace.loadSourcePath;
  if (properties.message) {
    workspace.loadError = properties.message;
  }

  if (status === "loaded") {
    workspace.loadState = "loaded";
    delete workspace.loadError;
    return undefined;
  }

  if (status === "failed") {
    workspace.loadState = "failed";
    workspace.loadError =
      properties.message ?? "Pharo project load failed without a reported message.";
    appendRepositoryWorkspaceDiagnostic(workspace, workspace.loadError);
    return `Pharo project load failed for image ${imageState.id}: ${workspace.loadError}`;
  }

  workspace.loadState = "failed";
  workspace.loadError = `Invalid Pharo project load status at ${workspace.loadStatusPath}: ${status ?? "(missing)"}`;
  appendRepositoryWorkspaceDiagnostic(workspace, workspace.loadError);
  return workspace.loadError;
}

function refreshRepositoryWorkspaceLoadStatuses(
  imageState: ProjectImageState,
): string | undefined {
  let firstFailure: string | undefined;
  for (const workspace of projectImageRepositoryWorkspaces(imageState)) {
    const failure = refreshRepositoryWorkspaceLoadStatus(imageState, workspace);
    firstFailure ??= failure;
  }
  return firstFailure;
}

async function hydrateRepositoryWorkspaceImagePaths(
  client: PharoLauncherMcpToolClient,
  imageState: ProjectImageState,
  fallbackImagesDirectory?: string,
): Promise<void> {
  if (!repositoryWorkspaceNeedsLauncherPaths(imageState)) {
    return;
  }

  const infoResult = await client.callTool<LauncherCommandResult>(
    "pharo_launcher_image_info",
    {
      imageName: imageState.imageName,
    },
  );
  assertLauncherOk(infoResult, "pharo_launcher_image_info");
  const info = launcherImageInfo(launcherResultData(infoResult));
  const imagesDirectory =
    info?.imagePath && !isAbsolutePathLike(info.imagePath)
      ? await launcherImagesDirectory(client)
      : undefined;
  applyLauncherImageInfo(imageState, info, imagesDirectory);
  applyLauncherProfileImagePathFallback(imageState, fallbackImagesDirectory);
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

async function processForImage(
  client: PharoLauncherMcpToolClient,
  imageName: string,
): Promise<LauncherProcess | undefined> {
  const result = await client.callTool<LauncherCommandResult<LauncherProcess[]>>(
    "pharo_launcher_process_list",
    {},
  );
  assertLauncherOk(result, "pharo_launcher_process_list");
  const processes = launcherResultData(result) ?? [];

  return processes.find((process) =>
    processDirectlyMatchesImage(process, imageName),
  );
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
  | { kind: "assignedPort"; port: number }
  | { kind: "loadFailed"; message: string }
  | { kind: "processExited" };

async function pollPharoMcpReadiness(options: {
  imageState: ProjectImageState;
  endpointHandoffPath: string;
  preferEndpointHandoff: boolean;
  healthClient: PharoMcpHealthClient;
  processClient?: PharoLauncherMcpToolClient;
  imageName?: string;
  launchedProcess?: LauncherProcess;
  pharoMcpLoadStatusPath?: string;
  failOnLoadFailure: boolean;
  timeoutMs: number;
  intervalMs: number;
  sleep: (durationMs: number) => Promise<void>;
}): Promise<ImageMcpReadiness | undefined> {
  return pollUntil(
    options.timeoutMs,
    options.intervalMs,
    options.sleep,
    async () => {
      const loadFailure = refreshPharoMcpLoadStatus(
        options.imageState,
        options.pharoMcpLoadStatusPath,
      );
      if (loadFailure) {
        if (options.failOnLoadFailure) {
          throw new Error(loadFailure);
        }

        return { kind: "loadFailed", message: loadFailure };
      }

      if (options.preferEndpointHandoff) {
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
      }

      if (
        options.imageState.assignedPort !== undefined &&
        (await options.healthClient.check(options.imageState.assignedPort))
      ) {
        return {
          kind: "assignedPort",
          port: options.imageState.assignedPort,
        };
      }

      if (options.processClient && options.imageName) {
        const process = await processForImage(
          options.processClient,
          options.imageName,
        );
        if (!process) {
          if (!options.launchedProcess) {
            return { kind: "processExited" };
          }

          if (!isPidAlive(options.launchedProcess.pid)) {
            return { kind: "processExited" };
          }
        }
      }

      return undefined;
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
  const launchOutcome = launchClient
    .callTool<LauncherCommandResult>("pharo_launcher_image_launch", {
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
      "pharo_launcher_image_launch",
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
    assertLauncherOk(first.result, "pharo_launcher_image_launch");
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
  assignedPort?: number;
  endpointHandoffPath: string;
  preferEndpointHandoff: boolean;
  launcherResult: LauncherCommandResult | undefined;
  process: LauncherProcess;
}): ImageStartupExitedBeforeHealthError {
  const endpointHint = options.preferEndpointHandoff
    ? ` or endpoint handoff at ${options.endpointHandoffPath}`
    : "";
  const portHint =
    options.assignedPort === undefined
      ? ""
      : ` on port ${options.assignedPort}`;
  const logPaths = collectLauncherLogPaths(options.launcherResult);
  const logHint =
    logPaths.length > 0 ? `. Launcher logs: ${logPaths.join(", ")}` : "";

  return new ImageStartupExitedBeforeHealthError(
    `Image ${options.imageName} process ${options.process.pid} exited before Pharo MCP became healthy${portHint}${endpointHint}${logHint}`,
    options.launcherResult,
    options.process,
  );
}

function activeStateImages(state: ProjectState): ProjectImageState[] {
  return state.images.filter((image) => image.status === "starting");
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

async function releaseOptionalPharoMcpRoute(options: {
  state: ProjectState;
  imageState: ProjectImageState;
  claimsRoot: string | undefined;
  checks: PortClaimChecks;
}): Promise<void> {
  if (options.claimsRoot && options.imageState.assignedPort !== undefined) {
    await releaseImagePortClaimIfOwned({
      state: options.state,
      image: options.imageState,
      claimsRoot: options.claimsRoot,
      checks: options.checks,
    });
  }

  delete options.imageState.assignedPort;
  delete options.imageState.mcpEndpoint;
}

function applyScopedImageSelection(
  state: ProjectState,
  previousState: ProjectState | undefined,
  imageIds: string[] | undefined,
): void {
  if (!imageIds) {
    return;
  }

  const selectedIds = new Set(imageIds);
  for (const image of state.images) {
    if (!selectedIds.has(image.id)) {
      const previousImage = previousState?.images.find(
        (candidate) => candidate.id === image.id,
      );
      if (previousImage) {
        Object.assign(image, previousImage);
      } else {
        image.status = "stopped";
      }
    }
  }
}

function previousImageState(
  previousState: ProjectState | undefined,
  imageId: string,
): ProjectImageState | undefined {
  return previousState?.images.find((image) => image.id === imageId);
}

function shouldMaterializeImageFromHomeCache(options: {
  previousState: ProjectState | undefined;
  imageConfig: ProjectImageConfig;
  imageState: ProjectImageState;
  approval: HomeImageCacheMutationApproval | undefined;
}): boolean {
  return Boolean(
    options.approval &&
      projectImageCanUseHomeImageCache(options.imageConfig) &&
      !previousImageState(options.previousState, options.imageState.id),
  );
}

export async function openProject(
  options: ProjectOpenOptions,
): Promise<ProjectOpenResult> {
  const projectRoot = path.resolve(options.projectRoot);
  const config = loadProjectConfig(projectRoot);
  const workspaceId = options.workspaceId
    ? sanitizeRuntimeId(options.workspaceId)
    : defaultWorkspaceId(projectRoot);
  const statePath = projectStatePathForConfig({
    projectRoot,
    config,
    workspaceId,
    stateRoot: options.stateRoot,
  });
  const resolvedStateRoot = projectStateRootForConfig(config, options.stateRoot);
  const previousState = loadProjectState(statePath);
  const requestedSourcePath = options.sourcePath ?? previousState?.sourcePath;
  const sourcePath = requestedSourcePath
    ? path.resolve(requestedSourcePath)
    : undefined;
  const loadSourcePath = sourcePath ?? projectRoot;
  const now = options.now ?? (() => new Date());
  const runtime = resolveProjectRuntimePolicy(config);
  const portRange = options.portRange ?? runtime.imagePorts.range;
  const claimsRoot = imagePortClaimsRootForConfig(projectRoot, config);
  const projectReservedOwners = collectReservedProjectPortOwners({
    projectRoot,
    projectId: projectConfigId(config),
    stateRoot: resolvedStateRoot,
    excludeWorkspaceId: workspaceId,
  });
  const state = createProjectState(config, {
    updatedAt: now().toISOString(),
    previousState,
    workspaceId,
    targetId: options.targetId,
    sourcePath,
    reservedPorts: claimsRoot
      ? []
      : projectReservedOwners.map((owner) => owner.port),
    portRange,
  });
  applyScopedImageSelection(state, previousState, options.imageIds);
  const imagesToOpen = activeStateImages(state);
  const failures: ProjectOpenFailure[] = [];

  if (imagesToOpen.length === 0) {
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

  const portClaimChecks =
    options.portClaimChecks ?? defaultImagePortClaimChecks();
  const launcherProfileEnvironment = pharoLauncherMcpProfileEnvironment({
    projectRoot,
    config,
    workspaceId,
    targetId: state.targetId,
    stateRoot: resolvedStateRoot,
  });
  let preparedPortClaims: PreparedImagePortClaim[] = [];
  if (claimsRoot) {
    preparedPortClaims = await prepareImagePortClaims({
      config,
      state,
      previousState,
      images: imagesToOpen,
      projectReservedOwners,
      claimsRoot,
      portRange,
      checks: portClaimChecks,
      now,
    });
  }

  const client =
    options.pharoLauncherMcpClient ??
    (await createStdioPharoLauncherMcpClient(undefined, {
      profileEnvironment: launcherProfileEnvironment,
    }));
  const ownsClient = !options.pharoLauncherMcpClient;
  const healthClient =
    options.healthClient ?? new HttpPharoMcpHealthClient();
  const imageMcpClient =
    options.imageMcpClient ?? new HttpProjectOpenImageMcpClient();
  const poll = {
    intervalMs: options.poll?.intervalMs ?? 500,
    processTimeoutMs: options.poll?.processTimeoutMs ?? 30_000,
    healthTimeoutMs: options.poll?.healthTimeoutMs ?? 5 * 60_000,
  };
  const sleep = options.sleep ?? defaultSleep;

  try {
    for (const imageState of imagesToOpen) {
      const imageConfig = config.images.find((image) => image.id === imageState.id);
      if (!imageConfig) {
        continue;
      }
      const displayMode = options.displayMode ?? projectImageDisplayMode(imageConfig);
      if (
        options.displayMode !== undefined ||
        imageConfig.displayMode !== undefined ||
        imageState.displayMode !== undefined
      ) {
        imageState.displayMode = displayMode;
      }
      let pharoMcpLoadStatusPath: string | undefined;
      let dependencyRepositoryDetachStatusPath: string | undefined;

      try {
        const homeMaterialization =
          shouldMaterializeImageFromHomeCache({
            previousState,
            imageConfig,
            imageState,
            approval: options.homeImageCacheApproval,
          })
            ? await materializeProjectImageFromHomeCache({
                runtimeClient: client,
                homeClient: options.homeImageCacheClient ??
                  (options.pharoLauncherMcpClient ? client : undefined),
                projectRoot,
                config,
                imageConfig,
                imageState,
                workspaceId,
                targetId: state.targetId,
                stateRoot: resolvedStateRoot,
                approval: options.homeImageCacheApproval,
                now,
              })
            : undefined;

        if (!homeMaterialization) {
          await copyProjectImageFromPreparedCache({
            client,
            projectRoot,
            config,
            imageConfig,
            imageState,
            approval: options.preparedImageCacheApproval,
          });
        }

        await hydrateRepositoryWorkspaceImagePaths(
          client,
          imageState,
          launcherProfileEnvironment?.PHARO_LAUNCHER_MCP_IMAGES_DIR,
        );
        materializeProjectImageRepositoryWorkspaces({
          projectRoot,
          imageConfig,
          imageState,
          sourcePath: loadSourcePath,
        });

        const endpointHandoffPath = imageMcpEndpointHandoffPath({
          projectRoot,
          projectId: state.projectId,
          workspaceId,
          imageId: imageState.id,
          stateRoot: resolvedStateRoot,
        });
        removeImageMcpEndpointHandoff(endpointHandoffPath);
        delete imageState.mcpEndpoint;

        const startupScript = writeProjectImageStartupScript({
          projectRoot,
          sourcePath: loadSourcePath,
          config,
          imageId: imageState.id,
          imageState,
          workspaceId,
          stateRoot: resolvedStateRoot,
        });
        pharoMcpLoadStatusPath = startupScript.pharoMcpLoadStatusPath;
        dependencyRepositoryDetachStatusPath =
          startupScript.dependencyRepositoryDetachStatusPath;
        clearPharoMcpLoadStatus(imageState, pharoMcpLoadStatusPath);
        clearDependencyRepositoryDetachStatus(
          imageState,
          dependencyRepositoryDetachStatusPath,
        );
        clearRepositoryWorkspaceLoadStatuses(
          startupScript.repositoryWorkspaceLoadStatusPaths,
        );
        prepareRepositoryWorkspaceLoadStatuses(
          imageState,
          startupScript.repositoryWorkspaceLoadStatusPaths,
        );

        const launchClient = options.pharoLauncherMcpClient
          ? client
          : await createStdioPharoLauncherMcpClient(undefined, {
              profileEnvironment: launcherProfileEnvironment,
            });
        const ownsLaunchClient = !options.pharoLauncherMcpClient;
        try {
          const launchRuntime = await launchImageAndPollProcess(
            launchClient,
            client,
            imageState.imageName,
            displayMode,
            startupScript.filePath,
            poll.processTimeoutMs,
            poll.intervalMs,
            sleep,
          );
          const process = launchRuntime.process;
          imageState.pid = process.pid;
          if (claimsRoot) {
            const preparedClaim = preparedPortClaims.find(
              (candidate) => candidate.imageId === imageState.id,
            );
            if (preparedClaim) {
              await recordImagePortClaimProcess({
                claimsRoot,
                preparedClaim,
                pid: process.pid,
                now,
              });
            }
          }

          if (imageCanRouteToPharoMcp(imageConfig, imageState)) {
            const preferEndpointHandoff = imageConfig.mcp.port === undefined;
            const requiresHealth = imageRequiresPharoMcpHealth(
              imageConfig,
              imageState,
            );
            const readiness = await pollPharoMcpReadiness({
              imageState,
              endpointHandoffPath,
              preferEndpointHandoff,
              healthClient,
              processClient: client,
              imageName: imageState.imageName,
              launchedProcess: process,
              pharoMcpLoadStatusPath,
              failOnLoadFailure: requiresHealth,
              timeoutMs: requiresHealth ? poll.healthTimeoutMs : 0,
              intervalMs: poll.intervalMs,
              sleep,
            });
            if (!readiness) {
              if (!requiresHealth) {
                await releaseOptionalPharoMcpRoute({
                  state,
                  imageState,
                  claimsRoot,
                  checks: portClaimChecks,
                });
                preparedPortClaims = preparedPortClaims.filter(
                  (candidate) => candidate.imageId !== imageState.id,
                );
              } else {
                const endpointHint = preferEndpointHandoff
                  ? ` or endpoint handoff at ${endpointHandoffPath}`
                  : "";
                const portHint =
                  imageState.assignedPort === undefined
                    ? ""
                    : ` on port ${imageState.assignedPort}`;
                throw new Error(
                  `Timed out waiting for Pharo MCP health${portHint}${endpointHint}`,
                );
              }
            }

            if (readiness?.kind === "processExited") {
              throw imageStartupExitedBeforeHealthError({
                imageName: imageState.imageName,
                assignedPort: imageState.assignedPort,
                endpointHandoffPath,
                preferEndpointHandoff,
                launcherResult: launchRuntime.launcherResult,
                process,
              });
            }

            if (readiness?.kind === "loadFailed") {
              await releaseOptionalPharoMcpRoute({
                state,
                imageState,
                claimsRoot,
                checks: portClaimChecks,
              });
              preparedPortClaims = preparedPortClaims.filter(
                (candidate) => candidate.imageId !== imageState.id,
              );
            }

            if (readiness?.kind === "endpoint") {
              imageState.mcpEndpoint = readiness.endpoint;
              if (claimsRoot && imageState.assignedPort !== undefined) {
                await releaseImagePortClaimIfOwned({
                  state,
                  image: imageState,
                  claimsRoot,
                  checks: portClaimChecks,
                });
                preparedPortClaims = preparedPortClaims.filter(
                  (candidate) => candidate.imageId !== imageState.id,
                );
              }
              delete imageState.assignedPort;
            }
          }
          const pharoMcpLoadFailure = refreshPharoMcpLoadStatus(
            imageState,
            pharoMcpLoadStatusPath,
          );
          if (
            pharoMcpLoadFailure &&
            imageRequiresPharoMcpHealth(imageConfig, imageState)
          ) {
            throw new Error(pharoMcpLoadFailure);
          }
          const loadFailure = refreshRepositoryWorkspaceLoadStatuses(imageState);
          if (loadFailure) {
            throw new Error(loadFailure);
          }
          const detachFailure = refreshDependencyRepositoryDetachStatus(
            imageState,
            dependencyRepositoryDetachStatusPath,
          );
          if (detachFailure) {
            throw new Error(detachFailure);
          }
          for (const workspace of projectImageRepositoryWorkspaces(imageState)) {
            await ensureRepositoryWorkspaceRegistered({
              imageConfig,
              imageState,
              workspace,
              imageMcpClient,
            });
          }
        } finally {
          if (ownsLaunchClient) {
            closeClientQuietly(launchClient);
          }
        }

        imageState.status = "running";
      } catch (error) {
        imageState.status = "failed";
        if (claimsRoot) {
          const claim = preparedPortClaims.find(
            (candidate) => candidate.imageId === imageState.id,
          );
          if (claim?.created) {
            await releasePreparedImagePortClaims(claimsRoot, [claim]);
            preparedPortClaims = preparedPortClaims.filter(
              (candidate) => candidate !== claim,
            );
          }
        }
        const pharoMcpLoadFailure = refreshPharoMcpLoadStatus(
          imageState,
          pharoMcpLoadStatusPath,
        );
        const loadFailure = refreshRepositoryWorkspaceLoadStatuses(imageState);
        const detachFailure = refreshDependencyRepositoryDetachStatus(
          imageState,
          dependencyRepositoryDetachStatusPath,
        );
        failures.push({
          imageId: imageState.id,
          imageName: imageState.imageName,
          message:
            detachFailure ??
            loadFailure ??
            pharoMcpLoadFailure ??
            errorMessage(error),
          ...(detachFailure || loadFailure || pharoMcpLoadFailure
            ? {}
            : launcherFailureDetails(error)),
          ...(detachFailure || loadFailure || pharoMcpLoadFailure
            ? {}
            : startupFailureDetails(error)),
        });
      }
    }

    state.runtimeStatus = runtimeStatusForImages(state.images);
    state.updatedAt = now().toISOString();
    saveProjectState(statePath, state);

    const result: ProjectOpenResult = {
      ok: failures.length === 0,
      projectRoot,
      statePath,
      state,
      failures,
    };

    if (!result.ok) {
      throw new ProjectOpenError("One or more project images failed to open", result);
    }

    return result;
  } finally {
    if (ownsClient) {
      await client.close?.();
    }
  }
}
