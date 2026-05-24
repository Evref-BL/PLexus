import fs from "node:fs";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  loadProjectConfig,
  projectImageDisplayMode,
  projectConfigId,
  resolveProjectRuntimePolicy,
  type ProjectConfig,
  type ProjectImageDisplayMode,
  type ProjectImageConfig,
} from "./projectConfig.js";
import {
  closeProject,
  ProjectCloseError,
  type ProjectCloseResult,
} from "./projectClose.js";
import { openProject } from "./projectOpen.js";
import {
  materializeProjectImageFromHomeCache,
  type HomeImageCacheMutationApproval,
} from "./homeImageCache.js";
import {
  createStdioPharoLauncherMcpClient,
  type PharoLauncherMcpToolClient,
} from "./pharoLauncherMcpClient.js";
import {
  describePharoLauncherMcpProfile,
  pharoLauncherMcpProfileEnvironment,
  type PharoLauncherMcpProfileDiagnostic,
} from "./pharoLauncherProfile.js";
import {
  collectReservedProjectPortOwners,
  createProjectState,
  defaultTargetId,
  defaultWorkspaceId,
  loadProjectState,
  projectStatePathForConfig,
  projectStateRootForConfig,
  renderProjectImageName,
  runtimeStatusForImages,
  sanitizeRuntimeId,
  saveProjectState,
  type ProjectImageState,
  type ProjectState,
} from "./projectState.js";
import { projectScriptsDirectoryPath } from "./projectStartupScript.js";
import { dirnamePathLike, joinPathLike } from "./pathStyle.js";

const stringSchema = { type: "string", minLength: 1 } as const;
const displayModeSchema = {
  type: "string",
  enum: ["headless", "interactive"],
} as const;
const displayModeSnapshotTimeoutMs = 60_000;
const displayModeSnapshotPollIntervalMs = 100;

function objectSchema(
  properties: Record<string, unknown>,
  required: string[] = [],
) {
  return {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  } as const;
}

export interface ScopedPharoLauncherOptions {
  projectRoot: string;
  workspaceId?: string;
  targetId?: string;
  stateRoot?: string;
  pharoLauncherMcpClient?: PharoLauncherMcpToolClient;
  homeImageCacheClient?: PharoLauncherMcpToolClient;
  homeImageCacheApproval?: HomeImageCacheMutationApproval;
  projectOpen?: typeof openProject;
  projectClose?: typeof closeProject;
  fetch?: typeof fetch;
  now?: () => Date;
}

interface ResolvedScope {
  projectRoot: string;
  projectId: string;
  projectName: string;
  workspaceId: string;
  targetId: string;
  stateRoot?: string;
}

interface WorkspaceScopeSummary {
  projectId: string;
  projectName: string;
  workspaceId: string;
  targetId: string;
}

interface LauncherProfileSummary {
  ownership: PharoLauncherMcpProfileDiagnostic["ownership"];
  mode: PharoLauncherMcpProfileDiagnostic["mode"];
}

interface WorkspaceImageSummary {
  imageId: string;
  active: boolean;
  status: ProjectImageState["status"] | "declared";
  displayMode: ProjectImageDisplayMode;
  displayModes: {
    default: ProjectImageDisplayMode;
    current?: ProjectImageDisplayMode;
    start: ProjectImageDisplayMode;
    interactiveOpen: "interactive";
    show: "interactive";
    hide: "headless";
  };
  pharoMcpContract?: ProjectImageState["pharoMcpContract"];
}

interface ScopedImageLifecycleStatus {
  imageId: string;
  status: WorkspaceImageSummary["status"];
  displayMode: ProjectImageDisplayMode;
}

type ScopedImageRouteStatusCode =
  | "routable"
  | "image_unavailable"
  | "contract_unknown"
  | "contract_mismatch";

interface ScopedImageRouteStatus {
  serverName: "pharo_gateway";
  requiredArgument: "imageId";
  imageId: string;
  status: ScopedImageRouteStatusCode;
  routable: boolean;
  endpointRecorded: boolean;
  contractStatus?: NonNullable<ProjectImageState["pharoMcpContract"]>["status"];
}

interface ScopedImageResetSummary {
  imageId: string;
  closed: boolean;
  deleted: boolean;
  created: boolean;
  started: boolean;
  lifecycle: ScopedImageLifecycleStatus;
  route: ScopedImageRouteStatus;
  repositoryWorkspaceCleanupPolicy: "delete-disposable";
  repositoryWorkspaceCleanup: {
    attempted: boolean;
    decisions: Array<{
      repositoryId: string;
      decision: string;
      dirtyState: string;
    }>;
  };
}

