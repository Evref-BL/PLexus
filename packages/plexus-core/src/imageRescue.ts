import fs from "node:fs";
import path from "node:path";
import { loadProjectConfig, type ProjectImageConfig } from "./projectConfig.js";
import {
  createStdioPharoLauncherMcpClient,
  type PharoLauncherMcpToolClient,
} from "./pharoLauncherMcpClient.js";
import {
  HttpPharoMcpHealthClient,
  type PharoMcpHealthClient,
} from "./pharoMcpHealth.js";
import {
  defaultProjectPortRange,
  defaultWorkspaceId,
  loadProjectState,
  projectStatePathForConfig,
  sanitizeRuntimeId,
  saveProjectState,
  type ProjectImageState,
  type ProjectPortRange,
  type ProjectState,
} from "./projectState.js";
import { writeImageStartupScript } from "./projectStartupScript.js";
import type { LauncherCommandResult, LauncherProcess } from "./projectOpen.js";

const defaultPoll = {
  intervalMs: 500,
  processTimeoutMs: 30_000,
  healthTimeoutMs: 5 * 60_000,
} as const;

export type ImageRescueOperation =
  | "snapshotSource"
  | "plan"
  | "prepareTarget"
  | "applyPlan";

export type ImageRescueFailureClass =
  | "apply-time-breaker"
  | "runtime-breaker"
  | "unclassified";

export interface ImageRescueEntrySelection {
  indexes?: number[];
  entryReferences?: string[];
  startIndex?: number;
  endIndex?: number;
  latestCount?: number;
}

export interface ImageRescueRepositoryAction {
  label?: string;
  toolName?: "load_repository" | "edit_repository";
  arguments: Record<string, unknown>;
}

export interface ImageRescuePollOptions {
  intervalMs?: number;
  processTimeoutMs?: number;
  healthTimeoutMs?: number;
}

export interface ImageRescueOptions {
  operation: ImageRescueOperation;
  projectRoot: string;
  sourceImageId: string;
  stateRoot?: string;
  workspaceId?: string;
  targetImageId?: string;
  targetImageName?: string;
  targetTemplateName?: string;
  targetTemplateCategory?: string;
  targetMcpPort?: number;
  sourceHistoryDirectoryPath?: string;
  historyFilePath?: string;
  selection?: ImageRescueEntrySelection;
  exclude?: ImageRescueEntrySelection;
  codeChangesOnly?: boolean;
  includeEntryCounts?: boolean;
  loadRepositories?: boolean;
  repositoryActions?: ImageRescueRepositoryAction[];
  confirm?: boolean;
  pharoLauncherMcpClient?: PharoLauncherMcpToolClient;
  imageMcpClient?: ImageRescueMcpClient;
  healthClient?: PharoMcpHealthClient;
  portRange?: ProjectPortRange;
  now?: () => Date;
  poll?: ImageRescuePollOptions;
  sleep?: (durationMs: number) => Promise<void>;
}

export interface ImageRescueMcpClient {
  callTool(
    image: ProjectImageState,
    toolName: string,
    argumentsValue: Record<string, unknown>,
  ): Promise<unknown>;
}

export interface LauncherPathStatus {
  path: string;
  exists: boolean;
}

export interface LauncherConfigReport {
  launcherDir?: LauncherPathStatus;
  profile?: {
    imagesDir?: LauncherPathStatus;
  };
}

export interface LauncherImageInfo {
  name?: string;
  pharoVersion?: string;
  imagePath?: string;
  originTemplate?: {
    name?: string;
    url?: string;
  };
  vmId?: string;
}

export interface ResolvedImagePaths {
  imagePath?: string;
  imageDirectoryPath?: string;
  changesPath?: string;
  localDirectoryPath?: string;
  ombuDirectoryPath?: string;
}

export interface ImageRescueRepositorySnapshot {
  capturedAt: string;
  status: "captured" | "unavailable";
  repositories: Record<string, unknown>[];
  error?: string;
}

