import fs from "node:fs";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  loadProjectConfig,
  projectImageCreateCleanupPolicy,
  projectImageDisplayMode,
  projectConfigId,
  resolveProjectRuntimePolicy,
  type ProjectConfig,
  type ProjectImageDisplayMode,
  type ProjectImageConfig,
} from "../config/projectConfig.js";
import {
  closeProject,
  ProjectCloseError,
  type ProjectCloseResult,
} from "../lifecycle/projectClose.js";
import {
  HttpGatewayRouteRegistry,
  type ProjectLifecycleRouteRegistry,
} from "../lifecycle/projectLifecycle.js";
import { openProject, ProjectOpenError } from "../lifecycle/projectOpen.js";
import {
  formatToolResultPayload,
  toolResultDetailFromArguments,
  toolResultDetailSchema,
  type ToolResultDetail,
} from "../support/toolResultFormatting.js";
import {
  homeImageCacheNetworkPolicy,
  materializeProjectImageFromHomeCache,
  type HomeImageCacheMutationApproval,
} from "../images/homeImageCache.js";
import {
  observeImageRuntime,
  type ImageRuntimeObservation,
  type ImageRuntimeStatus,
} from "../images/imageRuntime.js";
import {
  createStdioPharoLauncherMcpClient,
  PharoLauncherMcpToolError,
  type PharoLauncherMcpToolClient,
} from "./pharoLauncherMcpClient.js";
import {
  describePharoLauncherMcpProfile,
  pharoLauncherMcpProfileEnvironment,
  type PharoLauncherMcpProfileDiagnostic,
} from "./pharoLauncherProfile.js";
import {
  createProjectState,
  defaultWorkspaceId,
  loadProjectState,
  projectStatePathForConfig,
  projectStateRootForConfig,
  renderProjectImageName,
  runtimeStatusForImages,
  sanitizeRuntimeId,
  saveProjectState,
  type ProjectImageLeaseMode,
  type ProjectImageLeaseOwnerKind,
  type ProjectImageLeaseState,
  type ProjectImageCreationState,
  type ProjectImageMcpEndpoint,
  type ProjectImageState,
  type ProjectState,
} from "../workspace/projectState.js";
import { projectScriptsDirectoryPath } from "../workspace/projectStartupScript.js";
import { dirnamePathLike, joinPathLike } from "../support/pathStyle.js";
import {
  prepareScopedTemplateCatalog,
  templateCategoryNames,
} from "../images/scopedTemplateCatalog.js";

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
  stateRoot?: string;
  imageLease?: ScopedImageLeaseOptions;
  pharoLauncherMcpClient?: PharoLauncherMcpToolClient;
  homeImageCacheClient?: PharoLauncherMcpToolClient;
  homeImageCacheApproval?: HomeImageCacheMutationApproval;
  projectOpen?: typeof openProject;
  projectClose?: typeof closeProject;
  routeRegistry?: ProjectLifecycleRouteRegistry;
  fetch?: typeof fetch;
  now?: () => Date;
  /** Liveness probes, injectable so a test does not depend on the host. */
  isPidAlive?: (pid: number) => boolean;
  isPortListening?: (host: string, port: number) => Promise<boolean>;
}

export interface ScopedImageLeaseOptions {
  ownerId?: string;
  ownerKind?: ProjectImageLeaseOwnerKind;
  purpose?: string;
  repositoryPath?: string;
  branch?: string;
  ttlMs?: number;
  cleanupCommand?: string;
}

interface ResolvedScope {
  projectRoot: string;
  projectId: string;
  projectName: string;
  workspaceId: string;
  stateRoot?: string;
}

interface WorkspaceScopeSummary {
  projectId: string;
  projectName: string;
  workspaceId: string;
}

interface LauncherProfileSummary {
  ownership: PharoLauncherMcpProfileDiagnostic["ownership"];
  mode: PharoLauncherMcpProfileDiagnostic["mode"];
}

interface WorkspaceImageSummary {
  imageId: string;
  /** Observed when the row was built, never read from the state record. */
  status: ImageRuntimeStatus;
  runtime: ImageRuntimeObservation;
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
  lease?: ProjectImageLeaseState;
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
  requiredArgument: "mcpServerId";
  mcpServerId: string;
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
}

interface ResetImageOptions {
  start?: boolean;
  displayMode?: ProjectImageDisplayMode;
}

interface DisplayModeRestartSnapshot {
  attempted: boolean;
  status: "saved";
  endpoint?: ProjectImageMcpEndpoint;
}

interface LauncherCommandResult<T = unknown> {
  ok: boolean;
  data?: T;
}

export class ScopedPharoLauncherError extends Error {
  constructor(
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "ScopedPharoLauncherError";
  }
}