interface ResetImageOptions {
  start?: boolean;
  displayMode?: ProjectImageDisplayMode;
}

interface DisplayModeRestartSnapshot {
  attempted: boolean;
  status: "saved";
  endpoint?: ProjectImageState["mcpEndpoint"];
}

interface LauncherCommandResult<T = unknown> {
  ok: boolean;
  data?: T;
}

export class ScopedPharoLauncherError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScopedPharoLauncherError";
  }
}

function textResult(value: unknown, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    ...(isError ? { isError } : {}),
  };
}

function objectInput(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return {};
  }

  return input as Record<string, unknown>;
}

function requireString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new ScopedPharoLauncherError(`${key} is required`);
  }

  return value;
}

function optionalString(
  input: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = input[key];
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string" || value.length === 0) {
    throw new ScopedPharoLauncherError(`${key} must be a non-empty string`);
  }

  return value;
}

function optionalBoolean(
  input: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const value = input[key];
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "boolean") {
    throw new ScopedPharoLauncherError(`${key} must be a boolean`);
  }

  return value;
}

function optionalDisplayMode(
  input: Record<string, unknown>,
  key: string,
): ProjectImageDisplayMode | undefined {
  const value = input[key];
  if (value === undefined) {
    return undefined;
  }

  if (value === "headless" || value === "interactive") {
    return value;
  }

  throw new ScopedPharoLauncherError(`${key} must be headless or interactive`);
}

function requireConfirm(input: Record<string, unknown>): void {
  if (input.confirm !== true) {
    throw new ScopedPharoLauncherError("confirm: true is required");
  }
}

function assertLauncherOk(
  result: LauncherCommandResult | undefined,
  toolName: string,
): void {
  if (result && result.ok === false) {
    throw new ScopedPharoLauncherError(`${toolName} returned ok: false`);
  }
}

function scopedMutationApproval(
  approval: HomeImageCacheMutationApproval | undefined,
  operation: string,
): HomeImageCacheMutationApproval {
  return approval ?? { approved: true, runnerId: operation };
}

function resolveScope(options: ScopedPharoLauncherOptions): ResolvedScope {
  const projectConfig = loadProjectConfig(options.projectRoot);
  const workspaceId = options.workspaceId ?? defaultWorkspaceId(options.projectRoot);
  const stateRoot = projectStateRootForConfig(projectConfig, options.stateRoot);
  return {
    projectRoot: options.projectRoot,
    projectId: projectConfigId(projectConfig),
    projectName: projectConfig.name,
    workspaceId,
    targetId:
      options.targetId ?? defaultTargetId(projectConfigId(projectConfig), workspaceId),
    ...(stateRoot ? { stateRoot } : {}),
  };
}

function scopeSummary(scope: ResolvedScope): WorkspaceScopeSummary {
  return {
    projectId: scope.projectId,
    projectName: scope.projectName,
    workspaceId: scope.workspaceId,
    targetId: scope.targetId,
  };
}

function launcherProfileSummary(
  profile: PharoLauncherMcpProfileDiagnostic,
): LauncherProfileSummary {
  return {
    ownership: profile.ownership,
    mode: profile.mode,
  };
}

function imageSummary(
  imageConfig: ProjectImageConfig,
  imageState: ProjectImageState | undefined,
): WorkspaceImageSummary {
  const defaultDisplayMode = projectImageDisplayMode(imageConfig);
  const displayMode = imageState?.displayMode ?? defaultDisplayMode;
  return {
    imageId: imageConfig.id,
    active: imageConfig.active,
    status: imageState?.status ?? "declared",
    displayMode,
    displayModes: {
      default: defaultDisplayMode,
      ...(imageState?.displayMode ? { current: imageState.displayMode } : {}),
      start: defaultDisplayMode,
      interactiveOpen: "interactive",
      show: "interactive",
      hide: "headless",
    },
    ...(imageState?.pharoMcpContract
      ? { pharoMcpContract: imageState.pharoMcpContract }
      : {}),
  };
}

function statePathForScope(
  scope: ResolvedScope,
  projectConfig = loadProjectConfig(scope.projectRoot),
): string {
  return projectStatePathForConfig({
    projectRoot: scope.projectRoot,
    config: projectConfig,
    workspaceId: scope.workspaceId,
    stateRoot: scope.stateRoot,
  });
}

function findImageConfig(
  projectConfig: ProjectConfig,
  imageId: string,
): ProjectImageConfig {
  const imageConfig = projectConfig.images.find((image) => image.id === imageId);
  if (!imageConfig) {
    throw new ScopedPharoLauncherError(
      `Image ${imageId} is not declared in this PLexus workspace`,
    );
  }

  return imageConfig;
}