export interface ImageRescueSourceSnapshot {
  capturedAt: string;
  launcherImage?: LauncherImageInfo;
  paths: ResolvedImagePaths;
  repositories?: ImageRescueRepositorySnapshot;
}

export interface ImageRescueHistoryFile {
  path: string;
  mtimeMs?: number;
  size?: number;
}

export interface ImageRescueRepositoryResult {
  label: string;
  toolName: string;
  arguments: Record<string, unknown>;
  status: "planned" | "applied" | "skipped" | "failed";
  result?: unknown;
  error?: string;
}

export interface ImageRescueChangeResult {
  historyFilePath: string;
  arguments: Record<string, unknown>;
  status: "planned" | "applied" | "failed";
  result?: unknown;
  error?: string;
  failureClass?: ImageRescueFailureClass;
}

export interface ImageRescueResult {
  ok: boolean;
  operation: ImageRescueOperation;
  projectRoot: string;
  statePath: string;
  state?: ProjectState;
  sourceImage: ProjectImageState;
  targetImage?: ProjectImageState;
  sourceSnapshot: ImageRescueSourceSnapshot;
  historyDirectoryPath?: string;
  historyFiles?: ImageRescueHistoryFile[];
  historyListing?: unknown;
  selectedHistoryFilePath?: string;
  repositoryResults?: ImageRescueRepositoryResult[];
  changeResult?: ImageRescueChangeResult;
  warnings: string[];
}

export class ImageRescueError extends Error {
  constructor(
    message: string,
    public readonly result?: ImageRescueResult,
  ) {
    super(message);
    this.name = "ImageRescueError";
  }
}

function defaultSleep(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function launcherResultData<T>(result: unknown): T | undefined {
  if (isObject(result) && "data" in result) {
    const commandResult = result as unknown as LauncherCommandResult<T>;
    return commandResult.ok === false ? undefined : commandResult.data;
  }

  return result as T;
}

function assertLauncherOk(result: unknown, toolName: string): void {
  if (isObject(result) && result.ok === false) {
    throw new Error(`${toolName} returned ok: false`);
  }
}

function parseToolContent(value: unknown): unknown {
  if (!isObject(value)) {
    return value;
  }

  const content = value.content;
  if (!Array.isArray(content)) {
    return value;
  }

  const textContent = content.find(
    (item): item is { type: "text"; text: string } =>
      isObject(item) && item.type === "text" && typeof item.text === "string",
  );
  if (!textContent) {
    return value;
  }

  try {
    return JSON.parse(textContent.text);
  } catch {
    return textContent.text;
  }
}

function resultData(value: unknown): unknown {
  const parsed = parseToolContent(value);
  if (isObject(parsed) && "data" in parsed) {
    return parsed.data;
  }

  return parsed;
}

function nowStamp(now: () => Date): string {
  return now().toISOString().replaceAll(/[:.]/g, "-");
}

function defaultTargetImageId(sourceImageId: string): string {
  return sanitizeRuntimeId(`${sourceImageId}-rescue`);
}

function defaultTargetImageName(sourceImageName: string, now: () => Date): string {
  return `${sourceImageName}-rescue-${nowStamp(now).slice(0, 19)}`;
}

function processMatchesImage(process: LauncherProcess, imageName: string): boolean {
  return (
    process.imageName === imageName ||
    path.basename(process.imagePath ?? "", ".image") === imageName ||
    process.commandLine.includes(`${imageName}.image`) ||
    process.commandLine.includes(imageName)
  );
}

async function pollUntil<T>(
  timeoutMs: number,
  intervalMs: number,
  sleep: (durationMs: number) => Promise<void>,
  producer: () => Promise<T | undefined>,
): Promise<T | undefined> {
  const startedAt = Date.now();

  while (Date.now() - startedAt <= timeoutMs) {
    const result = await producer();
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
    const result = await client.callTool<LauncherCommandResult<LauncherProcess[]>>(
      "pharo_launcher_process_list",
    );
    const processes = launcherResultData<LauncherProcess[]>(result) ?? [];
    return processes.find((process) => processMatchesImage(process, imageName));
  });
}

