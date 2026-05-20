import fs from "node:fs";
import path from "node:path";
import {
  loadProjectConfig,
  projectConfigId,
  resolveProjectRuntimePolicy,
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
  projectStatePathForConfig,
  projectStateRootForConfig,
  runtimeStatusForImages,
  sanitizeRuntimeId,
  saveProjectState,
  type ProjectImageMcpEndpoint,
  type ProjectImageState,
  type ProjectPortRange,
  type ProjectState,
} from "./projectState.js";
import { writeProjectImageStartupScript } from "./projectStartupScript.js";
import { materializeProjectImageRepositoryWorkspace } from "./projectRepositoryWorkspace.js";
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

export interface ProjectOpenOptions {
  projectRoot: string;
  stateRoot?: string;
  workspaceId?: string;
  targetId?: string;
  imageIds?: string[];
  pharoLauncherMcpClient?: PharoLauncherMcpToolClient;
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

type ProcessOutcome = {
  kind: "process";
  process: LauncherProcess | undefined;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
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

function repositoryWorkspaceNeedsLauncherPaths(imageState: ProjectImageState): boolean {
  return Boolean(
    imageState.repositoryWorkspace?.path.startsWith("image-local://") &&
      !imageState.localDirectoryPath,
  );
}

function appendRepositoryWorkspaceDiagnostic(
  imageState: ProjectImageState,
  message: string,
): void {
  const workspace = imageState.repositoryWorkspace;
  if (!workspace || workspace.diagnostics.includes(message)) {
    return;
  }

  workspace.diagnostics = [...workspace.diagnostics, message];
}

function parseStatusProperties(filePath: string): Record<string, string> {
  return Object.fromEntries(
    fs
      .readFileSync(filePath, "utf8")
      .split(/\r?\n/)
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

function prepareRepositoryWorkspaceLoadStatus(
  imageState: ProjectImageState,
  statusPath: string | undefined,
): void {
  const workspace = imageState.repositoryWorkspace;
  if (!workspace || !statusPath) {
    return;
  }

  workspace.loadState = "pending";
  workspace.loadStatusPath = statusPath;
  workspace.loadSourcePath = joinPathLike(
    workspace.path,
    workspace.sourceDirectory,
  );
  delete workspace.loadError;
}

function refreshRepositoryWorkspaceLoadStatus(
  imageState: ProjectImageState,
): string | undefined {
  const workspace = imageState.repositoryWorkspace;
  if (!workspace?.loadStatusPath) {
    return undefined;
  }

  if (!fs.existsSync(workspace.loadStatusPath)) {
    appendRepositoryWorkspaceDiagnostic(
      imageState,
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
    appendRepositoryWorkspaceDiagnostic(imageState, workspace.loadError);
    return `Pharo project load failed for image ${imageState.id}: ${workspace.loadError}`;
  }

  workspace.loadState = "failed";
  workspace.loadError = `Invalid Pharo project load status at ${workspace.loadStatusPath}: ${status ?? "(missing)"}`;
  appendRepositoryWorkspaceDiagnostic(imageState, workspace.loadError);
  return workspace.loadError;
}

async function hydrateRepositoryWorkspaceImagePaths(
  client: PharoLauncherMcpToolClient,
  imageState: ProjectImageState,
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
    const result = await client.callTool<LauncherCommandResult<LauncherProcess[]>>(
      "pharo_launcher_process_list",
      {},
    );
    assertLauncherOk(result, "pharo_launcher_process_list");
    const processes = launcherResultData(result) ?? [];

    return processes.find((process) =>
      processDirectlyMatchesImage(process, imageName),
    );
  });
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
  | { kind: "assignedPort"; port: number };

async function pollPharoMcpReadiness(options: {
  imageState: ProjectImageState;
  endpointHandoffPath: string;
  preferEndpointHandoff: boolean;
  healthClient: PharoMcpHealthClient;
  timeoutMs: number;
  intervalMs: number;
  sleep: (durationMs: number) => Promise<void>;
}): Promise<ImageMcpReadiness | undefined> {
  return pollUntil(
    options.timeoutMs,
    options.intervalMs,
    options.sleep,
    async () => {
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

      return undefined;
    },
  );
}

async function launchImageAndPollProcess(
  launchClient: PharoLauncherMcpToolClient,
  processClient: PharoLauncherMcpToolClient,
  imageName: string,
  startupScriptPath: string,
  timeoutMs: number,
  intervalMs: number,
  sleep: (durationMs: number) => Promise<void>,
): Promise<LauncherProcess> {
  const launchOutcome = launchClient
    .callTool<LauncherCommandResult>("pharo_launcher_image_launch", {
      imageName,
      detached: true,
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

    const process = await pollProcessForImage(
      processClient,
      imageName,
      timeoutMs,
      intervalMs,
      sleep,
    );
    if (process) {
      return process;
    }

    throw new Error(
      `Timed out waiting for PharoLauncher process for image ${imageName}`,
    );
  }

  const processOutcome = pollProcessForImage(
    processClient,
    imageName,
    timeoutMs,
    intervalMs,
    sleep,
  ).then<ProcessOutcome>((process) => ({ kind: "process", process }));
  const first = await Promise.race([launchOutcome, processOutcome]);

  if (first.kind === "launchError") {
    throw first.error;
  }

  if (first.kind === "launch") {
    assertLauncherOk(first.result, "pharo_launcher_image_launch");

    const { process } = await processOutcome;
    if (process) {
      return process;
    }
  } else if (first.process) {
    return first.process;
  }

  throw new Error(
    `Timed out waiting for PharoLauncher process for image ${imageName}`,
  );
}

function activeStateImages(state: ProjectState): ProjectImageState[] {
  return state.images.filter((image) => image.status === "starting");
}

function imageRequiresPharoMcpHealth(image: ProjectImageState): boolean {
  return image.pharoMcpContract?.status !== "unsupported";
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

        await hydrateRepositoryWorkspaceImagePaths(client, imageState);
        materializeProjectImageRepositoryWorkspace({
          projectRoot,
          imageConfig,
          imageState,
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
          config,
          imageId: imageState.id,
          imageState,
          workspaceId,
          stateRoot: resolvedStateRoot,
        });
        prepareRepositoryWorkspaceLoadStatus(
          imageState,
          startupScript.repositoryWorkspaceLoadStatusPath,
        );

        const launchClient = options.pharoLauncherMcpClient
          ? client
          : await createStdioPharoLauncherMcpClient(undefined, {
              profileEnvironment: launcherProfileEnvironment,
            });
        const ownsLaunchClient = !options.pharoLauncherMcpClient;
        try {
          const process = await launchImageAndPollProcess(
            launchClient,
            client,
            imageState.imageName,
            startupScript.filePath,
            poll.processTimeoutMs,
            poll.intervalMs,
            sleep,
          );
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

          if (imageRequiresPharoMcpHealth(imageState)) {
            const preferEndpointHandoff = imageConfig.mcp.port === undefined;
            const readiness = await pollPharoMcpReadiness({
              imageState,
              endpointHandoffPath,
              preferEndpointHandoff,
              healthClient,
              timeoutMs: poll.healthTimeoutMs,
              intervalMs: poll.intervalMs,
              sleep,
            });
            if (!readiness) {
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

            if (readiness.kind === "endpoint") {
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
          const loadFailure = refreshRepositoryWorkspaceLoadStatus(imageState);
          if (loadFailure) {
            throw new Error(loadFailure);
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
        failures.push({
          imageId: imageState.id,
          imageName: imageState.imageName,
          message:
            refreshRepositoryWorkspaceLoadStatus(imageState) ?? errorMessage(error),
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