function textResult(
  value: unknown,
  isError = false,
  detail: ToolResultDetail = "summary",
) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(formatToolResultPayload(value, detail), null, 2),
      },
    ],
    ...(isError ? { isError } : {}),
  };
}

function scopedErrorPayload(error: unknown): {
  ok: false;
  error: string;
  cause?: unknown;
} {
  const payload = {
    ok: false as const,
    error: error instanceof Error ? error.message : String(error),
  };

  if (error instanceof PharoLauncherMcpToolError) {
    return {
      ...payload,
      cause: {
        toolName: error.toolName,
        result: error.result,
      },
    };
  }

  if (
    error instanceof ScopedPharoLauncherError &&
    error.details !== undefined
  ) {
    return {
      ...payload,
      cause: error.details,
    };
  }

  return payload;
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

const leaseOwnerKinds = new Set<ProjectImageLeaseOwnerKind>([
  "target",
  "workspace",
  "human",
  "unknown",
]);

function nonEmptyEnv(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function leaseOwnerKindFromText(
  value: string | undefined,
): ProjectImageLeaseOwnerKind | undefined {
  if (!value) {
    return undefined;
  }
  if (!leaseOwnerKinds.has(value as ProjectImageLeaseOwnerKind)) {
    throw new ScopedPharoLauncherError(
      `PLEXUS_IMAGE_LEASE_OWNER_KIND must be one of ${[...leaseOwnerKinds].join(", ")}`,
    );
  }

  return value as ProjectImageLeaseOwnerKind;
}

function leaseTtlMsFromText(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const ttlMs = Number(value);
  if (!Number.isInteger(ttlMs) || ttlMs <= 0) {
    throw new ScopedPharoLauncherError(
      "PLEXUS_IMAGE_LEASE_TTL_MS must be a positive integer",
    );
  }

  return ttlMs;
}

export function scopedImageLeaseOptionsFromEnvironment(
  env: Record<string, string | undefined>,
): ScopedImageLeaseOptions | undefined {
  const ownerId = nonEmptyEnv(env.PLEXUS_IMAGE_LEASE_OWNER_ID);
  const ownerKind = leaseOwnerKindFromText(
    nonEmptyEnv(env.PLEXUS_IMAGE_LEASE_OWNER_KIND),
  );
  const purpose = nonEmptyEnv(env.PLEXUS_IMAGE_LEASE_PURPOSE);
  const repositoryPath = nonEmptyEnv(env.PLEXUS_IMAGE_LEASE_REPOSITORY_PATH);
  const branch = nonEmptyEnv(env.PLEXUS_IMAGE_LEASE_BRANCH);
  const ttlMs = leaseTtlMsFromText(nonEmptyEnv(env.PLEXUS_IMAGE_LEASE_TTL_MS));
  const cleanupCommand = nonEmptyEnv(env.PLEXUS_IMAGE_LEASE_CLEANUP_COMMAND);

  if (
    !ownerId &&
    !ownerKind &&
    !purpose &&
    !repositoryPath &&
    !branch &&
    ttlMs === undefined &&
    !cleanupCommand
  ) {
    return undefined;
  }

  return {
    ...(ownerId ? { ownerId } : {}),
    ...(ownerKind ? { ownerKind } : {}),
    ...(purpose ? { purpose } : {}),
    ...(repositoryPath ? { repositoryPath } : {}),
    ...(branch ? { branch } : {}),
    ...(ttlMs !== undefined ? { ttlMs } : {}),
    ...(cleanupCommand ? { cleanupCommand } : {}),
  };
}

function assertLauncherOk(
  result: LauncherCommandResult | undefined,
  toolName: string,
): void {
  if (result && result.ok === false) {
    throw new ScopedPharoLauncherError(`${toolName} returned ok: false`, {
      toolName,
      result,
    });
  }
}

async function ensureScopedTemplateCatalogReady(options: {
  client: PharoLauncherMcpToolClient;
  scope: ResolvedScope;
  projectConfig: ProjectConfig;
  fetch?: typeof fetch;
}): Promise<void> {
  const runtime = resolveProjectRuntimePolicy(options.projectConfig);
  const launcherProfile = describePharoLauncherMcpProfile({
    projectRoot: options.scope.projectRoot,
    config: options.projectConfig,
    workspaceId: options.scope.workspaceId,
    stateRoot: options.scope.stateRoot,
  });
  const bootstrap = await prepareScopedTemplateCatalog({
    destinationDirectory: launcherProfile.templateSourcesDir,
    policy: runtime.launcherProfile.templateCatalog,
    networkPolicy: homeImageCacheNetworkPolicy(options.projectConfig),
    fetch: options.fetch,
  });
  if (!bootstrap.ok) {
    throw new ScopedPharoLauncherError(bootstrap.message, bootstrap.details);
  }
  if (!bootstrap.refreshTemplateCatalog) {
    return;
  }

  const result = await options.client.callTool<LauncherCommandResult>(
    "pharo_launcher_template_update",
    {},
  );
  assertLauncherOk(result, "pharo_launcher_template_update");
}

function scopedMutationApproval(
  approval: HomeImageCacheMutationApproval | undefined,
  operation: string,
): HomeImageCacheMutationApproval {
  return approval ?? { approved: true, approvalId: operation };
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
    ...(stateRoot ? { stateRoot } : {}),
  };
}

function scopeSummary(scope: ResolvedScope): WorkspaceScopeSummary {
  return {
    projectId: scope.projectId,
    projectName: scope.projectName,
    workspaceId: scope.workspaceId,
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
  runtime: ImageRuntimeObservation,
): WorkspaceImageSummary {
  const defaultDisplayMode = projectImageDisplayMode(imageConfig);
  const displayMode = imageState?.displayMode ?? defaultDisplayMode;
  return {
    imageId: imageConfig.id,
    status: runtime.status,
    runtime,
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
    ...(imageState?.lease ? { lease: imageState.lease } : {}),
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

function leaseOwnerDescription(lease: ProjectImageLeaseState): string {
  return `${lease.ownerKind} ${lease.ownerId}`;
}

function leaseExpired(lease: ProjectImageLeaseState, now: Date): boolean {
  if (!lease.expiresAt) {
    return false;
  }
  const expiresAt = Date.parse(lease.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt <= now.getTime();
}

function sameLeaseOwner(
  left: ProjectImageLeaseState,
  right: ProjectImageLeaseState,
): boolean {
  return left.ownerKind === right.ownerKind && left.ownerId === right.ownerId;
}

function imageLeaseForMutation(
  scope: ResolvedScope,
  options: ScopedImageLeaseOptions | undefined,
  now: Date,
  existingLease?: ProjectImageLeaseState,
  mode: ProjectImageLeaseMode = "mutable",
): ProjectImageLeaseState {
  const ownerId = options?.ownerId ?? scope.workspaceId;
  const ownerKind = options?.ownerKind ?? "workspace";
  const retainedLease =
    existingLease?.ownerId === ownerId && existingLease.ownerKind === ownerKind
      ? existingLease
      : undefined;
  const createdAt = retainedLease?.createdAt ?? now.toISOString();
  const expiresAt =
    options?.ttlMs !== undefined
      ? new Date(now.getTime() + options.ttlMs).toISOString()
      : retainedLease?.expiresAt;

  return {
    ownerId,
    ownerKind,
    mode,
    purpose:
      options?.purpose ??
      retainedLease?.purpose ??
      "Scoped Pharo image lifecycle",
    createdAt,
    heartbeatAt: now.toISOString(),
    ...(expiresAt ? { expiresAt } : {}),
    ...(options?.repositoryPath ?? retainedLease?.repositoryPath
      ? {
          repositoryPath:
            options?.repositoryPath ?? retainedLease?.repositoryPath,
        }
      : {}),
    ...(options?.branch ?? retainedLease?.branch
      ? { branch: options?.branch ?? retainedLease?.branch }
      : {}),
    ...(options?.cleanupCommand ?? retainedLease?.cleanupCommand
      ? {
          cleanupCommand:
            options?.cleanupCommand ?? retainedLease?.cleanupCommand,
        }
      : {}),
  };
}

function assertImageLeaseAllowsMutation(
  imageId: string,
  existingLease: ProjectImageLeaseState | undefined,
  requestedLease: ProjectImageLeaseState,
  now: Date,
): void {
  if (
    !existingLease ||
    leaseExpired(existingLease, now) ||
    sameLeaseOwner(existingLease, requestedLease)
  ) {
    return;
  }

  const expiry = existingLease.expiresAt
    ? ` until ${existingLease.expiresAt}`
    : "";
  throw new ScopedPharoLauncherError(
    `Image ${imageId} is leased to ${leaseOwnerDescription(existingLease)} for ${existingLease.purpose}${expiry}; mutation requires ${leaseOwnerDescription(requestedLease)}`,
  );
}

function stateWithImageLease(
  state: ProjectState,
  imageId: string,
  lease: ProjectImageLeaseState,
  updatedAt: Date,
): ProjectState {
  return {
    ...state,
    images: state.images.map((image) =>
      image.id === imageId ? { ...image, lease } : image,
    ),
    updatedAt: updatedAt.toISOString(),
  };
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
    imageId: imageConfig.id,
  });
}

function imageCreationState(
  imageConfig: ProjectImageConfig,
): ProjectImageCreationState | undefined {
  const create = imageConfig.create;
  if (!create) {
    return undefined;
  }

  return {
    ...(create.role ? { role: create.role } : {}),
    source: {
      kind: create.kind,
      ...(create.profileId ? { profileId: create.profileId } : {}),
      templateName: create.templateName,
      ...(create.templateCategory
        ? { templateCategory: create.templateCategory }
        : {}),
    },
    cleanupPolicy: projectImageCreateCleanupPolicy(create),
    route: {
      serverName: "pharo_gateway",
      targetKey: "workspaceId",
      imageArgument: "mcpServerId",
      imageId: imageConfig.id,
    },
  };
}

function assertPreviousStateBelongsToScope(
  previousState: ProjectState | undefined,
  scope: ResolvedScope,
): void {
  if (!previousState) {
    return;
  }

  if (previousState.projectId !== scope.projectId) {
    throw new ScopedPharoLauncherError(
      `State file belongs to project ${previousState.projectId}; scoped create for project ${scope.projectId} is rejected`,
    );
  }
  if (previousState.workspaceId !== scope.workspaceId) {
    throw new ScopedPharoLauncherError(
      `State file belongs to workspace ${previousState.workspaceId}; scoped create for workspace ${scope.workspaceId} is rejected`,
    );
  }
}

function assertWorkspaceImagePolicyAllowsCreate(
  projectConfig: ProjectConfig,
  previousState: ProjectState | undefined,
  imageId: string,
): void {
  const maxCount =
    resolveProjectRuntimePolicy(projectConfig).workspaceImages?.maxCount;
  if (maxCount === undefined) {
    return;
  }

  const currentImageCount = previousState?.images.length ?? 0;
  if (currentImageCount >= maxCount) {
    throw new ScopedPharoLauncherError(
      `Workspace image policy allows at most ${maxCount} image${maxCount === 1 ? "" : "s"}; scoped create for image ${imageId} is rejected`,
    );
  }
}

function imageMcpSnapshotEndpoint(
  imageState: ProjectImageState,
): ProjectImageMcpEndpoint | undefined {
  return imageState.mcpServers?.find((server) => server.id === imageState.id)
    ?.endpoint;
}

function endpointUrl(endpoint: ProjectImageMcpEndpoint): string {
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
    imageState?.mcpServers?.length,
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
    requiredArgument: "mcpServerId",
    mcpServerId: image.imageId,
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
  };
}

function launcherHoldsImage(
  scope: ResolvedScope,
  projectConfig: ProjectConfig,
  imageName: string,
): boolean {
  const { imagesDir } = describePharoLauncherMcpProfile({
    projectRoot: scope.projectRoot,
    config: projectConfig,
    workspaceId: scope.workspaceId,
    stateRoot: scope.stateRoot,
  });

  // An external profile keeps its own paths, so we cannot look. Answer the way
  // we always behaved there and let the launcher say whether the image is there.
  return imagesDir === undefined || fs.existsSync(joinPathLike(imagesDir, imageName));
}

function stateWithCreatedImage(
  projectConfig: ProjectConfig,
  scope: ResolvedScope,
  previousState: ProjectState | undefined,
  imageId: string,
  now: Date,
): ProjectState {
  const state = createProjectState(projectConfig, {
    previousState,
    workspaceId: scope.workspaceId,
    updatedAt: now.toISOString(),
  });
  const existingImageIds = new Set(
    previousState?.images.map((image) => image.id) ?? [],
  );
  state.images = state.images.filter(
    (image) => image.id === imageId || existingImageIds.has(image.id),
  );

  for (const image of state.images) {
    const previousImage = previousState?.images.find(
      (candidate) => candidate.id === image.id,
    );
    if (image.id === imageId) {
      const imageConfig = findImageConfig(projectConfig, imageId);
      image.status = "stopped";
      delete image.pid;
      image.creation = imageCreationState(imageConfig);
    } else if (previousImage) {
      Object.assign(image, previousImage);
    } else {
      image.status = "stopped";
    }
  }
  state.runtimeStatus = runtimeStatusForImages(state.images);

  return state;
}

async function listTemplatesInCategory(
  client: PharoLauncherMcpToolClient,
  templateCategory?: string,
): Promise<unknown[]> {
  const result = await client.callTool<LauncherCommandResult>(
    "pharo_launcher_template_list",
    templateCategory ? { templateCategory } : {},
  );
  assertLauncherOk(result, "pharo_launcher_template_list");
  const data = result?.data ?? result;
  return Array.isArray(data) ? data : [];
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

  private imageLeaseForMutation(
    scope: ResolvedScope,
    projectConfig: ProjectConfig,
    imageId: string,
    now: Date,
  ): ProjectImageLeaseState {
    const imageState = this.currentImageState(scope, projectConfig, imageId);
    const lease = imageLeaseForMutation(
      scope,
      this.options.imageLease,
      now,
      imageState?.lease,
    );
    assertImageLeaseAllowsMutation(imageId, imageState?.lease, lease, now);
    return lease;
  }

  private recordImageLease(
    scope: ResolvedScope,
    projectConfig: ProjectConfig,
    imageId: string,
    lease: ProjectImageLeaseState,
    now: Date,
  ): ProjectState | undefined {
    const statePath = statePathForScope(scope, projectConfig);
    const state = loadProjectState(statePath);
    if (!state?.images.some((image) => image.id === imageId)) {
      return undefined;
    }

    const nextState = stateWithImageLease(state, imageId, lease, now);
    saveProjectState(statePath, nextState);
    return nextState;
  }

  private routeRegistryForState(
    state: ProjectState,
  ): ProjectLifecycleRouteRegistry | undefined {
    if (this.options.routeRegistry) {
      return this.options.routeRegistry;
    }

    const controlEndpoint = state.gateway?.controlEndpoint;
    return controlEndpoint
      ? new HttpGatewayRouteRegistry({
          url: controlEndpoint,
          fetch: this.options.fetch,
        })
      : undefined;
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

  async listImages(): Promise<{
    scope: WorkspaceScopeSummary;
    launcherProfile: LauncherProfileSummary;
    images: WorkspaceImageSummary[];
  }> {
    const scope = resolveScope(this.options);
    const projectConfig = loadProjectConfig(scope.projectRoot);
    const state = loadProjectState(statePathForScope(scope, projectConfig));
    const launcherProfile = describePharoLauncherMcpProfile({
      projectRoot: scope.projectRoot,
      config: projectConfig,
      workspaceId: scope.workspaceId,
      stateRoot: scope.stateRoot,
    });

    return {
      scope: scopeSummary(scope),
      launcherProfile: launcherProfileSummary(launcherProfile),
      images: await Promise.all(
        projectConfig.images.map(async (imageConfig) => {
          const imageState = state?.images.find(
            (image) => image.id === imageConfig.id,
          );
          return imageSummary(
            imageConfig,
            imageState,
            await observeImageRuntime({
              ...scope,
              ...(this.options.isPidAlive === undefined
                ? {}
                : { isPidAlive: this.options.isPidAlive }),
              ...(this.options.isPortListening === undefined
                ? {}
                : { isPortListening: this.options.isPortListening }),
              imageId: imageConfig.id,
              imageName: renderProjectImageName(imageConfig.imageName, {
                projectId: scope.projectId,
                projectName: scope.projectName,
                workspaceId: scope.workspaceId,
                imageId: imageConfig.id,
              }),
              ...(launcherProfile.imagesDir === undefined
                ? {}
                : { imagesDirectory: launcherProfile.imagesDir }),
              ...(imageState?.pid === undefined ? {} : { pid: imageState.pid }),
            }),
          );
        }),
      ),
    };
  }

  async imageInfo(imageId: string): Promise<{
    scope: WorkspaceScopeSummary;
    launcherProfile: LauncherProfileSummary;
    image: WorkspaceImageSummary;
  }> {
    const listed = await this.listImages();
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

  private async withLauncherClient<T>(
    scope: ResolvedScope,
    projectConfig: ProjectConfig,
    action: (client: PharoLauncherMcpToolClient) => Promise<T>,
  ): Promise<T> {
    const client =
      this.options.pharoLauncherMcpClient ??
      (await createStdioPharoLauncherMcpClient(undefined, {
        profileEnvironment: pharoLauncherMcpProfileEnvironment({
          projectRoot: scope.projectRoot,
          config: projectConfig,
          workspaceId: scope.workspaceId,
          stateRoot: scope.stateRoot,
        }),
      }));
    const ownsClient = !this.options.pharoLauncherMcpClient;

    try {
      return await action(client);
    } finally {
      if (ownsClient) {
        await client.close?.();
      }
    }
  }

  async listTemplates(templateCategory?: string): Promise<{
    scope: WorkspaceScopeSummary;
    launcherProfile: LauncherProfileSummary;
    templates: unknown;
  }> {
    const scope = resolveScope(this.options);
    const projectConfig = loadProjectConfig(scope.projectRoot);
    const templates = await this.withLauncherClient(
      scope,
      projectConfig,
      async (client) => {
        await ensureScopedTemplateCatalogReady({
          client,
          scope,
          projectConfig,
          fetch: this.options.fetch,
        });
        if (templateCategory) {
          return await listTemplatesInCategory(client, templateCategory);
        }

        // Without a category the launcher answers from its default group only,
        // so a caller naming a template from any other group is told it does
        // not exist. Walk the categories and say which one each came from.
        const categories = templateCategoryNames(
          describePharoLauncherMcpProfile({
            projectRoot: scope.projectRoot,
            config: projectConfig,
            workspaceId: scope.workspaceId,
            stateRoot: scope.stateRoot,
          }).templateSourcesDir,
        );
        if (categories.length === 0) {
          return await listTemplatesInCategory(client);
        }

        const listed: unknown[] = [];
        for (const category of categories) {
          let templates: unknown[];
          try {
            templates = await listTemplatesInCategory(client, category);
          } catch {
            // A group the sources list names but this launcher cannot open.
            continue;
          }
          for (const template of templates) {
            listed.push(
              isObject(template) ? { ...template, templateCategory: category } : template,
            );
          }
        }
        return listed;
      },
    );

    return {
      ...this.templateScopeSummary(scope, projectConfig),
      templates,
    };
  }

  async listTemplateCategories(): Promise<{
    scope: WorkspaceScopeSummary;
    launcherProfile: LauncherProfileSummary;
    templateCategories: unknown;
  }> {
    const scope = resolveScope(this.options);
    const projectConfig = loadProjectConfig(scope.projectRoot);
    const templateCategories = await this.withLauncherClient(
      scope,
      projectConfig,
      async (client) => {
        await ensureScopedTemplateCatalogReady({
          client,
          scope,
          projectConfig,
          fetch: this.options.fetch,
        });
        const result = await client.callTool<LauncherCommandResult>(
          "pharo_launcher_template_category_list",
          {},
        );
        assertLauncherOk(result, "pharo_launcher_template_category_list");
        return result?.data ?? result;
      },
    );

    return {
      ...this.templateScopeSummary(scope, projectConfig),
      templateCategories,
    };
  }

  private templateScopeSummary(
    scope: ResolvedScope,
    projectConfig: ProjectConfig,
  ): {
    scope: WorkspaceScopeSummary;
    launcherProfile: LauncherProfileSummary;
  } {
    return {
      scope: scopeSummary(scope),
      launcherProfile: launcherProfileSummary(
        describePharoLauncherMcpProfile({
          projectRoot: scope.projectRoot,
          config: projectConfig,
          workspaceId: scope.workspaceId,
          stateRoot: scope.stateRoot,
        }),
      ),
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
    assertPreviousStateBelongsToScope(previousState, scope);
    if (previousState?.images.some((image) => image.id === imageId)) {
      throw new ScopedPharoLauncherError(
        `Image ${imageId} already has runtime state`,
      );
    }
    assertWorkspaceImagePolicyAllowsCreate(projectConfig, previousState, imageId);
    const now = this.options.now?.() ?? new Date();
    const lease = this.imageLeaseForMutation(scope, projectConfig, imageId, now);
    const state = stateWithCreatedImage(
      projectConfig,
      scope,
      previousState,
      imageId,
      now,
    );
    const imageState = state.images.find((image) => image.id === imageId);
    if (!imageState) {
      throw new ScopedPharoLauncherError(
        `Image ${imageId} is not declared in this PLexus workspace`,
      );
    }

    const client =
      this.options.pharoLauncherMcpClient ??
      (await createStdioPharoLauncherMcpClient(undefined, {
        profileEnvironment: pharoLauncherMcpProfileEnvironment({
          projectRoot: scope.projectRoot,
          config: projectConfig,
          workspaceId: scope.workspaceId,
          stateRoot: scope.stateRoot,
        }),
      }));
    const ownsClient = !this.options.pharoLauncherMcpClient;

    try {
      const homeMaterialization = await materializeProjectImageFromHomeCache({
        runtimeClient: client,
        homeClient: this.options.homeImageCacheClient ??
          (this.options.pharoLauncherMcpClient ? client : undefined),
        projectRoot: scope.projectRoot,
        config: projectConfig,
        imageConfig,
        imageState,
        workspaceId: scope.workspaceId,
        stateRoot: scope.stateRoot,
        approval: scopedMutationApproval(
          this.options.homeImageCacheApproval,
          "scoped-pharo-launcher-create",
        ),
        now: this.options.now,
      });

      if (!homeMaterialization) {
        await ensureScopedTemplateCatalogReady({
          client,
          scope,
          projectConfig,
          fetch: this.options.fetch,
        });
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

      const nextState = stateWithImageLease(state, imageId, lease, now);
      saveProjectState(statePath, nextState);
    } finally {
      if (ownsClient) {
        await client.close?.();
      }
    }

    return await this.imageInfo(imageId);
  }

  async startImage(
    imageId: string,
    displayMode?: ProjectImageDisplayMode,
  ): Promise<{
    scope: WorkspaceScopeSummary;
    launcherProfile: LauncherProfileSummary;
    image: WorkspaceImageSummary;
  }> {
    const before = await this.imageInfo(imageId);
    if (before.image.status === "running" || before.image.status === "starting") {
      throw new ScopedPharoLauncherError(
        `Image ${imageId} is already ${before.image.status}; scoped start is rejected`,
      );
    }

    const scope = resolveScope(this.options);
    const projectConfig = loadProjectConfig(scope.projectRoot);
    const now = this.options.now?.() ?? new Date();
    const lease = this.imageLeaseForMutation(scope, projectConfig, imageId, now);
    const openResult = await this.startingImage(imageId, () =>
      (this.options.projectOpen ?? openProject)({
      projectRoot: scope.projectRoot,
      workspaceId: scope.workspaceId,
      stateRoot: scope.stateRoot,
      imageIds: [imageId],
      ...(displayMode ? { displayMode } : {}),
      homeImageCacheApproval: scopedMutationApproval(
        this.options.homeImageCacheApproval,
        "scoped-pharo-launcher-start",
      ),
      homeImageCacheClient: this.options.homeImageCacheClient ??
        this.options.pharoLauncherMcpClient,
      }),
    );
    const statePath = statePathForScope(scope, projectConfig);
    const leasedState = this.recordImageLease(
      scope,
      projectConfig,
      imageId,
      lease,
      now,
    );

    return await this.imageInfo(imageId);
  }

  /**
   * "One or more project images failed to open" tells the caller nothing it can
   * act on. The per-image failure says what actually happened — which VM holds
   * the image, which tool frees it — so raise that instead.
   */
  private async startingImage<T>(
    imageId: string,
    start: () => Promise<T>,
  ): Promise<T> {
    try {
      return await start();
    } catch (error) {
      if (!(error instanceof ProjectOpenError)) {
        throw error;
      }

      const failure = error.result.failures.find(
        (candidate) => candidate.imageId === imageId,
      );

      throw failure
        ? new ScopedPharoLauncherError(failure.message)
        : error;
    }
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
    const before = await this.imageInfo(imageId);
    const imageState = this.currentImageState(scope, projectConfig, imageId);
    const previousDisplayMode =
      imageState?.displayMode ?? projectImageDisplayMode(imageConfig);
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

    this.imageLeaseForMutation(
      scope,
      projectConfig,
      imageId,
      this.options.now?.() ?? new Date(),
    );

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
      ...(await this.imageInfo(imageId)),
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
    await this.imageInfo(imageId);
    const scope = resolveScope(this.options);
    const projectConfig = loadProjectConfig(scope.projectRoot);
    const now = this.options.now?.() ?? new Date();
    const lease = this.imageLeaseForMutation(scope, projectConfig, imageId, now);
    const closeResult = await (this.options.projectClose ?? closeProject)({
      projectRoot: scope.projectRoot,
      workspaceId: scope.workspaceId,
      stateRoot: scope.stateRoot,
      imageIds: [imageId],
    });
    const statePath = statePathForScope(scope, projectConfig);
    const leasedState = this.recordImageLease(
      scope,
      projectConfig,
      imageId,
      lease,
      now,
    );

    return await this.imageInfo(imageId);
  }

  private assertResetImageConfig(
    imageId: string,
    imageConfig: ProjectImageConfig,
  ): asserts imageConfig is ProjectImageConfig & {
    create: NonNullable<ProjectImageConfig["create"]>;
  } {
    if (!imageConfig.create) {
      throw new ScopedPharoLauncherError(
        `Image ${imageId} has no approved create policy in project config; scoped reset is rejected`,
      );
    }
  }

  private async deleteLauncherImage(
    scope: ResolvedScope,
    projectConfig: ProjectConfig,
    imageName: string,
  ): Promise<void> {
    const client =
      this.options.pharoLauncherMcpClient ??
      (await createStdioPharoLauncherMcpClient(undefined, {
        profileEnvironment: pharoLauncherMcpProfileEnvironment({
          projectRoot: scope.projectRoot,
          config: projectConfig,
          workspaceId: scope.workspaceId,
          stateRoot: scope.stateRoot,
        }),
      }));
    const ownsClient = !this.options.pharoLauncherMcpClient;

    try {
      const deleteResult = await client.callTool<LauncherCommandResult>(
        "pharo_launcher_image_delete",
        { imageName, force: true, confirm: true },
      );
      assertLauncherOk(deleteResult, "pharo_launcher_image_delete");
    } finally {
      if (ownsClient) {
        await client.close?.();
      }
    }
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
    this.assertResetImageConfig(imageId, imageConfig);

    const statePath = statePathForScope(scope, projectConfig);
    const previousState = loadProjectState(statePath);
    const previousImage = previousState?.images.find(
      (image) => image.id === imageId,
    );
    if (previousImage) {
      this.imageLeaseForMutation(
        scope,
        projectConfig,
        imageId,
        this.options.now?.() ?? new Date(),
      );
    }
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
      // A record can outlive the image it names: an open that failed before
      // the launcher made the files leaves one behind. Deleting what is not
      // there fails, and a reset that cannot run is the only way out of that
      // record, so delete only what the profile actually holds.
      if (launcherHoldsImage(scope, projectConfig, previousImage.imageName)) {
        await this.deleteLauncherImage(
          scope,
          projectConfig,
          previousImage.imageName,
        );
        deleted = true;
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

    const finalInfo = await this.imageInfo(imageId);
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
    inputSchema: objectSchema({ detail: toolResultDetailSchema }),
  },
  {
    name: "pharo_launcher_image_info",
    description:
      "Return scoped state for one Pharo image handle in the current PLexus workspace.",
    inputSchema: objectSchema({ imageId: stringSchema, detail: toolResultDetailSchema }, ["imageId"]),
  },
  {
    name: "pharo_launcher_template_list",
    description:
      "List the Pharo Launcher image templates available to the current PLexus project scope.",
    inputSchema: objectSchema({
      templateCategory: stringSchema,
      detail: toolResultDetailSchema,
    }),
  },
  {
    name: "pharo_launcher_template_category_list",
    description:
      "List the Pharo Launcher template categories available to the current PLexus project scope.",
    inputSchema: objectSchema({ detail: toolResultDetailSchema }),
  },
  {
    name: "pharo_launcher_image_create",
    description:
      "Create a declared workspace-scoped image from an approved PLexus project create policy.",
    inputSchema: objectSchema(
      {
        imageId: stringSchema,
        profileId: stringSchema,
      detail: toolResultDetailSchema,
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
    inputSchema: objectSchema({ imageId: stringSchema, detail: toolResultDetailSchema }, ["imageId"]),
  },
  {
    name: "pharo_launcher_image_show",
    description:
      "Switch a workspace-scoped active image to interactive display mode through PLexus lifecycle policy.",
    inputSchema: objectSchema({ imageId: stringSchema, detail: toolResultDetailSchema }, ["imageId"]),
  },
  {
    name: "pharo_launcher_image_hide",
    description:
      "Switch a workspace-scoped active image to headless display mode through PLexus lifecycle policy.",
    inputSchema: objectSchema({ imageId: stringSchema, detail: toolResultDetailSchema }, ["imageId"]),
  },
  {
    name: "pharo_launcher_image_stop",
    description:
      "Stop the process PLexus started for one workspace-scoped image. Stops only that process, never another VM on the same image.",
    inputSchema: objectSchema(
      {
        imageId: stringSchema,
        detail: toolResultDetailSchema,
      },
      ["imageId"],
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
      detail: toolResultDetailSchema,
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
    const input = request.params.arguments ?? {};
    const detail = toolResultDetailFromArguments(input);

    try {
      switch (request.params.name) {
        case "pharo_launcher_image_list":
          return textResult(await facade.listImages(), false, detail);

        case "pharo_launcher_image_info":
          return textResult(
            await facade.imageInfo(requireString(input, "imageId")),
            false,
            detail,
          );

        case "pharo_launcher_template_list":
          return textResult(
            await facade.listTemplates(optionalString(input, "templateCategory")),
            false,
            detail,
          );

        case "pharo_launcher_template_category_list":
          return textResult(await facade.listTemplateCategories(), false, detail);

        case "pharo_launcher_image_create":
          return textResult(
            await facade.createImage(
              requireString(input, "imageId"),
              optionalString(input, "profileId"),
            ),
            false,
            detail,
          );

        case "pharo_launcher_image_start":
          return textResult(
            await facade.startImage(
              requireString(input, "imageId"),
              optionalDisplayMode(input, "displayMode"),
            ),
            false,
            detail,
          );

        case "pharo_launcher_image_open_interactive":
          return textResult(
            await facade.openImageInteractive(requireString(input, "imageId")),
            false,
            detail,
          );

        case "pharo_launcher_image_show":
          return textResult(
            await facade.showImage(requireString(input, "imageId")),
            false,
            detail,
          );

        case "pharo_launcher_image_hide":
          return textResult(
            await facade.hideImage(requireString(input, "imageId")),
            false,
            detail,
          );

        case "pharo_launcher_image_stop":
          return textResult(
            await facade.stopImage(requireString(input, "imageId")),
            false,
            detail,
          );

        case "pharo_launcher_image_reset":
          requireConfirm(input);
          return textResult(
            await facade.resetImage(requireString(input, "imageId"), {
              start: optionalBoolean(input, "start"),
              displayMode: optionalDisplayMode(input, "displayMode"),
            }),
            false,
            detail,
          );

        default:
          return textResult(
            { ok: false, error: `Unknown tool: ${request.params.name}` },
            true,
            detail,
          );
      }
    } catch (error) {
      return textResult(scopedErrorPayload(error), true, detail);
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