async function launchImage(
  client: PharoLauncherMcpToolClient,
  healthClient: PharoMcpHealthClient,
  imageState: ProjectImageState,
  startupScriptPath: string,
  poll: Required<ImageRescuePollOptions>,
  sleep: (durationMs: number) => Promise<void>,
): Promise<number> {
  const launchResult = await client.callTool<LauncherCommandResult>(
    "pharo_launcher_image_launch",
    {
      imageName: imageState.imageName,
      detached: true,
      script: startupScriptPath,
    },
  );
  assertLauncherOk(launchResult, "pharo_launcher_image_launch");

  const process = await pollProcessForImage(
    client,
    imageState.imageName,
    poll.processTimeoutMs,
    poll.intervalMs,
    sleep,
  );
  if (!process) {
    throw new Error(
      `Timed out waiting for PharoLauncher process for image ${imageState.imageName}`,
    );
  }

  const healthy = await pollUntil(
    poll.healthTimeoutMs,
    poll.intervalMs,
    sleep,
    async () => ((await healthClient.check(imageState.assignedPort)) ? true : undefined),
  );
  if (!healthy) {
    throw new Error(
      `Timed out waiting for Pharo MCP health on port ${imageState.assignedPort}`,
    );
  }

  return process.pid;
}

function resolveWorkspaceId(projectRoot: string, workspaceId?: string): string {
  return workspaceId ? sanitizeRuntimeId(workspaceId) : defaultWorkspaceId(projectRoot);
}

function findImageState(state: ProjectState, imageId: string): ProjectImageState {
  const image = state.images.find((candidate) => candidate.id === imageId);
  if (!image) {
    throw new ImageRescueError(`Project state does not contain image id: ${imageId}`);
  }

  return image;
}

function findImageConfig(
  configImages: ProjectImageConfig[],
  imageId: string,
): ProjectImageConfig {
  const image = configImages.find((candidate) => candidate.id === imageId);
  if (!image) {
    throw new ImageRescueError(`Project config does not contain image id: ${imageId}`);
  }

  return image;
}

function allocatePort(
  state: ProjectState,
  requestedPort: number | undefined,
  range: ProjectPortRange,
): number {
  const usedPorts = new Set(state.images.map((image) => image.assignedPort));
  if (requestedPort !== undefined) {
    if (usedPorts.has(requestedPort)) {
      throw new ImageRescueError(`Requested target MCP port is already used: ${requestedPort}`);
    }

    return requestedPort;
  }

  for (let port = range.start; port <= range.end; port += 1) {
    if (!usedPorts.has(port)) {
      return port;
    }
  }

  throw new ImageRescueError(`No available port in range ${range.start}-${range.end}`);
}

function launcherImagesDirectory(configReport: LauncherConfigReport): string | undefined {
  return (
    configReport.profile?.imagesDir?.path ??
    (configReport.launcherDir?.path
      ? path.join(configReport.launcherDir.path, "images")
      : undefined)
  );
}

function resolveImagePaths(
  imageName: string,
  launcherImage: LauncherImageInfo | undefined,
  configReport: LauncherConfigReport,
): ResolvedImagePaths {
  const rawImagePath = launcherImage?.imagePath;
  const imagesDirectory = launcherImagesDirectory(configReport);
  const imagePath = rawImagePath
    ? path.isAbsolute(rawImagePath)
      ? rawImagePath
      : imagesDirectory
        ? path.resolve(imagesDirectory, rawImagePath)
        : path.resolve(rawImagePath)
    : imagesDirectory
      ? path.join(imagesDirectory, imageName, `${imageName}.image`)
      : undefined;
  const imageDirectoryPath = imagePath ? path.dirname(imagePath) : undefined;
  const changesPath = imagePath
    ? imagePath.replace(/\.image$/i, ".changes")
    : undefined;
  const localDirectoryPath = imageDirectoryPath
    ? path.join(imageDirectoryPath, "pharo-local")
    : undefined;
  const ombuDirectoryPath = localDirectoryPath
    ? path.join(localDirectoryPath, "ombu-sessions")
    : undefined;

  return {
    ...(imagePath ? { imagePath } : {}),
    ...(imageDirectoryPath ? { imageDirectoryPath } : {}),
    ...(changesPath ? { changesPath } : {}),
    ...(localDirectoryPath ? { localDirectoryPath } : {}),
    ...(ombuDirectoryPath ? { ombuDirectoryPath } : {}),
  };
}