function renderedImageName(
  scope: ResolvedScope,
  imageConfig: ProjectImageConfig,
): string {
  return renderProjectImageName(imageConfig.imageName, {
    projectId: scope.projectId,
    projectName: scope.projectName,
    workspaceId: scope.workspaceId,
    targetId: scope.targetId,
    imageId: imageConfig.id,
  });
}

function imageMcpSnapshotEndpoint(
  imageState: ProjectImageState,
): ProjectImageState["mcpEndpoint"] | undefined {
  if (imageState.mcpEndpoint) {
    return imageState.mcpEndpoint;
  }

  if (imageState.assignedPort !== undefined) {
    return {
      transport: "http",
      host: "127.0.0.1",
      port: imageState.assignedPort,
      path: "/",
    };
  }

  return undefined;
}

function endpointUrl(endpoint: NonNullable<ProjectImageState["mcpEndpoint"]>): string {
  const host =
    endpoint.host.includes(":") && !endpoint.host.startsWith("[")
      ? `[${endpoint.host}]`
      : endpoint.host;
  return `http://${host}:${endpoint.port}${endpoint.path}`;
}

function smalltalkString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function smalltalkPath(value: string): string {
  return smalltalkString(value.replace(/\\/g, "/"));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function defaultSleep(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}

function displayModeSnapshotStatusPath(
  scope: ResolvedScope,
  imageId: string,
  now: Date,
): string {
  const scriptsDirectory = projectScriptsDirectoryPath({
    projectRoot: scope.projectRoot,
    projectId: scope.projectId,
    workspaceId: scope.workspaceId,
    stateRoot: scope.stateRoot,
  });
  return joinPathLike(
    scriptsDirectory,
    `display-mode-snapshot-${sanitizeRuntimeId(imageId)}-${now.getTime()}.properties`,
  );
}

function displayModeSnapshotScript(statusPath: string): string {
  return `| snapshotStatusFile |
snapshotStatusFile := ${smalltalkPath(statusPath)} asFileReference.
[
  (Delay forMilliseconds: 500) wait.
  [
    | server |
    server := Smalltalk globals at: #PLexusMCPServer ifAbsent: [ nil ].
    server ifNotNil: [
      [ server stop ] on: Error do: [ :error | nil ].
      Smalltalk globals removeKey: #PLexusMCPServer ifAbsent: [ nil ] ].
    Smalltalk snapshot: true andQuit: false.
    snapshotStatusFile writeStreamDo: [ :stream |
      stream nextPutAll: 'status=saved'; cr ]
  ] on: Error do: [ :error |
    snapshotStatusFile writeStreamDo: [ :stream |
      stream nextPutAll: 'status=error'; cr.
      stream nextPutAll: 'message='; nextPutAll: error asString; cr ] ]
] forkAt: Processor userBackgroundPriority.
'display mode snapshot scheduled'.`;
}

function parseProperties(contents: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of contents.split(/\r\n|\r|\n/)) {
    const separator = line.indexOf("=");
    if (separator < 0) {
      continue;
    }
    result[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return result;
}

async function waitForDisplayModeSnapshotStatus(
  imageId: string,
  statusPath: string,
): Promise<void> {
  const deadline = Date.now() + displayModeSnapshotTimeoutMs;
  while (Date.now() <= deadline) {
    if (fs.existsSync(statusPath)) {
      const status = parseProperties(fs.readFileSync(statusPath, "utf8"));
      if (status.status === "saved") {
        return;
      }
      if (status.status === "error") {
        throw new ScopedPharoLauncherError(
          `Image ${imageId} snapshot failed: ${status.message ?? "unknown error"}`,
        );
      }
    }
    await defaultSleep(displayModeSnapshotPollIntervalMs);
  }

  throw new ScopedPharoLauncherError(
    `Image ${imageId} snapshot did not finish within ${displayModeSnapshotTimeoutMs}ms`,
  );
}

function projectStateWithoutImage(
  state: ProjectState,
  imageId: string,
  updatedAt: Date,
): ProjectState {
  const images = state.images.filter((image) => image.id !== imageId);
  return {
    ...state,
    images,
    runtimeStatus: runtimeStatusForImages(images),
    updatedAt: updatedAt.toISOString(),
  };
}

function lifecycleStatus(image: WorkspaceImageSummary): ScopedImageLifecycleStatus {
  return {
    imageId: image.imageId,
    status: image.status,
    displayMode: image.displayMode,
  };
}

function routeStatus(
  image: WorkspaceImageSummary,
  imageState: ProjectImageState | undefined,
): ScopedImageRouteStatus {
  const endpointRecorded = Boolean(
    imageState?.mcpEndpoint || imageState?.assignedPort !== undefined,
  );
  const contractStatus = imageState?.pharoMcpContract?.status;
  let status: ScopedImageRouteStatusCode;

  if (image.status !== "running" || !endpointRecorded) {
    status = "image_unavailable";
  } else if (contractStatus === "mismatched" || contractStatus === "unsupported") {
    status = "contract_mismatch";
  } else if (contractStatus === undefined || contractStatus === "unknown") {
    status = "contract_unknown";
  } else {
    status = "routable";
  }

  return {
    serverName: "pharo_gateway",
    requiredArgument: "imageId",
    imageId: image.imageId,
    status,
    routable: status === "routable",
    endpointRecorded,
    ...(contractStatus ? { contractStatus } : {}),
  };
}

function resetCloseError(
  imageId: string,
  error: ProjectCloseError,
): ScopedPharoLauncherError {
  const cleanup = error.result.repositoryWorkspaceCleanups.find(
    (record) => record.imageId === imageId,
  );
  if (cleanup) {
    return new ScopedPharoLauncherError(
      `Image ${imageId} reset could not clean its disposable repository workspace: ${cleanup.decision} (${cleanup.dirtyState})`,
    );
  }

  const failure = error.result.failures.find(
    (record) => record.imageId === imageId,
  );
  if (failure) {
    return new ScopedPharoLauncherError(
      `Image ${imageId} reset could not close the scoped image`,
    );
  }

  return new ScopedPharoLauncherError(
    `Image ${imageId} reset could not close the scoped image cleanly`,
  );
}

function resetSummary(
  imageId: string,
  closeResult: ProjectCloseResult | undefined,
  deleted: boolean,
  started: boolean,
  image: WorkspaceImageSummary,
  imageState: ProjectImageState | undefined,
): ScopedImageResetSummary {
  return {
    imageId,
    closed: Boolean(closeResult),
    deleted,
    created: true,
    started,
    lifecycle: lifecycleStatus(image),
    route: routeStatus(image, imageState),
    repositoryWorkspaceCleanupPolicy: "delete-disposable",
    repositoryWorkspaceCleanup: {
      attempted: Boolean(closeResult),
      decisions:
        closeResult?.repositoryWorkspaceCleanups.map((record) => ({
          repositoryId: record.repositoryId,
          decision: record.decision,
          dirtyState: record.dirtyState,
        })) ?? [],
    },
  };
}

function stateWithCreatedImage(
  projectConfig: ProjectConfig,
  scope: ResolvedScope,
  previousState: ProjectState | undefined,
  imageId: string,
  now: Date,
): ProjectState {
  const runtime = resolveProjectRuntimePolicy(projectConfig);
  const reservedPorts = collectReservedProjectPortOwners({
    projectRoot: scope.projectRoot,
    projectId: projectConfigId(projectConfig),
    stateRoot: scope.stateRoot,
    excludeWorkspaceId: scope.workspaceId,
  }).map((owner) => owner.port);
  const state = createProjectState(projectConfig, {
    previousState,
    workspaceId: scope.workspaceId,
    targetId: scope.targetId,
    reservedPorts,
    portRange: runtime.imagePorts.range,
    updatedAt: now.toISOString(),
  });

  for (const image of state.images) {
    const previousImage = previousState?.images.find(
      (candidate) => candidate.id === image.id,
    );
    if (image.id === imageId) {
      image.status = "stopped";
      delete image.pid;
    } else if (previousImage) {
      Object.assign(image, previousImage);
    } else {
      image.status = "stopped";
    }
  }
  state.runtimeStatus = runtimeStatusForImages(state.images);

  return state;
}

export class ScopedPharoLauncher {
  constructor(private readonly options: ScopedPharoLauncherOptions) {}

  private currentImageState(
    scope: ResolvedScope,
    projectConfig: ProjectConfig,
    imageId: string,
  ): ProjectImageState | undefined {
    const state = loadProjectState(statePathForScope(scope, projectConfig));
    return state?.images.find((image) => image.id === imageId);
  }

  private async snapshotImageBeforeDisplayModeRestart(
    scope: ResolvedScope,
    imageState: ProjectImageState,
  ): Promise<DisplayModeRestartSnapshot> {
    const endpoint = imageMcpSnapshotEndpoint(imageState);
    if (!endpoint) {
      throw new ScopedPharoLauncherError(
        `Image ${imageState.id} has no routable Pharo MCP endpoint; display mode restart cannot snapshot before close`,
      );
    }

    const statusPath = displayModeSnapshotStatusPath(
      scope,
      imageState.id,
      this.options.now?.() ?? new Date(),
    );
    fs.mkdirSync(dirnamePathLike(statusPath), { recursive: true });
    fs.rmSync(statusPath, { force: true });

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      displayModeSnapshotTimeoutMs,
    );
    try {
      const response = await (this.options.fetch ?? fetch)(endpointUrl(endpoint), {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: `plexus-display-mode-snapshot-${imageState.id}-${Date.now()}`,
          method: "tools/call",
          params: {
            name: "evaluate",
            arguments: {
              code: displayModeSnapshotScript(statusPath),
            },
          },
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new ScopedPharoLauncherError(
          `Image ${imageState.id} snapshot failed with HTTP ${response.status}`,
        );
      }

      const payload = (await response.json()) as unknown;
      if (!isObject(payload)) {
        throw new ScopedPharoLauncherError(
          `Image ${imageState.id} snapshot returned a non-object response`,
        );
      }
      if ("error" in payload) {
        throw new ScopedPharoLauncherError(
          `Image ${imageState.id} snapshot failed: ${JSON.stringify(payload.error)}`,
        );
      }
      const result = payload.result;
      if (isObject(result) && result.isError === true) {
        throw new ScopedPharoLauncherError(
          `Image ${imageState.id} snapshot tool returned an error`,
        );
      }

      await waitForDisplayModeSnapshotStatus(imageState.id, statusPath);

      return {
        attempted: true,
        status: "saved",
        endpoint,
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  listImages(): {
    scope: WorkspaceScopeSummary;
    launcherProfile: LauncherProfileSummary;
    images: WorkspaceImageSummary[];
  } {
    const scope = resolveScope(this.options);
    const projectConfig = loadProjectConfig(scope.projectRoot);
    const state = loadProjectState(statePathForScope(scope, projectConfig));
    const launcherProfile = describePharoLauncherMcpProfile({
      projectRoot: scope.projectRoot,
      config: projectConfig,
      workspaceId: scope.workspaceId,
      targetId: scope.targetId,
      stateRoot: scope.stateRoot,
    });

    return {
      scope: scopeSummary(scope),
      launcherProfile: launcherProfileSummary(launcherProfile),
      images: projectConfig.images.map((imageConfig) =>
        imageSummary(
          imageConfig,
          state?.images.find((image) => image.id === imageConfig.id),
        ),
      ),
    };
  }

  imageInfo(imageId: string): {
    scope: WorkspaceScopeSummary;
    launcherProfile: LauncherProfileSummary;
    image: WorkspaceImageSummary;
  } {
    const listed = this.listImages();
    const image = listed.images.find((candidate) => candidate.imageId === imageId);
    if (!image) {
      throw new ScopedPharoLauncherError(
        `Image ${imageId} is not declared in this PLexus workspace`,
      );
    }

    return {
      scope: listed.scope,
      launcherProfile: listed.launcherProfile,
      image,
    };
  }

  async createImage(
    imageId: string,
    profileId?: string,
  ): Promise<{
    scope: WorkspaceScopeSummary;
    launcherProfile: LauncherProfileSummary;
    image: WorkspaceImageSummary;
  }> {
    const scope = resolveScope(this.options);
    const projectConfig = loadProjectConfig(scope.projectRoot);
    const imageConfig = findImageConfig(projectConfig, imageId);
    if (!imageConfig.create) {
      throw new ScopedPharoLauncherError(
        `Image ${imageId} has no approved create policy in project config`,
      );
    }
    if (profileId && profileId !== imageConfig.create.profileId) {
      throw new ScopedPharoLauncherError(
        `Profile ${profileId} is not approved for image ${imageId}`,
      );
    }

    const statePath = statePathForScope(scope, projectConfig);
    const previousState = loadProjectState(statePath);
    if (previousState?.images.some((image) => image.id === imageId)) {
      throw new ScopedPharoLauncherError(
        `Image ${imageId} already has runtime state`,
      );
    }

    const client =
      this.options.pharoLauncherMcpClient ??
      (await createStdioPharoLauncherMcpClient(undefined, {
        profileEnvironment: pharoLauncherMcpProfileEnvironment({
          projectRoot: scope.projectRoot,
          config: projectConfig,
          workspaceId: scope.workspaceId,
          targetId: scope.targetId,
          stateRoot: scope.stateRoot,
        }),
      }));
    const ownsClient = !this.options.pharoLauncherMcpClient;

    try {
      const state = stateWithCreatedImage(
        projectConfig,
        scope,
        previousState,
        imageId,
        this.options.now?.() ?? new Date(),
      );
      const imageState = state.images.find((image) => image.id === imageId);
      if (!imageState) {
        throw new ScopedPharoLauncherError(
          `Image ${imageId} is not declared in this PLexus workspace`,
        );
      }

      const homeMaterialization = await materializeProjectImageFromHomeCache({
        runtimeClient: client,
        homeClient: this.options.homeImageCacheClient ??
          (this.options.pharoLauncherMcpClient ? client : undefined),
        projectRoot: scope.projectRoot,
        config: projectConfig,
        imageConfig,
        imageState,
        workspaceId: scope.workspaceId,
        targetId: scope.targetId,
        stateRoot: scope.stateRoot,
        approval: scopedMutationApproval(
          this.options.homeImageCacheApproval,
          "scoped-pharo-launcher-create",
        ),
        now: this.options.now,
      });

      if (!homeMaterialization) {
        const result = await client.callTool<LauncherCommandResult>(
          "pharo_launcher_image_create",
          {
            newImageName: renderedImageName(scope, imageConfig),
            templateName: imageConfig.create.templateName,
            ...(imageConfig.create.templateCategory
              ? { templateCategory: imageConfig.create.templateCategory }
              : {}),
            noLaunch: true,
          },
        );
        assertLauncherOk(result, "pharo_launcher_image_create");
      }

      saveProjectState(statePath, state);
    } finally {
      if (ownsClient) {
        await client.close?.();
      }
    }

    return this.imageInfo(imageId);
  }

  async startImage(
    imageId: string,
    displayMode?: ProjectImageDisplayMode,
  ): Promise<{
    scope: WorkspaceScopeSummary;
    launcherProfile: LauncherProfileSummary;
    image: WorkspaceImageSummary;
  }> {
    const before = this.imageInfo(imageId);
    if (!before.image.active) {
      throw new ScopedPharoLauncherError(
        `Image ${imageId} is not active in project config; scoped start is rejected`,
      );
    }
    if (before.image.status === "running" || before.image.status === "starting") {
      throw new ScopedPharoLauncherError(
        `Image ${imageId} is already ${before.image.status}; scoped start is rejected`,
      );
    }

    const scope = resolveScope(this.options);
    await (this.options.projectOpen ?? openProject)({
      projectRoot: scope.projectRoot,
      workspaceId: scope.workspaceId,
      targetId: scope.targetId,
      stateRoot: scope.stateRoot,
      imageIds: [imageId],
      ...(displayMode ? { displayMode } : {}),
      homeImageCacheApproval: scopedMutationApproval(
        this.options.homeImageCacheApproval,
        "scoped-pharo-launcher-start",
      ),
      homeImageCacheClient: this.options.homeImageCacheClient ??
        this.options.pharoLauncherMcpClient,
    });

    return this.imageInfo(imageId);
  }

  async setImageDisplayMode(
    imageId: string,
    displayMode: ProjectImageDisplayMode,
  ): Promise<{
    scope: WorkspaceScopeSummary;
    launcherProfile: LauncherProfileSummary;
    image: WorkspaceImageSummary;
    previousDisplayMode: ProjectImageDisplayMode;
    displayMode: ProjectImageDisplayMode;
    restarted: boolean;
    runtimeStateUnchanged: boolean;
    snapshotBeforeRestart?: DisplayModeRestartSnapshot;
  }> {
    const scope = resolveScope(this.options);
    const projectConfig = loadProjectConfig(scope.projectRoot);
    const imageConfig = findImageConfig(projectConfig, imageId);
    const before = this.imageInfo(imageId);
    const imageState = this.currentImageState(scope, projectConfig, imageId);
    const previousDisplayMode =
      imageState?.displayMode ?? projectImageDisplayMode(imageConfig);
    if (!before.image.active) {
      throw new ScopedPharoLauncherError(
        `Image ${imageId} is not active in project config; display mode change is rejected`,
      );
    }
    if (before.image.status === "starting") {
      throw new ScopedPharoLauncherError(
        `Image ${imageId} is starting; wait for startup to finish before changing display mode`,
      );
    }

    if (before.image.status === "running" && previousDisplayMode === displayMode) {
      return {
        ...before,
        previousDisplayMode,
        displayMode,
        restarted: false,
        runtimeStateUnchanged: true,
      };
    }

    let snapshotBeforeRestart: DisplayModeRestartSnapshot | undefined;
    if (before.image.status === "running") {
      if (imageState) {
        snapshotBeforeRestart =
          await this.snapshotImageBeforeDisplayModeRestart(scope, imageState);
      }
      await this.stopImage(imageId);
    }

    await this.startImage(imageId, displayMode);
    return {
      ...this.imageInfo(imageId),
      previousDisplayMode,
      displayMode,
      restarted: before.image.status === "running",
      runtimeStateUnchanged: false,
      ...(snapshotBeforeRestart ? { snapshotBeforeRestart } : {}),
    };
  }

  async openImageInteractive(
    imageId: string,
  ): Promise<Awaited<ReturnType<ScopedPharoLauncher["setImageDisplayMode"]>>> {
    return this.setImageDisplayMode(imageId, "interactive");
  }

  async showImage(
    imageId: string,
  ): Promise<Awaited<ReturnType<ScopedPharoLauncher["setImageDisplayMode"]>>> {
    return this.setImageDisplayMode(imageId, "interactive");
  }

  async hideImage(
    imageId: string,
  ): Promise<Awaited<ReturnType<ScopedPharoLauncher["setImageDisplayMode"]>>> {
    return this.setImageDisplayMode(imageId, "headless");
  }

  async stopImage(imageId: string): Promise<{
    scope: WorkspaceScopeSummary;
    launcherProfile: LauncherProfileSummary;
    image: WorkspaceImageSummary;
  }> {
    this.imageInfo(imageId);
    const scope = resolveScope(this.options);
    await (this.options.projectClose ?? closeProject)({
      projectRoot: scope.projectRoot,
      workspaceId: scope.workspaceId,
      stateRoot: scope.stateRoot,
      imageIds: [imageId],
    });

    return this.imageInfo(imageId);
  }

  async resetImage(
    imageId: string,
    options: ResetImageOptions = {},
  ): Promise<{
    scope: WorkspaceScopeSummary;
    launcherProfile: LauncherProfileSummary;
    image: WorkspaceImageSummary;
    reset: ScopedImageResetSummary;
  }> {
    const scope = resolveScope(this.options);
    const projectConfig = loadProjectConfig(scope.projectRoot);
    const imageConfig = findImageConfig(projectConfig, imageId);
    if (!imageConfig.active) {
      throw new ScopedPharoLauncherError(
        `Image ${imageId} is not active in project config; scoped reset is rejected`,
      );
    }
    if (!imageConfig.create) {
      throw new ScopedPharoLauncherError(
        `Image ${imageId} has no approved create policy in project config; scoped reset is rejected`,
      );
    }

    const statePath = statePathForScope(scope, projectConfig);
    const previousState = loadProjectState(statePath);
    const previousImage = previousState?.images.find(
      (image) => image.id === imageId,
    );
    if (previousImage?.status === "starting") {
      throw new ScopedPharoLauncherError(
        `Image ${imageId} is starting; wait for startup to finish before resetting`,
      );
    }

    let closeResult: ProjectCloseResult | undefined;
    if (previousImage) {
      try {
        closeResult = await (this.options.projectClose ?? closeProject)({
          projectRoot: scope.projectRoot,
          workspaceId: scope.workspaceId,
          stateRoot: scope.stateRoot,
          imageIds: [imageId],
          pharoLauncherMcpClient: this.options.pharoLauncherMcpClient,
          repositoryWorkspaceCleanupPolicy: "delete-disposable",
        });
      } catch (error) {
        if (error instanceof ProjectCloseError) {
          throw resetCloseError(imageId, error);
        }
        throw error;
      }
    }

    let deleted = false;
    if (previousImage) {
      const client =
        this.options.pharoLauncherMcpClient ??
        (await createStdioPharoLauncherMcpClient(undefined, {
          profileEnvironment: pharoLauncherMcpProfileEnvironment({
            projectRoot: scope.projectRoot,
            config: projectConfig,
            workspaceId: scope.workspaceId,
            targetId: scope.targetId,
            stateRoot: scope.stateRoot,
          }),
        }));
      const ownsClient = !this.options.pharoLauncherMcpClient;

      try {
        const deleteResult = await client.callTool<LauncherCommandResult>(
          "pharo_launcher_image_delete",
          {
            imageName: previousImage.imageName,
            force: true,
            confirm: true,
          },
        );
        assertLauncherOk(deleteResult, "pharo_launcher_image_delete");
        deleted = true;
      } finally {
        if (ownsClient) {
          await client.close?.();
        }
      }

      const currentState = loadProjectState(statePath);
      if (currentState) {
        saveProjectState(
          statePath,
          projectStateWithoutImage(
            currentState,
            imageId,
            this.options.now?.() ?? new Date(),
          ),
        );
      }
    }

    await this.createImage(imageId, imageConfig.create.profileId);
    const shouldStart = options.start ?? true;
    if (shouldStart) {
      await this.startImage(imageId, options.displayMode);
    }

    const finalInfo = this.imageInfo(imageId);
    return {
      ...finalInfo,
      reset: resetSummary(
        imageId,
        closeResult,
        deleted,
        shouldStart,
        finalInfo.image,
        this.currentImageState(scope, projectConfig, imageId),
      ),
    };
  }
}

export const scopedPharoLauncherTools = [
  {
    name: "pharo_launcher_image_list",
    description:
      "List Pharo images declared in the current PLexus project/workspace scope.",
    inputSchema: objectSchema({}),
  },
  {
    name: "pharo_launcher_image_info",
    description:
      "Return scoped state for one Pharo image handle in the current PLexus workspace.",
    inputSchema: objectSchema({ imageId: stringSchema }, ["imageId"]),
  },
  {
    name: "pharo_launcher_image_create",
    description:
      "Create a declared workspace-scoped image from an approved PLexus project create policy.",
    inputSchema: objectSchema(
      {
        imageId: stringSchema,
        profileId: stringSchema,
      },
      ["imageId"],
    ),
  },
  {
    name: "pharo_launcher_image_start",
    description:
      "Start a workspace-scoped active image through PLexus project open policy.",
    inputSchema: objectSchema(
      { imageId: stringSchema, displayMode: displayModeSchema },
      ["imageId"],
    ),
  },
  {
    name: "pharo_launcher_image_open_interactive",
    description:
      "Explicitly open a workspace-scoped active image in interactive display mode for human image work.",
    inputSchema: objectSchema({ imageId: stringSchema }, ["imageId"]),
  },
  {
    name: "pharo_launcher_image_show",
    description:
      "Switch a workspace-scoped active image to interactive display mode through PLexus lifecycle policy.",
    inputSchema: objectSchema({ imageId: stringSchema }, ["imageId"]),
  },
  {
    name: "pharo_launcher_image_hide",
    description:
      "Switch a workspace-scoped active image to headless display mode through PLexus lifecycle policy.",
    inputSchema: objectSchema({ imageId: stringSchema }, ["imageId"]),
  },
  {
    name: "pharo_launcher_image_stop",
    description:
      "Stop one workspace-scoped image through PLexus project close policy.",
    inputSchema: objectSchema(
      {
        imageId: stringSchema,
        confirm: { type: "boolean" },
      },
      ["imageId", "confirm"],
    ),
  },
  {
    name: "pharo_launcher_image_reset",
    description:
      "Reset a disposable workspace-scoped image by closing it, deleting the owned launcher image, recreating it from approved project policy, and reopening unless start is false. Requires confirm: true.",
    inputSchema: objectSchema(
      {
        imageId: stringSchema,
        confirm: { type: "boolean" },
        start: { type: "boolean" },
        displayMode: displayModeSchema,
      },
      ["imageId", "confirm"],
    ),
  },
] as const;

export function createScopedPharoLauncherServer(
  options: ScopedPharoLauncherOptions,
): Server {
  const facade = new ScopedPharoLauncher(options);
  const server = new Server(
    {
      name: "pharo-launcher",
      version: "0.1.0",
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [...scopedPharoLauncherTools],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      const input = objectInput(request.params.arguments ?? {});
      switch (request.params.name) {
        case "pharo_launcher_image_list":
          return textResult(facade.listImages());

        case "pharo_launcher_image_info":
          return textResult(facade.imageInfo(requireString(input, "imageId")));

        case "pharo_launcher_image_create":
          return textResult(
            await facade.createImage(
              requireString(input, "imageId"),
              optionalString(input, "profileId"),
            ),
          );

        case "pharo_launcher_image_start":
          return textResult(
            await facade.startImage(
              requireString(input, "imageId"),
              optionalDisplayMode(input, "displayMode"),
            ),
          );

        case "pharo_launcher_image_open_interactive":
          return textResult(
            await facade.openImageInteractive(requireString(input, "imageId")),
          );

        case "pharo_launcher_image_show":
          return textResult(await facade.showImage(requireString(input, "imageId")));

        case "pharo_launcher_image_hide":
          return textResult(await facade.hideImage(requireString(input, "imageId")));

        case "pharo_launcher_image_stop":
          requireConfirm(input);
          return textResult(await facade.stopImage(requireString(input, "imageId")));

        case "pharo_launcher_image_reset":
          requireConfirm(input);
          return textResult(
            await facade.resetImage(requireString(input, "imageId"), {
              start: optionalBoolean(input, "start"),
              displayMode: optionalDisplayMode(input, "displayMode"),
            }),
          );

        default:
          return textResult(
            { ok: false, error: `Unknown tool: ${request.params.name}` },
            true,
          );
      }
    } catch (error) {
      return textResult(
        {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        },
        true,
      );
    }
  });

  return server;
}

export async function startScopedPharoLauncherServer(
  options: ScopedPharoLauncherOptions,
): Promise<void> {
  const server = createScopedPharoLauncherServer(options);
  await server.connect(new StdioServerTransport());
}