async function launcherImageInfo(
  client: PharoLauncherMcpToolClient,
  imageName: string,
): Promise<LauncherImageInfo | undefined> {
  const result = await client.callTool<LauncherCommandResult<LauncherImageInfo>>(
    "pharo_launcher_image_info",
    {
      imageName,
      format: "ston",
    },
  );

  return launcherResultData<LauncherImageInfo>(result);
}

async function launcherConfigReport(
  client: PharoLauncherMcpToolClient,
): Promise<LauncherConfigReport> {
  const result = await client.callTool<LauncherConfigReport>(
    "pharo_launcher_config",
  );

  return launcherResultData<LauncherConfigReport>(result) ?? {};
}

async function snapshotRepositories(
  image: ProjectImageState,
  imageMcpClient: ImageRescueMcpClient | undefined,
  capturedAt: string,
): Promise<ImageRescueRepositorySnapshot | undefined> {
  if (!imageMcpClient || image.status !== "running") {
    return undefined;
  }

  try {
    const result = await imageMcpClient.callTool(image, "find_repositories", {
      limit: 1000,
    });
    const repositories = extractObjects(resultData(result));

    return {
      capturedAt,
      status: "captured",
      repositories,
    };
  } catch (error) {
    return {
      capturedAt,
      status: "unavailable",
      repositories: [],
      error: errorMessage(error),
    };
  }
}

function extractObjects(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    return value.filter(isObject);
  }

  if (isObject(value)) {
    for (const key of ["repositories", "items", "entries", "data"]) {
      const nested = value[key];
      if (Array.isArray(nested)) {
        return nested.filter(isObject);
      }
    }
  }

  return [];
}

function listOmbuFiles(directoryPath: string | undefined): ImageRescueHistoryFile[] {
  if (!directoryPath || !fs.existsSync(directoryPath)) {
    return [];
  }

  return fs
    .readdirSync(directoryPath, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ombu"))
    .map((entry) => {
      const filePath = path.join(directoryPath, entry.name);
      const stat = fs.statSync(filePath);
      return {
        path: filePath,
        mtimeMs: stat.mtimeMs,
        size: stat.size,
      };
    })
    .sort((a, b) => (b.mtimeMs ?? 0) - (a.mtimeMs ?? 0));
}

function selectionArguments(
  selection: ImageRescueEntrySelection | undefined,
): Record<string, unknown> {
  if (!selection) {
    return {};
  }

  return {
    ...(selection.indexes ? { indexes: selection.indexes } : {}),
    ...(selection.entryReferences
      ? { entryReferences: selection.entryReferences }
      : {}),
    ...(selection.startIndex !== undefined ? { startIndex: selection.startIndex } : {}),
    ...(selection.endIndex !== undefined ? { endIndex: selection.endIndex } : {}),
    ...(selection.latestCount !== undefined ? { latestCount: selection.latestCount } : {}),
  };
}

function extractIndexesFromEntries(value: unknown): number[] {
  const entries = extractObjects(value);
  const indexes = entries
    .map((entry) => entry.index)
    .filter((index): index is number => Number.isInteger(index));

  return indexes;
}

function excludedIndexes(exclude: ImageRescueEntrySelection | undefined): Set<number> {
  if (exclude?.latestCount !== undefined) {
    throw new ImageRescueError(
      "exclude.latestCount cannot be inverted safely yet; use indexes or ranges",
    );
  }

  const indexes = new Set<number>(exclude?.indexes ?? []);

  if (exclude?.startIndex !== undefined && exclude.endIndex !== undefined) {
    for (let index = exclude.startIndex; index <= exclude.endIndex; index += 1) {
      indexes.add(index);
    }
  }

  return indexes;
}

function selectedIndexes(
  selection: ImageRescueEntrySelection | undefined,
  availableIndexes: number[],
): Set<number> {
  if (!selection) {
    return new Set(availableIndexes);
  }

  if (selection.entryReferences && selection.entryReferences.length > 0) {
    throw new ImageRescueError(
      "selection.entryReferences cannot be combined with exclude yet; use indexes or ranges",
    );
  }
  if (selection.latestCount !== undefined) {
    throw new ImageRescueError(
      "selection.latestCount cannot be combined with exclude yet; use indexes or ranges",
    );
  }

  const indexes = new Set(selection.indexes ?? availableIndexes);
  if (selection.startIndex !== undefined || selection.endIndex !== undefined) {
    const startIndex = selection.startIndex ?? Math.min(...availableIndexes);
    const endIndex = selection.endIndex ?? Math.max(...availableIndexes);
    for (const index of [...indexes]) {
      if (index < startIndex || index > endIndex) {
        indexes.delete(index);
      }
    }
  }

  return indexes;
}

async function resolveSelectionWithExclusions(
  imageMcpClient: ImageRescueMcpClient,
  targetImage: ProjectImageState,
  historyFilePath: string,
  selection: ImageRescueEntrySelection | undefined,
  exclude: ImageRescueEntrySelection | undefined,
  codeChangesOnly: boolean,
): Promise<ImageRescueEntrySelection | undefined> {
  if (!exclude) {
    return selection;
  }

  if (exclude.entryReferences && exclude.entryReferences.length > 0) {
    throw new ImageRescueError(
      "exclude.entryReferences cannot be inverted safely yet; use indexes or ranges",
    );
  }

  const listResult = await imageMcpClient.callTool(targetImage, "manage-change-history", {
    operation: "listEntries",
    historyFilePath,
    codeChangesOnly,
  });
  const availableIndexes = extractIndexesFromEntries(resultData(listResult));
  if (availableIndexes.length === 0) {
    throw new ImageRescueError(
      "Could not read entry indexes while applying exclusions",
    );
  }

  const includeIndexes = selectedIndexes(selection, availableIndexes);
  const excludes = excludedIndexes(exclude);

  return {
    indexes: [...includeIndexes].filter((index) => !excludes.has(index)),
  };
}

function repositoryName(repository: Record<string, unknown>): string | undefined {
  const value = repository.name ?? repository.repositoryName;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function repositoryLocation(repository: Record<string, unknown>): string | undefined {
  const value = repository.location ?? repository.directory;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function repositorySubdirectory(
  repository: Record<string, unknown>,
): string | undefined {
  const value = repository.subdirectory;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function repositoryPackageNames(repository: Record<string, unknown>): string[] | undefined {
  const value = repository.packageNames ?? repository.packages;
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : undefined;
}

function defaultRepositoryActions(
  snapshot: ImageRescueRepositorySnapshot | undefined,
): ImageRescueRepositoryAction[] {
  if (!snapshot || snapshot.status !== "captured") {
    return [];
  }

  return snapshot.repositories.flatMap((repository) => {
    const name = repositoryName(repository);
    const location = repositoryLocation(repository);
    if (!name || !location) {
      return [];
    }

    return [
      {
        label: `Register repository ${name}`,
        toolName: "edit_repository" as const,
        arguments: {
          operation: "create",
          name,
          location,
          ...(repositorySubdirectory(repository)
            ? { subdirectory: repositorySubdirectory(repository) }
            : {}),
          ...(repositoryPackageNames(repository)
            ? { packageNames: repositoryPackageNames(repository) }
            : {}),
        },
      },
    ];
  });
}

async function runRepositoryActions(
  imageMcpClient: ImageRescueMcpClient | undefined,
  targetImage: ProjectImageState | undefined,
  actions: ImageRescueRepositoryAction[],
  confirm: boolean,
): Promise<ImageRescueRepositoryResult[]> {
  const results: ImageRescueRepositoryResult[] = [];

  for (const action of actions) {
    const toolName = action.toolName ?? "load_repository";
    const label = action.label ?? toolName;

    if (!confirm) {
      results.push({
        label,
        toolName,
        arguments: action.arguments,
        status: "planned",
      });
      continue;
    }

    if (!imageMcpClient || !targetImage) {
      results.push({
        label,
        toolName,
        arguments: action.arguments,
        status: "skipped",
        error: "No target image MCP client is available",
      });
      continue;
    }

    try {
      const result = await imageMcpClient.callTool(
        targetImage,
        toolName,
        action.arguments,
      );
      results.push({
        label,
        toolName,
        arguments: action.arguments,
        status: "applied",
        result: resultData(result),
      });
    } catch (error) {
      results.push({
        label,
        toolName,
        arguments: action.arguments,
        status: "failed",
        error: errorMessage(error),
      });
    }
  }

  return results;
}

function selectedHistoryFile(
  historyFilePath: string | undefined,
  historyFiles: ImageRescueHistoryFile[],
): string | undefined {
  return historyFilePath ?? historyFiles[0]?.path;
}

async function listHistoryFilesThroughImage(
  imageMcpClient: ImageRescueMcpClient | undefined,
  image: ProjectImageState | undefined,
  directoryPath: string | undefined,
  includeEntryCounts: boolean,
): Promise<unknown | undefined> {
  if (!imageMcpClient || !image || image.status !== "running" || !directoryPath) {
    return undefined;
  }

  const result = await imageMcpClient.callTool(image, "manage-change-history", {
    operation: "listFiles",
    directoryPath,
    includeEntryCounts,
  });

  return resultData(result);
}

async function applyHistoryEntries(
  imageMcpClient: ImageRescueMcpClient | undefined,
  targetImage: ProjectImageState | undefined,
  historyFilePath: string | undefined,
  selection: ImageRescueEntrySelection | undefined,
  exclude: ImageRescueEntrySelection | undefined,
  codeChangesOnly: boolean,
  confirm: boolean,
): Promise<ImageRescueChangeResult | undefined> {
  if (!historyFilePath) {
    return undefined;
  }

  let resolvedSelection = selection;
  if (imageMcpClient && targetImage) {
    resolvedSelection = await resolveSelectionWithExclusions(
      imageMcpClient,
      targetImage,
      historyFilePath,
      selection,
      exclude,
      codeChangesOnly,
    );
  }

  const argumentsValue = {
    operation: "applyEntries",
    historyFilePath,
    codeChangesOnly,
    confirm,
    ...selectionArguments(resolvedSelection),
  };

  if (!confirm) {
    return {
      historyFilePath,
      arguments: argumentsValue,
      status: "planned",
    };
  }

  if (!imageMcpClient || !targetImage) {
    throw new ImageRescueError("A running target image is required to apply history entries");
  }

  try {
    const result = await imageMcpClient.callTool(
      targetImage,
      "manage-change-history",
      argumentsValue,
    );
    return {
      historyFilePath,
      arguments: argumentsValue,
      status: "applied",
      result: resultData(result),
    };
  } catch (error) {
    return {
      historyFilePath,
      arguments: argumentsValue,
      status: "failed",
      error: errorMessage(error),
      failureClass: "apply-time-breaker",
    };
  }
}

function updateImageMetadata(
  image: ProjectImageState,
  snapshot: ImageRescueSourceSnapshot,
): void {
  image.imagePath = snapshot.paths.imagePath;
  image.imageDirectoryPath = snapshot.paths.imageDirectoryPath;
  image.changesPath = snapshot.paths.changesPath;
  image.localDirectoryPath = snapshot.paths.localDirectoryPath;
  image.ombuDirectoryPath = snapshot.paths.ombuDirectoryPath;
  image.vmId = snapshot.launcherImage?.vmId;
  image.pharoVersion = snapshot.launcherImage?.pharoVersion;
  image.originTemplate = snapshot.launcherImage?.originTemplate;
  image.rescueSnapshot = snapshot;
}

function targetConfigFromSource(
  sourceConfig: ProjectImageConfig,
  targetImageId: string,
  targetImageName: string,
  targetPort: number,
): ProjectImageConfig {
  return {
    ...sourceConfig,
    id: targetImageId,
    imageName: targetImageName,
    active: true,
    mcp: {
      ...sourceConfig.mcp,
      port: targetPort,
    },
  };
}

async function createTargetImage(
  client: PharoLauncherMcpToolClient,
  targetImageName: string,
  templateName: string,
  templateCategory: string | undefined,
): Promise<void> {
  const result = await client.callTool<LauncherCommandResult>(
    "pharo_launcher_image_create",
    {
      newImageName: targetImageName,
      templateName,
      ...(templateCategory ? { templateCategory } : {}),
      noLaunch: true,
    },
  );
  assertLauncherOk(result, "pharo_launcher_image_create");
}

export async function rescueImage(
  options: ImageRescueOptions,
): Promise<ImageRescueResult> {
  const projectRoot = path.resolve(options.projectRoot);
  const config = loadProjectConfig(projectRoot);
  const workspaceId = resolveWorkspaceId(projectRoot, options.workspaceId);
  const statePath = projectStatePathForConfig({
    projectRoot,
    config,
    workspaceId,
    stateRoot: options.stateRoot,
  });
  const state = loadProjectState(statePath);
  if (!state) {
    throw new ImageRescueError(`No PLexus runtime state found at ${statePath}`);
  }

  const now = options.now ?? (() => new Date());
  const capturedAt = now().toISOString();
  const sourceImage = findImageState(state, options.sourceImageId);
  const sourceConfig = findImageConfig(config.images, options.sourceImageId);
  const launcherClient =
    options.pharoLauncherMcpClient ??
    (await createStdioPharoLauncherMcpClient());
  const ownsLauncherClient = !options.pharoLauncherMcpClient;
  const warnings: string[] = [];

  try {
    const [configReport, launcherImage] = await Promise.all([
      launcherConfigReport(launcherClient),
      launcherImageInfo(launcherClient, sourceImage.imageName),
    ]);
    const paths = resolveImagePaths(
      sourceImage.imageName,
      launcherImage,
      configReport,
    );
    const repositorySnapshot =
      (await snapshotRepositories(
        sourceImage,
        options.imageMcpClient,
        capturedAt,
      )) ?? sourceImage.rescueSnapshot?.repositories;
    const sourceSnapshot: ImageRescueSourceSnapshot = {
      capturedAt,
      ...(launcherImage ? { launcherImage } : {}),
      paths,
      ...(repositorySnapshot ? { repositories: repositorySnapshot } : {}),
    };
    const historyDirectoryPath =
      options.sourceHistoryDirectoryPath ?? paths.ombuDirectoryPath;
    const historyFiles = listOmbuFiles(historyDirectoryPath);
    const selectedHistoryFilePath = selectedHistoryFile(
      options.historyFilePath,
      historyFiles,
    );
    const targetImageId =
      options.targetImageId ?? defaultTargetImageId(options.sourceImageId);
    let targetImage = state.images.find((image) => image.id === targetImageId);
    let historyListing: unknown;

    if (options.operation === "plan" && options.includeEntryCounts) {
      const historyReader =
        targetImage?.status === "running" ? targetImage : sourceImage;
      try {
        historyListing = await listHistoryFilesThroughImage(
          options.imageMcpClient,
          historyReader,
          historyDirectoryPath,
          options.includeEntryCounts,
        );
      } catch (error) {
        warnings.push(`Could not list history files through Pharo: ${errorMessage(error)}`);
      }
    }

    if (
      (options.operation === "snapshotSource" || options.operation === "prepareTarget") &&
      repositorySnapshot?.status === "unavailable"
    ) {
      warnings.push(
        `Repository snapshot is unavailable: ${repositorySnapshot.error ?? "unknown error"}`,
      );
    }

    if (options.operation === "snapshotSource") {
      updateImageMetadata(sourceImage, sourceSnapshot);
      state.updatedAt = capturedAt;
      saveProjectState(statePath, state);

      return {
        ok: true,
        operation: options.operation,
        projectRoot,
        statePath,
        state,
        sourceImage,
        sourceSnapshot,
        historyDirectoryPath,
        historyFiles,
        historyListing,
        selectedHistoryFilePath,
        warnings,
      };
    }

    if (options.operation === "prepareTarget") {
      if (targetImage) {
        throw new ImageRescueError(`Target image id already exists: ${targetImageId}`);
      }

      const targetImageName =
        options.targetImageName ??
        defaultTargetImageName(sourceImage.imageName, now);
      const templateName =
        options.targetTemplateName ?? launcherImage?.originTemplate?.name;
      if (!templateName) {
        throw new ImageRescueError(
          "targetTemplateName is required because the source image origin template is unknown",
        );
      }

      await createTargetImage(
        launcherClient,
        targetImageName,
        templateName,
        options.targetTemplateCategory,
      );

      const assignedPort = allocatePort(
        state,
        options.targetMcpPort,
        options.portRange ?? defaultProjectPortRange,
      );
      targetImage = {
        id: targetImageId,
        imageName: targetImageName,
        assignedPort,
        status: "starting",
      };
      state.images.push(targetImage);
      updateImageMetadata(sourceImage, sourceSnapshot);
      state.updatedAt = capturedAt;
      saveProjectState(statePath, state);

      const targetConfig = targetConfigFromSource(
        sourceConfig,
        targetImageId,
        targetImageName,
        assignedPort,
      );
      const startupScript = writeImageStartupScript({
        projectRoot,
        projectId: config.kanban.projectId,
        workspaceId,
        stateRoot: options.stateRoot,
        imageConfig: targetConfig,
        imageState: targetImage,
      });
      const poll = {
        ...defaultPoll,
        ...options.poll,
      };
      try {
        const pid = await launchImage(
          launcherClient,
          options.healthClient ?? new HttpPharoMcpHealthClient(),
          targetImage,
          startupScript.filePath,
          poll,
          options.sleep ?? defaultSleep,
        );
        targetImage.pid = pid;
        targetImage.status = "running";
        state.updatedAt = now().toISOString();
        saveProjectState(statePath, state);
      } catch (error) {
        targetImage.status = "failed";
        state.updatedAt = now().toISOString();
        saveProjectState(statePath, state);
        throw error;
      }
    }

    if (options.operation === "applyPlan") {
      if (!targetImage) {
        throw new ImageRescueError(`Target image id is not in runtime state: ${targetImageId}`);
      }

      const actionSource =
        options.repositoryActions ??
        ((options.loadRepositories ?? true)
          ? defaultRepositoryActions(repositorySnapshot)
          : []);
      const repositoryResults = await runRepositoryActions(
        options.imageMcpClient,
        targetImage,
        actionSource,
        options.confirm === true,
      );
      const changeResult = await applyHistoryEntries(
        options.imageMcpClient,
        targetImage,
        selectedHistoryFilePath,
        options.selection,
        options.exclude,
        options.codeChangesOnly ?? true,
        options.confirm === true,
      );

      return {
        ok:
          repositoryResults.every((repository) => repository.status !== "failed") &&
          changeResult?.status !== "failed",
        operation: options.operation,
        projectRoot,
        statePath,
        state,
        sourceImage,
        targetImage,
        sourceSnapshot,
        historyDirectoryPath,
        historyFiles,
        historyListing,
        selectedHistoryFilePath,
        repositoryResults,
        changeResult,
        warnings,
      };
    }

    return {
      ok: true,
      operation: options.operation,
      projectRoot,
      statePath,
      state,
      sourceImage,
      targetImage,
      sourceSnapshot,
      historyDirectoryPath,
      historyFiles,
      historyListing,
      selectedHistoryFilePath,
      warnings,
    };
  } finally {
    if (ownsLauncherClient) {
      await launcherClient.close?.();
    }
  }
}
