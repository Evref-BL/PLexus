import fs from "node:fs";
import path from "node:path";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  defaultImagePortClaimChecks,
  imagePortClaimsRootForConfig,
} from "./imagePortClaims.js";
import {
  rescueImage,
  type ImageRescueEntrySelection,
  type ImageRescueOperation,
  type ImageRescueOptions,
  type ImageRescueRepositoryAction,
  type ImageRescueResult,
} from "./imageRescue.js";
import {
  loadProjectConfig,
  plexusProjectConfigFileName,
  projectConfigId,
  ProjectConfigError,
  resolveProjectRuntimePolicy,
  type ProjectConfig,
  type ProjectImageDisplayMode,
  type ProjectImagePortAllocationPolicy,
  type ProjectImagePortCoordinationMode,
  type ProjectRemoteNodeConfig,
  type ProjectRemoteNodeWorkspaceMappingConfig,
  type ProjectRuntimePortRange,
  type ProjectRuntimePolicy,
} from "./projectConfig.js";
import { closeProject, type ProjectCloseResult } from "./projectClose.js";
import {
  cleanupProjectOwnedResources,
  type ProjectCleanupResource,
  type ProjectCleanupResult,
} from "./projectCleanup.js";
import {
  closeProjectGateway,
  ensureProjectGateway,
  projectGatewayStatus,
  type ProjectGatewayRuntimeOptions,
} from "./projectGateway.js";
import {
  inspectPortClaim,
  listPortClaims,
  releasePortClaim,
  type PortClaimChecks,
  type PortClaimInspection,
  type PortClaimRecord,
} from "./portClaims.js";
import {
  flushHomeImageCache,
  homeImageCacheManifestPath,
  homeImageCacheProfile,
  homeImageCacheRootPath,
  listHomeImageCacheManifests,
  planHomeImageCacheFlush,
  profileEnvironmentFromPaths,
  readHomeImageCacheManifest,
  resolvePlexusHomePath,
  type HomeImageCacheFlushPlan,
  type HomeImageCacheManifest,
  type HomeImageCacheManifestReadResult,
} from "./homeImageCache.js";
import {
  createStdioPharoLauncherMcpClient,
  type PharoLauncherMcpToolClient,
} from "./pharoLauncherMcpClient.js";
import {
  openProject,
  ProjectOpenError,
  type ProjectOpenResult,
} from "./projectOpen.js";
import {
  inspectProjectImageRepositoryWorkspace,
} from "./projectRepositoryWorkspace.js";
import {
  defaultPlexusStateRoot,
  defaultTargetId,
  defaultWorkspaceId,
  loadProjectState,
  projectStateRootForConfig,
  projectStatePathForConfig,
  projectImageRepositoryWorkspaceStates,
  projectImageRepositoryWorkspaces,
  renderProjectImageName,
  runtimeStatusForImages,
  sanitizeRuntimeId,
  saveProjectState,
  type ProjectImageMcpEndpoint,
  type ProjectImageRepositoryWorkspaceCleanupPolicy,
  type ProjectImageRepositoryWorkspaceCleanupRecord,
  type ProjectImageRepositoryWorkspaceState,
  type ProjectImageState,
  type ProjectGatewayState,
  type ProjectState,
} from "./projectState.js";
import {
  describePharoLauncherMcpProfile,
  type PharoLauncherMcpProfileDiagnostic,
} from "./pharoLauncherProfile.js";
import {
  buildScopedProjectContext,
  type ScopedProjectContext,
} from "./scopedProjectContext.js";
import {
  plexusRuntimeIdentity,
  type PlexusRuntimeIdentityDiagnostic,
} from "./runtimeIdentity.js";

export interface ProjectLifecycleRouteReference {
  projectId?: string;
  workspaceId?: string;
  targetId?: string;
}

export interface ProjectLifecycleRouteRegistration {
  projectRoot: string;
  statePath: string;
  state: ProjectState;
}

export interface ProjectLifecycleRouteRegistry {
  registerProjectRoute(
    input: ProjectLifecycleRouteRegistration,
  ): Promise<unknown> | unknown;
  unregisterProjectRoute(
    input: ProjectLifecycleRouteReference,
  ): Promise<unknown> | unknown;
  getRouteStatus?(
    input: ProjectLifecycleRouteReference & { refreshHealth?: boolean },
  ): Promise<unknown> | unknown;
}

export interface ProjectLifecycleImageToolCaller {
  callImageTool(
    reference: ProjectLifecycleRouteReference,
    imageId: string,
    toolName: string,
    argumentsValue: Record<string, unknown>,
  ): Promise<unknown>;
}

export interface ProjectLifecycleRemoteClient {
  callTool<T = unknown>(
    toolName: string,
    argumentsValue: Record<string, unknown>,
  ): Promise<ProjectLifecycleToolResult<T>>;
}

export interface HttpProjectLifecycleClientOptions {
  url: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

interface ProjectRemoteLifecycleMapping {
  remoteNode: ProjectRemoteNodeConfig;
  workspace?: ProjectRemoteNodeWorkspaceMappingConfig;
  target?: NonNullable<
    ProjectRemoteNodeWorkspaceMappingConfig["targets"]
  >[number];
  workspaceId: string;
}

interface ProjectHostRemoteRouteContext {
  projectRoot: string;
  config: ProjectConfig;
  stateRoot: string;
  statePath: string;
  projectId: string;
  workspaceId: string;
  targetId: string;
}

export interface HttpGatewayRouteRegistryOptions {
  url?: string;
  host?: string;
  port?: number;
  path?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

const defaultGatewayRouteControlMcpPath = "/control-mcp";
const defaultPharoToolsDiscoveryTimeoutMs = 5_000;

export interface ProjectLifecycleOptions {
  routeRegistry?: ProjectLifecycleRouteRegistry;
  imageToolCaller?: ProjectLifecycleImageToolCaller;
  homeImageCacheClient?: PharoLauncherMcpToolClient;
  remoteClientFactory?: (
    remoteNode: ProjectRemoteNodeConfig,
  ) => ProjectLifecycleRemoteClient;
  defaultStateRoot?: string;
  projectOpen?: typeof openProject;
  projectClose?: typeof closeProject;
  imageRescue?: typeof rescueImage;
  gateway?: ProjectGatewayRuntimeOptions & {
    routeRegistryTimeoutMs?: number;
  };
}

export interface ProjectOpenToolInput {
  projectPath: string;
  sourcePath?: string;
  stateRoot?: string;
  workspaceId?: string;
  targetId?: string;
  displayMode?: ProjectImageDisplayMode;
}

export interface ProjectCloseToolInput {
  projectPath: string;
  stateRoot?: string;
  workspaceId?: string;
  repositoryWorkspaceCleanupPolicy?: ProjectImageRepositoryWorkspaceCleanupPolicy;
  repositoryWorkspaceArchiveRoot?: string;
}

export interface ProjectCleanupToolInput {
  projectPath: string;
  stateRoot?: string;
  workspaceId?: string;
  confirm?: boolean;
  deleteStateFile?: boolean;
  deleteLauncherImages?: boolean;
  repositoryWorkspaceCleanupPolicy?: ProjectImageRepositoryWorkspaceCleanupPolicy;
  repositoryWorkspaceArchiveRoot?: string;
}

export interface ProjectStatusToolInput extends ProjectLifecycleRouteReference {
  projectPath?: string;
  sourcePath?: string;
  stateRoot?: string;
  refreshHealth?: boolean;
  includeDiagnostics?: boolean;
}

export interface RescueImageToolInput extends ProjectStatusToolInput {
  operation: ImageRescueOperation;
  sourceImageId: string;
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
}

export interface ProjectHomeImageCacheToolInput {
  projectPath: string;
  key?: string;
}

export interface ProjectHomeImageCacheFlushToolInput
  extends ProjectHomeImageCacheToolInput {
  confirm?: boolean;
}

export interface ProjectHomeImageCacheEntryStatus {
  key: string;
  status: HomeImageCacheManifestReadResult["status"];
  manifestPath: string;
  cacheImageName?: string;
  preparationStatus?: string;
  supportStatus?: string;
  createdAt?: string;
  updatedAt?: string;
  error?: string;
}

export interface ProjectHomeImageCacheStatus {
  projectRoot: string;
  homePath: string;
  cacheRoot: string;
  entries: ProjectHomeImageCacheEntryStatus[];
}

export interface ProjectHomeImageCacheFlushResult
  extends ProjectHomeImageCacheStatus {
  deletedImages: string[];
  flushedEntries: HomeImageCacheFlushPlan["entries"];
}

interface LauncherCommandResult {
  ok: boolean;
}

export interface ProjectLifecycleStatus {
  projectRoot?: string;
  stateRoot?: string;
  statePath?: string;
  projectId?: string;
  workspaceId?: string;
  targetId?: string;
  context?: ScopedProjectContext;
  state?: ProjectState;
  gateway?: ProjectGatewayState;
  route?: unknown;
  diagnostics?: ProjectLifecycleDiagnostics;
}

export type ProjectLifecycleRuntimeDiagnosticStatus =
  | "operational"
  | "idle"
  | "degraded"
  | "not-opened";

export type ProjectLifecycleRuntimeDiagnosticHealth =
  | "operational"
  | "degraded"
  | "unknown";

export interface ProjectLifecyclePortClaimDiagnostic {
  claimsRoot: string;
  port: number;
  status: "claimed" | "stale" | "unreadable";
  record?: PortClaimRecord;
  reason?: string;
  ownedByCurrentScope?: boolean;
}

export interface ProjectLifecyclePortClaimsDiagnostics {
  roots: string[];
  active: ProjectLifecyclePortClaimDiagnostic[];
  stale: ProjectLifecyclePortClaimDiagnostic[];
  conflicts: ProjectLifecyclePortClaimDiagnostic[];
  otherScopes: ProjectLifecyclePortClaimDiagnostic[];
}

export type ProjectLifecycleImagePortCoordinationBasis =
  | "host-local-claims"
  | "project-state-scanning";

export interface ProjectLifecycleImagePortCoordinationDiagnostics {
  mode: ProjectImagePortCoordinationMode;
  basis: ProjectLifecycleImagePortCoordinationBasis;
  message: string;
  claimsRoot?: string;
  stateRoot?: string;
}

export interface ProjectLifecyclePortListenerDiagnostic {
  port: number;
  purpose: "gateway" | "image-mcp";
  imageId?: string;
  expectedOwner: string;
  message: string;
}

export interface ProjectLifecycleRouteTableDiagnostics {
  targetId?: string;
  status:
    | "registered"
    | "missing"
    | "unavailable"
    | "not-configured"
    | "gateway-dead";
  statePath?: string;
  expectedStatePath?: string;
  routableImages: Array<{
    imageId: string;
    port?: number;
    mcpEndpoint?: ProjectImageState["mcpEndpoint"];
    routingMode?: "endpoint" | "fixed-port" | "none";
    status?: string;
    routable?: unknown;
  }>;
  error?: string;
}

export interface ProjectLifecycleProjectDiagnostics {
  declaredImageCount: number;
  activeImageCount: number;
  runtimeImageCount: number;
}

export interface ProjectLifecycleImagePortPolicyDiagnostics {
  allocation: ProjectImagePortAllocationPolicy;
  range: ProjectRuntimePortRange;
  coordinationMode: ProjectImagePortCoordinationMode;
  configuredRoot?: string;
  effectiveClaimsRoot?: string;
  projectStateRoot: string;
  basis: "host-local-claims" | "project-state";
}

export interface ProjectLifecycleAgentAccessDiagnostics {
  expectedSurface: "pharo_gateway";
  gatewayRouted: boolean;
  portsHiddenFromAgents: boolean;
  reason: string;
}

export interface ProjectLifecycleGatewayRepairAffordance {
  allowed: true;
  toolName: "plexus_project_open";
  arguments: {
    projectPath: string;
    stateRoot: string;
    workspaceId: string;
    targetId: string;
  };
  reason: string;
}

export interface ProjectLifecycleGatewayDiagnostics {
  mode: ProjectGatewayState["mode"];
  status: "shared" | "running" | "dead" | "not-started";
  health: ProjectLifecycleRuntimeDiagnosticHealth;
  reason: string;
  endpoint?: string;
  controlEndpoint?: string;
  host?: string;
  port?: number;
  portRange?: ProjectGatewayState["portRange"];
  managedByProject: boolean;
  pid?: number;
  stale?: {
    endpoint?: string;
    controlEndpoint?: string;
    port?: number;
    pid?: number;
    claim?: ProjectGatewayState["claim"];
  };
  repair?: ProjectLifecycleGatewayRepairAffordance;
}

export interface ProjectLifecycleRepositoryWorkspaceDiagnostic {
  imageId: string;
  imageName: string;
  status: ProjectImageState["status"] | "declared";
  workspace: ProjectImageRepositoryWorkspaceState;
  cleanup: {
    defaultPolicy: "preserve";
    destructivePolicyRequired: true;
    reviewRequired: boolean;
    recommendedAction: "none" | "materialize" | "review" | "repair";
    message: string;
    lastDecision?: ProjectImageRepositoryWorkspaceCleanupRecord;
  };
}

export interface ProjectLifecycleDependencyRepositoryDetachDiagnostic {
  imageId: string;
  imageName: string;
  status: ProjectImageState["status"];
  detach: NonNullable<ProjectImageState["dependencyRepositoryDetach"]>;
}

export interface ProjectLifecycleImageRecoveryAction {
  operation: Extract<ImageRescueOperation, "plan" | "prepareTarget">;
  toolName: "plexus_rescue_image";
  arguments: {
    projectPath: string;
    stateRoot: string;
    workspaceId: string;
    sourceImageId: string;
    operation: Extract<ImageRescueOperation, "plan" | "prepareTarget">;
  };
}

export interface ProjectLifecycleImageRecoveryDiagnostic {
  imageId: string;
  imageName: string;
  status: "failed";
  message: string;
  paths: {
    imagePath?: string;
    imageDirectoryPath?: string;
    changesPath?: string;
    localDirectoryPath?: string;
    ombuDirectoryPath?: string;
  };
  actions: ProjectLifecycleImageRecoveryAction[];
}

export interface ProjectLifecycleRemoteTopologyDiagnostics {
  nodeId: string;
  policy: "flat-tree";
  status: "local-only" | "flat";
  remoteNodeIds: string[];
  remoteNodes: Array<{
    id: string;
    parentNodeId?: string;
    mappedWorkspaceIds: string[];
  }>;
}

export interface ProjectLifecycleDiagnostics {
  toolRuntime: PlexusRuntimeIdentityDiagnostic;
  runtime: {
    status: ProjectLifecycleRuntimeDiagnosticStatus;
    health: ProjectLifecycleRuntimeDiagnosticHealth;
    reason: string;
  };
  project: ProjectLifecycleProjectDiagnostics;
  scope: {
    projectRoot: string;
    sourcePath: string;
    stateRoot: string;
    statePath: string;
    projectId: string;
    workspaceId: string;
    targetId: string;
  };
  gateway: ProjectLifecycleGatewayDiagnostics;
  runtimePolicy: ProjectRuntimePolicy;
  remoteTopology: ProjectLifecycleRemoteTopologyDiagnostics;
  imagePortPolicy: ProjectLifecycleImagePortPolicyDiagnostics;
  launcherProfile: PharoLauncherMcpProfileDiagnostic;
  agentAccess: ProjectLifecycleAgentAccessDiagnostics;
  repositoryWorkspaces: ProjectLifecycleRepositoryWorkspaceDiagnostic[];
  dependencyRepositoryDetaches: ProjectLifecycleDependencyRepositoryDetachDiagnostic[];
  imageRecovery: ProjectLifecycleImageRecoveryDiagnostic[];
  imageMcpPorts: Array<{
    imageId: string;
    imageName: string;
    displayMode?: ProjectImageDisplayMode;
    port?: number;
    mcpEndpoint?: ProjectImageState["mcpEndpoint"];
    routingMode: "endpoint" | "fixed-port" | "none";
    status: ProjectImageState["status"];
    pid?: number;
  }>;
  imagePortCoordination: ProjectLifecycleImagePortCoordinationDiagnostics;
  portClaims: ProjectLifecyclePortClaimsDiagnostics;
  conflictingListeners: ProjectLifecyclePortListenerDiagnostic[];
  staleClaims: ProjectLifecyclePortClaimDiagnostic[];
  routeTable: ProjectLifecycleRouteTableDiagnostics;
}

export interface ProjectLifecycleToolResult<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
  diagnostics?: ProjectLifecycleToolFailureDiagnostics;
}

export interface ProjectLifecycleToolFailureDiagnostics {
  toolRuntime: PlexusRuntimeIdentityDiagnostic;
  projectOpen?: {
    statePath: string;
    failures: ProjectOpenResult["failures"];
    images: ProjectOpenResult["state"]["images"];
  };
  projectConfig?: {
    issues: string[];
  };
}

class ProjectLifecycleInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectLifecycleInputError";
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isProjectImageMcpEndpoint(
  value: unknown,
): value is ProjectImageMcpEndpoint {
  return (
    isObject(value) &&
    value.transport === "http" &&
    typeof value.host === "string" &&
    typeof value.port === "number" &&
    Number.isInteger(value.port) &&
    typeof value.path === "string"
  );
}

function requireString(
  input: Record<string, unknown>,
  key: string,
): string {
  const value = input[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new ProjectLifecycleInputError(`${key} is required`);
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
    throw new ProjectLifecycleInputError(`${key} must be a non-empty string`);
  }

  return value;
}

function optionalBoolean(input: Record<string, unknown>, key: string): boolean {
  const value = input[key];
  if (value === undefined) {
    return false;
  }

  if (typeof value !== "boolean") {
    throw new ProjectLifecycleInputError(`${key} must be a boolean`);
  }

  return value;
}

function optionalBooleanValue(
  input: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const value = input[key];
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "boolean") {
    throw new ProjectLifecycleInputError(`${key} must be a boolean`);
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

  throw new ProjectLifecycleInputError(`${key} must be headless or interactive`);
}

function optionalRepositoryWorkspaceCleanupPolicy(
  input: Record<string, unknown>,
): ProjectImageRepositoryWorkspaceCleanupPolicy | undefined {
  const value = input.repositoryWorkspaceCleanupPolicy;
  if (value === undefined) {
    return undefined;
  }

  if (
    value === "preserve" ||
    value === "archive" ||
    value === "delete-disposable"
  ) {
    return value;
  }

  throw new ProjectLifecycleInputError(
    "repositoryWorkspaceCleanupPolicy must be preserve, archive, or delete-disposable",
  );
}

function optionalNumber(
  input: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = input[key];
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new ProjectLifecycleInputError(`${key} must be an integer`);
  }

  return value;
}

function optionalObject(
  input: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const value = input[key];
  if (value === undefined) {
    return {};
  }

  if (!isObject(value)) {
    throw new ProjectLifecycleInputError(`${key} must be an object`);
  }

  return value;
}

function numberArray(
  value: unknown,
  key: string,
): number[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value) || !value.every(Number.isInteger)) {
    throw new ProjectLifecycleInputError(`${key} must be an array of integers`);
  }

  return value;
}

function stringArray(
  value: unknown,
  key: string,
): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (
    !Array.isArray(value) ||
    !value.every((item) => typeof item === "string" && item.length > 0)
  ) {
    throw new ProjectLifecycleInputError(
      `${key} must be an array of non-empty strings`,
    );
  }

  return value;
}

function optionalEntrySelection(
  input: Record<string, unknown>,
  key: string,
): ImageRescueEntrySelection | undefined {
  const value = input[key];
  if (value === undefined) {
    return undefined;
  }

  if (!isObject(value)) {
    throw new ProjectLifecycleInputError(`${key} must be an object`);
  }

  return {
    indexes: numberArray(value.indexes, `${key}.indexes`),
    entryReferences: stringArray(
      value.entryReferences,
      `${key}.entryReferences`,
    ),
    startIndex: optionalNumber(value, "startIndex"),
    endIndex: optionalNumber(value, "endIndex"),
    latestCount: optionalNumber(value, "latestCount"),
  };
}

function optionalRepositoryActions(
  input: Record<string, unknown>,
  key: string,
): ImageRescueRepositoryAction[] | undefined {
  const value = input[key];
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value)) {
    throw new ProjectLifecycleInputError(`${key} must be an array`);
  }

  return value.map((item, index) => {
    if (!isObject(item)) {
      throw new ProjectLifecycleInputError(`${key}[${index}] must be an object`);
    }

    const toolName = item.toolName;
    if (
      toolName !== undefined &&
      toolName !== "load_repository" &&
      toolName !== "edit_repository"
    ) {
      throw new ProjectLifecycleInputError(
        `${key}[${index}].toolName must be load_repository or edit_repository`,
      );
    }

    return {
      label: optionalString(item, "label"),
      toolName: toolName as ImageRescueRepositoryAction["toolName"],
      arguments: optionalObject(item, "arguments"),
    };
  });
}

function requireRescueOperation(
  input: Record<string, unknown>,
): ImageRescueOperation {
  const value = input.operation;
  if (
    value === "snapshotSource" ||
    value === "plan" ||
    value === "prepareTarget" ||
    value === "applyPlan"
  ) {
    return value;
  }

  throw new ProjectLifecycleInputError(
    "operation must be snapshotSource, plan, prepareTarget, or applyPlan",
  );
}

function objectInput(input: unknown): Record<string, unknown> {
  if (!isObject(input)) {
    return {};
  }

  return input;
}

function result<T>(data: T): ProjectLifecycleToolResult<T> {
  return { ok: true, data };
}

function failure<T = unknown>(error: unknown): ProjectLifecycleToolResult<T> {
  const diagnostics: ProjectLifecycleToolFailureDiagnostics = {
    toolRuntime: plexusRuntimeIdentity(),
    ...(error instanceof ProjectConfigError
      ? {
          projectConfig: {
            issues: error.issues,
          },
        }
      : {}),
    ...(error instanceof ProjectOpenError
      ? {
          projectOpen: {
            statePath: error.result.statePath,
            failures: error.result.failures,
            images: error.result.state.images,
          },
        }
      : {}),
  };

  return {
    ok: false,
    error: error instanceof Error ? error.message : String(error),
    diagnostics,
  };
}

function routeCleanupResource(state: ProjectState): ProjectCleanupResource {
  return {
    kind: "route",
    status: "planned",
    id: state.targetId,
    projectId: state.projectId,
    workspaceId: state.workspaceId,
    targetId: state.targetId,
  };
}

function assertLauncherOk(
  result: LauncherCommandResult | undefined,
  toolName: string,
): void {
  if (result && result.ok === false) {
    throw new Error(`${toolName} returned ok: false`);
  }
}

function cacheEntryStatusFromReadResult(
  readResult: HomeImageCacheManifestReadResult,
): ProjectHomeImageCacheEntryStatus {
  const key = path.basename(path.dirname(readResult.manifestPath));
  if (readResult.status === "ok") {
    return {
      key: readResult.manifest.key,
      status: "ok",
      manifestPath: readResult.manifestPath,
      cacheImageName: readResult.manifest.cacheImageName,
      preparationStatus: readResult.manifest.pharoMcp.preparationStatus,
      supportStatus: readResult.manifest.pharoMcp.support.status,
      createdAt: readResult.manifest.createdAt,
      updatedAt: readResult.manifest.updatedAt,
    };
  }

  return {
    key,
    status: readResult.status,
    manifestPath: readResult.manifestPath,
    ...(readResult.status === "corrupt" ? { error: readResult.error } : {}),
  };
}

function unwrapToolLikeResult(value: unknown): unknown {
  if (isObject(value) && typeof value.ok === "boolean") {
    if (value.ok === false) {
      throw new Error(
        typeof value.error === "string" ? value.error : "Tool call failed",
      );
    }

    return value.data;
  }

  return value;
}

function textContent(value: unknown): string | undefined {
  if (!isObject(value) || !Array.isArray(value.content)) {
    return undefined;
  }

  const item = value.content.find(
    (candidate): candidate is { type: "text"; text: string } =>
      isObject(candidate) &&
      candidate.type === "text" &&
      typeof candidate.text === "string",
  );
  return item?.text;
}

function decodeMcpToolResult(value: unknown): unknown {
  const text = textContent(value);
  if (text === undefined) {
    return value;
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return value;
  }
}

function lifecycleReferenceFromInput(
  input: ProjectStatusToolInput,
): ProjectLifecycleRouteReference {
  return {
    projectId: input.projectId,
    workspaceId: input.workspaceId,
    targetId: input.targetId,
  };
}

function lifecycleStatusFromRoute(
  route: unknown,
  includeDiagnostics = false,
): ProjectLifecycleStatus {
  if (!isObject(route)) {
    return includeDiagnostics ? { route } : {};
  }

  const statePath =
    typeof route.statePath === "string" ? route.statePath : undefined;
  const state = statePath ? loadProjectState(statePath) : undefined;
  const status: ProjectLifecycleStatus = {
    projectId:
      typeof route.projectId === "string" ? route.projectId : state?.projectId,
    workspaceId:
      typeof route.workspaceId === "string"
        ? route.workspaceId
        : state?.workspaceId,
    targetId:
      typeof route.targetId === "string" ? route.targetId : state?.targetId,
  };

  if (!includeDiagnostics) {
    return status;
  }

  return {
    ...status,
    projectRoot:
      typeof route.projectRoot === "string" ? route.projectRoot : undefined,
    statePath,
    state,
    ...(state?.gateway ? { gateway: state.gateway } : {}),
    route,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function mergePortClaimChecks(
  options: ProjectGatewayRuntimeOptions,
): PortClaimChecks {
  const defaults = defaultImagePortClaimChecks();
  return {
    isProcessAlive: options.checks?.isProcessAlive ?? defaults.isProcessAlive,
    isPortListening: options.checks?.isPortListening ?? defaults.isPortListening,
  };
}

function currentScopeMatchesClaim(
  claim: PortClaimRecord,
  scope: {
    projectId: string;
    workspaceId: string;
    targetId: string;
  },
): boolean {
  return (
    claim.projectId === scope.projectId &&
    claim.workspaceId === scope.workspaceId &&
    claim.targetId === scope.targetId
  );
}

function portClaimDiagnostic(
  claimsRoot: string,
  inspection: Extract<
    PortClaimInspection,
    { status: "claimed" | "stale" | "unreadable" }
  >,
  scope: {
    projectId: string;
    workspaceId: string;
    targetId: string;
  },
): ProjectLifecyclePortClaimDiagnostic {
  if (inspection.status === "unreadable") {
    return {
      claimsRoot,
      port: inspection.port,
      status: "unreadable",
      reason: inspection.reason,
    };
  }

  return {
    claimsRoot,
    port: inspection.port,
    status: inspection.status,
    record: inspection.record,
    ...(inspection.reason ? { reason: inspection.reason } : {}),
    ownedByCurrentScope: currentScopeMatchesClaim(inspection.record, scope),
  };
}

async function inspectClaimRoots(
  claimsRoots: string[],
  checks: PortClaimChecks,
  scope: {
    projectId: string;
    workspaceId: string;
    targetId: string;
  },
  currentScopePorts: Set<number>,
): Promise<ProjectLifecyclePortClaimsDiagnostics> {
  const active: ProjectLifecyclePortClaimDiagnostic[] = [];
  const stale: ProjectLifecyclePortClaimDiagnostic[] = [];
  const conflicts: ProjectLifecyclePortClaimDiagnostic[] = [];
  const otherScopes: ProjectLifecyclePortClaimDiagnostic[] = [];

  for (const claimsRoot of claimsRoots) {
    const claims = await listPortClaims({ claimsRoot });
    for (const claim of claims) {
      const inspection = await inspectPortClaim({
        claimsRoot,
        port: claim.assignedPort,
        checks,
      });
      if (inspection.status === "available") {
        continue;
      }

      const diagnostic = portClaimDiagnostic(claimsRoot, inspection, scope);
      if (!diagnostic.ownedByCurrentScope) {
        if (currentScopePorts.has(diagnostic.port)) {
          if (diagnostic.status === "stale") {
            stale.push(diagnostic);
          } else {
            conflicts.push(diagnostic);
          }
        } else {
          otherScopes.push(diagnostic);
        }
        continue;
      }

      if (diagnostic.status === "stale") {
        stale.push(diagnostic);
        continue;
      }

      active.push(diagnostic);
    }
  }

  return {
    roots: claimsRoots,
    active,
    stale,
    conflicts,
    otherScopes,
  };
}

function configuredClaimRoots(
  projectRoot: string,
  config: ProjectConfig,
  state: ProjectState | undefined,
): string[] {
  return [
    imagePortClaimsRootForConfig(projectRoot, config),
    state?.gateway?.claim?.claimsRoot,
  ].filter((value, index, values): value is string =>
    typeof value === "string" && values.indexOf(value) === index,
  );
}

function projectDiagnostics(
  config: ProjectConfig,
  state: ProjectState | undefined,
): ProjectLifecycleProjectDiagnostics {
  return {
    declaredImageCount: config.images.length,
    activeImageCount: config.images.filter((image) => image.active).length,
    runtimeImageCount: state?.images.length ?? 0,
  };
}

function remoteTopologyDiagnostics(
  config: ProjectConfig,
  runtime: ProjectRuntimePolicy,
): ProjectLifecycleRemoteTopologyDiagnostics {
  const remoteNodes = runtime.remoteNodes ?? [];
  return {
    nodeId: runtime.nodeId ?? projectConfigId(config),
    policy: "flat-tree",
    status: remoteNodes.length === 0 ? "local-only" : "flat",
    remoteNodeIds: remoteNodes.map((remoteNode) => remoteNode.id),
    remoteNodes: remoteNodes.map((remoteNode) => ({
      id: remoteNode.id,
      ...(remoteNode.parentNodeId
        ? { parentNodeId: remoteNode.parentNodeId }
        : {}),
      mappedWorkspaceIds:
        remoteNode.workspaces?.map((workspace) => workspace.workspaceId) ?? [],
    })),
  };
}

function imagePortPolicyDiagnostics(
  runtime: ProjectRuntimePolicy,
  stateRoot: string,
  effectiveClaimsRoot: string | undefined,
): ProjectLifecycleImagePortPolicyDiagnostics {
  const coordination = runtime.imagePorts.coordination;
  return {
    allocation: runtime.imagePorts.allocation,
    range: runtime.imagePorts.range,
    coordinationMode: coordination.mode,
    ...(coordination.root ? { configuredRoot: coordination.root } : {}),
    ...(effectiveClaimsRoot ? { effectiveClaimsRoot } : {}),
    projectStateRoot: stateRoot,
    basis: effectiveClaimsRoot ? "host-local-claims" : "project-state",
  };
}

function imagePortCoordinationDiagnostics(
  projectRoot: string,
  stateRoot: string,
  config: ProjectConfig,
): ProjectLifecycleImagePortCoordinationDiagnostics {
  const coordination = resolveProjectRuntimePolicy(config).imagePorts.coordination;
  if (coordination.mode === "host-local") {
    const claimsRoot = imagePortClaimsRootForConfig(projectRoot, config);
    return {
      mode: "host-local",
      basis: "host-local-claims",
      message:
        "Image MCP ports are coordinated by host-local port claims across PLexus projects on this host.",
      ...(claimsRoot ? { claimsRoot } : {}),
    };
  }

  return {
    mode: "project-state",
    basis: "project-state-scanning",
    stateRoot,
    message:
      "Image MCP ports are coordinated by scanning PLexus project state; this only protects workspaces sharing this state root.",
  };
}

function agentAccessDiagnostics(
  gateway: ProjectGatewayState,
  reconciliation?: ProjectLifecycleGatewayReconciliation,
): ProjectLifecycleAgentAccessDiagnostics {
  if (reconciliation?.status === "dead") {
    return {
      expectedSurface: "pharo_gateway",
      gatewayRouted: false,
      portsHiddenFromAgents: true,
      reason:
        "The scoped pharo_gateway is expected, but the recorded project-local gateway is dead. Reopen the project instead of using direct image ports.",
    };
  }

  return {
    expectedSurface: "pharo_gateway",
    gatewayRouted: Boolean(gateway.endpoint),
    portsHiddenFromAgents: true,
    reason:
      "Normal agent Pharo MCP calls should use pharo_gateway imageId routing; image MCP ports are diagnostics only.",
  };
}

function repositoryWorkspaceCleanupDiagnostic(
  workspace: ProjectImageRepositoryWorkspaceState,
  inspection:
    | ReturnType<typeof inspectProjectImageRepositoryWorkspace>
    | undefined,
): ProjectLifecycleRepositoryWorkspaceDiagnostic["cleanup"] {
  const lastDecision = workspace.cleanupState;
  if (!inspection) {
    return {
      defaultPolicy: "preserve",
      destructivePolicyRequired: true,
      reviewRequired: false,
      recommendedAction: "materialize",
      message:
        "Repository workspace is planned; destructive cleanup is unavailable until it is materialized.",
      ...(lastDecision ? { lastDecision } : {}),
    };
  }

  if (!inspection.exists) {
    return {
      defaultPolicy: "preserve",
      destructivePolicyRequired: true,
      reviewRequired: true,
      recommendedAction: "materialize",
      message: "Repository workspace path is missing.",
      ...(lastDecision ? { lastDecision } : {}),
    };
  }

  if (!inspection.isGitRepository) {
    return {
      defaultPolicy: "preserve",
      destructivePolicyRequired: true,
      reviewRequired: true,
      recommendedAction: "repair",
      message: "Repository workspace path exists but is not a Git repository.",
      ...(lastDecision ? { lastDecision } : {}),
    };
  }

  if (inspection.dirtyState === "dirty") {
    return {
      defaultPolicy: "preserve",
      destructivePolicyRequired: true,
      reviewRequired: true,
      recommendedAction: "review",
      message:
        "Repository workspace has uncommitted changes; preserve, archive, or hand off before deletion.",
      ...(lastDecision ? { lastDecision } : {}),
    };
  }

  return {
    defaultPolicy: "preserve",
    destructivePolicyRequired: true,
    reviewRequired: false,
    recommendedAction: "none",
    message:
      "Repository workspace is clean; destructive cleanup still requires an explicit policy.",
    ...(lastDecision ? { lastDecision } : {}),
  };
}

function liveRepositoryWorkspaceState(
  workspace: ProjectImageRepositoryWorkspaceState,
  inspection:
    | ReturnType<typeof inspectProjectImageRepositoryWorkspace>
    | undefined,
): ProjectImageRepositoryWorkspaceState {
  if (!inspection) {
    return workspace;
  }

  return {
    ...workspace,
    path: inspection.path,
    dirtyState: inspection.dirtyState,
    diagnostics: [...workspace.diagnostics, ...inspection.diagnostics],
    ...(inspection.branch ? { branch: inspection.branch } : {}),
    ...(inspection.currentCommit
      ? { currentCommit: inspection.currentCommit }
      : {}),
  };
}

function repositoryWorkspaceDiagnostics(
  projectRoot: string,
  config: ProjectConfig,
  state: ProjectState | undefined,
  scope: {
    projectId: string;
    workspaceId: string;
    targetId: string;
  },
): ProjectLifecycleRepositoryWorkspaceDiagnostic[] {
  return config.images
    .flatMap((imageConfig) => {
      const imageState = state?.images.find((image) => image.id === imageConfig.id);
      const context = {
        projectId: scope.projectId,
        projectName: config.name,
        workspaceId: scope.workspaceId,
        targetId: scope.targetId,
        imageId: imageConfig.id,
      };
      const workspaces = imageState
        ? projectImageRepositoryWorkspaces(imageState)
        : projectImageRepositoryWorkspaceStates(imageConfig, context);

      return workspaces.map((workspace) => {
        const inspection = imageState
          ? inspectProjectImageRepositoryWorkspace({
              projectRoot,
              imageState,
              workspace,
            })
          : undefined;
        const liveWorkspace = liveRepositoryWorkspaceState(workspace, inspection);

        return {
          imageId: imageConfig.id,
          imageName:
            imageState?.imageName ??
            renderProjectImageName(imageConfig.imageName, context),
          status: imageState?.status ?? "declared",
          workspace: liveWorkspace,
          cleanup: repositoryWorkspaceCleanupDiagnostic(liveWorkspace, inspection),
        };
      });
    })
    .filter(
      (
        item,
      ): item is ProjectLifecycleRepositoryWorkspaceDiagnostic =>
        item !== undefined,
    );
}

function dependencyRepositoryDetachDiagnostics(
  state: ProjectState | undefined,
): ProjectLifecycleDependencyRepositoryDetachDiagnostic[] {
  return (state?.images ?? [])
    .filter(
      (
        image,
      ): image is ProjectImageState & {
        dependencyRepositoryDetach: NonNullable<
          ProjectImageState["dependencyRepositoryDetach"]
        >;
      } => image.dependencyRepositoryDetach !== undefined,
    )
    .map((image) => ({
      imageId: image.id,
      imageName: image.imageName,
      status: image.status,
      detach: image.dependencyRepositoryDetach,
    }));
}

function imageRecoveryDiagnostics(input: {
  projectRoot: string;
  stateRoot: string;
  workspaceId: string;
  state: ProjectState | undefined;
}): ProjectLifecycleImageRecoveryDiagnostic[] {
  return (input.state?.images ?? [])
    .filter((image): image is ProjectImageState & { status: "failed" } =>
      image.status === "failed",
    )
    .map((image) => {
      const actionBase = {
        projectPath: input.projectRoot,
        stateRoot: input.stateRoot,
        workspaceId: input.workspaceId,
        sourceImageId: image.id,
      };

      return {
        imageId: image.id,
        imageName: image.imageName,
        status: image.status,
        message: `Image ${image.id} is failed; use scoped rescue before raw cleanup.`,
        paths: {
          ...(image.imagePath ? { imagePath: image.imagePath } : {}),
          ...(image.imageDirectoryPath
            ? { imageDirectoryPath: image.imageDirectoryPath }
            : {}),
          ...(image.changesPath ? { changesPath: image.changesPath } : {}),
          ...(image.localDirectoryPath
            ? { localDirectoryPath: image.localDirectoryPath }
            : {}),
          ...(image.ombuDirectoryPath
            ? { ombuDirectoryPath: image.ombuDirectoryPath }
            : {}),
        },
        actions: [
          {
            operation: "plan",
            toolName: "plexus_rescue_image",
            arguments: {
              ...actionBase,
              operation: "plan",
            },
          },
          {
            operation: "prepareTarget",
            toolName: "plexus_rescue_image",
            arguments: {
              ...actionBase,
              operation: "prepareTarget",
            },
          },
        ],
      };
    });
}

function imageMcpPorts(
  state: ProjectState | undefined,
): ProjectLifecycleDiagnostics["imageMcpPorts"] {
  return (state?.images ?? []).map((image) => ({
    imageId: image.id,
    imageName: image.imageName,
    ...(image.displayMode ? { displayMode: image.displayMode } : {}),
    ...(image.assignedPort !== undefined ? { port: image.assignedPort } : {}),
    ...(image.mcpEndpoint !== undefined ? { mcpEndpoint: image.mcpEndpoint } : {}),
    routingMode:
      image.mcpEndpoint !== undefined
        ? "endpoint"
        : image.assignedPort !== undefined
          ? "fixed-port"
          : "none",
    status: image.status,
    ...(image.pid !== undefined ? { pid: image.pid } : {}),
  }));
}

function registeredRouteStatePath(route: unknown): string | undefined {
  return isObject(route) && typeof route.statePath === "string"
    ? route.statePath
    : undefined;
}

function sameResolvedPath(left: string | undefined, right: string | undefined): boolean {
  return (
    left !== undefined &&
    right !== undefined &&
    path.resolve(left) === path.resolve(right)
  );
}

function routeTableDiagnostics(
  targetId: string | undefined,
  route: unknown,
  routeError: unknown,
  expectedStatePath?: string,
  gatewayReconciliation?: ProjectLifecycleGatewayReconciliation,
): ProjectLifecycleRouteTableDiagnostics {
  if (!targetId) {
    return {
      status: "not-configured",
      routableImages: [],
    };
  }

  if (gatewayReconciliation?.status === "dead") {
    return {
      targetId,
      status: "gateway-dead",
      routableImages: [],
      error: gatewayReconciliation.reason,
    };
  }

  if (routeError) {
    const message = errorMessage(routeError);
    return {
      targetId,
      status: message.includes("No route is registered")
        ? "missing"
        : "unavailable",
      routableImages: [],
      error: message,
    };
  }

  if (!isObject(route)) {
    return {
      targetId,
      status: "not-configured",
      routableImages: [],
    };
  }

  const images = Array.isArray(route.images) ? route.images : [];
  const statePath = registeredRouteStatePath(route);
  const statePathMismatch =
    statePath !== undefined &&
    expectedStatePath !== undefined &&
    !sameResolvedPath(statePath, expectedStatePath);
  const routableImages: ProjectLifecycleRouteTableDiagnostics["routableImages"] = images
    .filter(isObject)
    .map((image) => {
      const mcpEndpoint = isProjectImageMcpEndpoint(image.mcpEndpoint)
        ? image.mcpEndpoint
        : undefined;
      const routingMode: "endpoint" | "fixed-port" | "none" = mcpEndpoint
        ? "endpoint"
        : typeof image.port === "number"
          ? "fixed-port"
          : "none";

      return {
        imageId: typeof image.id === "string" ? image.id : "",
        ...(typeof image.port === "number" ? { port: image.port } : {}),
        ...(mcpEndpoint ? { mcpEndpoint } : {}),
        routingMode,
        ...(typeof image.status === "string" ? { status: image.status } : {}),
        ...(statePathMismatch
          ? {
              routable: {
                ok: false,
                code: "image_unavailable",
                message:
                  "Registered gateway route uses a different PLexus runtime state path",
              },
            }
          : "routable" in image
            ? { routable: image.routable }
            : {}),
      };
    });

  return {
    targetId,
    status: statePathMismatch ? "unavailable" : "registered",
    ...(statePath ? { statePath } : {}),
    ...(statePathMismatch && expectedStatePath ? { expectedStatePath } : {}),
    ...(statePathMismatch
      ? {
          error:
            `Registered gateway route state path ${statePath} does not match ` +
            `selected lifecycle state path ${expectedStatePath}`,
        }
      : {}),
    routableImages,
  };
}

interface ProjectLifecycleGatewayReconciliation {
  status: "dead";
  reason: string;
  staleGateway: ProjectGatewayState;
  releasedClaim: boolean;
}

function gatewayRepairAffordance(input: {
  projectRoot: string;
  stateRoot: string;
  workspaceId: string;
  targetId: string;
}): ProjectLifecycleGatewayRepairAffordance {
  return {
    allowed: true,
    toolName: "plexus_project_open",
    arguments: {
      projectPath: input.projectRoot,
      stateRoot: input.stateRoot,
      workspaceId: input.workspaceId,
      targetId: input.targetId,
    },
    reason: "Reopen the scoped project to start a fresh project-local gateway and re-register routes.",
  };
}

function gatewayWithoutRuntimeIdentity(
  gateway: ProjectGatewayState,
): ProjectGatewayState {
  if (gateway.mode !== "project-local" || !gateway.managedByProject) {
    return gateway;
  }

  const result: ProjectGatewayState = { ...gateway };
  delete result.endpoint;
  delete result.controlEndpoint;
  delete result.pid;
  delete result.claim;
  return result;
}

function gatewayDiagnostic(
  gateway: ProjectGatewayState,
  reconciliation: ProjectLifecycleGatewayReconciliation | undefined,
  repair: ProjectLifecycleGatewayRepairAffordance,
): ProjectLifecycleGatewayDiagnostics {
  if (reconciliation) {
    const stale = reconciliation.staleGateway;
    return {
      mode: stale.mode,
      status: "dead",
      health: "degraded",
      reason: reconciliation.reason,
      host: stale.host,
      portRange: stale.portRange,
      managedByProject: stale.managedByProject,
      stale: {
        ...(stale.endpoint ? { endpoint: stale.endpoint } : {}),
        ...(stale.controlEndpoint ? { controlEndpoint: stale.controlEndpoint } : {}),
        ...(stale.port !== undefined ? { port: stale.port } : {}),
        ...(stale.pid !== undefined ? { pid: stale.pid } : {}),
        ...(stale.claim ? { claim: stale.claim } : {}),
      },
      repair,
    };
  }

  const status: ProjectLifecycleGatewayDiagnostics["status"] =
    gateway.mode === "shared"
      ? "shared"
      : gateway.endpoint && gateway.controlEndpoint
        ? "running"
        : "not-started";
  return {
    mode: gateway.mode,
    status,
    health: status === "not-started" ? "unknown" : "operational",
    reason:
      status === "not-started"
        ? "No project-local gateway endpoint is recorded for this scope yet."
        : "Gateway state is available for this scope.",
    endpoint: gateway.endpoint,
    controlEndpoint: gateway.controlEndpoint,
    host: gateway.host,
    port: gateway.port,
    portRange: gateway.portRange,
    managedByProject: gateway.managedByProject,
    pid: gateway.pid,
    ...(status === "not-started" ? { repair } : {}),
  };
}

function expectedPortClaims(
  portClaims: ProjectLifecyclePortClaimsDiagnostics,
): Set<number> {
  return new Set(portClaims.active.map((claim) => claim.port));
}

function currentScopeClaimPorts(
  config: ProjectConfig,
  state: ProjectState | undefined,
  gateway: ProjectGatewayState,
): Set<number> {
  const ports = new Set<number>();
  if (gateway.port !== undefined) {
    ports.add(gateway.port);
  }
  if (gateway.claim?.assignedPort !== undefined) {
    ports.add(gateway.claim.assignedPort);
  }

  for (const image of state?.images ?? []) {
    if (image.assignedPort !== undefined) {
      ports.add(image.assignedPort);
    }
  }

  for (const image of config.images) {
    if (image.mcp.port !== undefined) {
      ports.add(image.mcp.port);
    }
  }

  return ports;
}

async function conflictingListenerDiagnostics(
  state: ProjectState | undefined,
  gateway: ProjectGatewayState,
  portClaims: ProjectLifecyclePortClaimsDiagnostics,
  checks: PortClaimChecks,
): Promise<ProjectLifecyclePortListenerDiagnostic[]> {
  const ownedClaimPorts = expectedPortClaims(portClaims);
  const diagnostics: ProjectLifecyclePortListenerDiagnostic[] = [];

  for (const image of state?.images ?? []) {
    if (image.assignedPort === undefined) {
      continue;
    }

    const listening = Boolean(await checks.isPortListening?.(image.assignedPort));
    if (
      listening &&
      image.status !== "running" &&
      !ownedClaimPorts.has(image.assignedPort)
    ) {
      diagnostics.push({
        port: image.assignedPort,
        purpose: "image-mcp",
        imageId: image.id,
        expectedOwner: `image ${image.id}`,
        message:
          `Image MCP port ${image.assignedPort} has a listener but the ` +
          `project image ${image.id} is ${image.status} and has no active owned claim.`,
      });
    }
  }

  if (gateway.port !== undefined) {
    const listening = Boolean(await checks.isPortListening?.(gateway.port));
    if (
      listening &&
      gateway.managedByProject &&
      !ownedClaimPorts.has(gateway.port)
    ) {
      diagnostics.push({
        port: gateway.port,
        purpose: "gateway",
        expectedOwner: "project-local gateway",
        message:
          `Gateway port ${gateway.port} has a listener but no active owned claim.`,
      });
    }
  }

  return diagnostics;
}

async function reconcileDeadProjectGatewayState(input: {
  state: ProjectState | undefined;
  statePath: string;
  gateway: ProjectGatewayState;
  checks: PortClaimChecks;
  now: () => Date;
}): Promise<ProjectLifecycleGatewayReconciliation | undefined> {
  const stateGateway = input.state?.gateway;
  const gateway = stateGateway ?? input.gateway;
  if (
    !input.state ||
    !gateway ||
    gateway.mode !== "project-local" ||
    !gateway.managedByProject
  ) {
    return undefined;
  }

  const runtimeStateNeedsGateway =
    input.state.runtimeStatus === "running" ||
    runtimeStatusForImages(input.state.images) === "running" ||
    stateHasRunningRoutableImage(input.state);
  if (!stateGateway && !runtimeStateNeedsGateway) {
    return undefined;
  }

  const port = gateway.port ?? gateway.claim?.assignedPort;
  const portListening =
    port === undefined ? false : Boolean(await input.checks.isPortListening?.(port));
  let claimInspection: PortClaimInspection | undefined;
  if (gateway.claim) {
    claimInspection = await inspectPortClaim({
      claimsRoot: gateway.claim.claimsRoot,
      port: gateway.claim.assignedPort,
      checks: input.checks,
    });
  }

  const claimShowsDeadProcess =
    claimInspection?.status === "stale" &&
    claimInspection.reason === "process-dead";
  const claimMissingOrStale =
    claimInspection?.status === "available" ||
    claimInspection?.status === "stale";
  const gatewayIsDead =
    !portListening &&
    (claimShowsDeadProcess ||
      (gateway.pid === undefined && port !== undefined) ||
      claimMissingOrStale);

  if (!gatewayIsDead) {
    return undefined;
  }

  let releasedClaim = false;
  if (stateGateway?.claim) {
    const release = await releasePortClaim({
      claimsRoot: stateGateway.claim.claimsRoot,
      claim: {
        claimId: stateGateway.claim.claimId,
        assignedPort: stateGateway.claim.assignedPort,
      },
    });
    releasedClaim = release.released;
  }

  if (stateGateway) {
    delete input.state.gateway;
    input.state.updatedAt = input.now().toISOString();
    saveProjectState(input.statePath, input.state);
  }

  return {
    status: "dead",
    reason:
      "Recorded project-local gateway state is dead: the owned gateway port is not listening and its managed claim is stale or missing.",
    staleGateway: gateway,
    releasedClaim,
  };
}

function runtimeDiagnostics(
  state: ProjectState | undefined,
  gateway: ProjectGatewayState,
  portClaims: ProjectLifecyclePortClaimsDiagnostics,
  conflictingListeners: ProjectLifecyclePortListenerDiagnostic[],
  routeTable: ProjectLifecycleRouteTableDiagnostics,
  gatewayReconciliation: ProjectLifecycleGatewayReconciliation | undefined,
): ProjectLifecycleDiagnostics["runtime"] {
  if (!state) {
    return {
      status: "not-opened",
      health: "unknown",
      reason: "No project runtime state exists for this workspace yet.",
    };
  }

  if (gatewayReconciliation?.status === "dead") {
    return {
      status: "degraded",
      health: "degraded",
      reason:
        "Runtime state exists, but the recorded project-local gateway is dead. Reopen the project to repair gateway routing.",
    };
  }

  if (
    portClaims.stale.length > 0 ||
    portClaims.conflicts.length > 0 ||
    conflictingListeners.length > 0 ||
    routeTable.status === "missing" ||
    routeTable.status === "unavailable" ||
    routeTable.status === "gateway-dead" ||
    !gateway.endpoint ||
    !gateway.controlEndpoint
  ) {
    return {
      status: "degraded",
      health: "degraded",
      reason:
        "Runtime state exists, but diagnostics found stale claims, conflicts, route-table gaps, or incomplete gateway endpoints.",
    };
  }

  if (state.images.length === 0 && runtimeStatusForImages(state.images) === "idle") {
    return {
      status: "idle",
      health: "operational",
      reason:
        "Runtime scope, gateway endpoints, and route table are valid; no images are declared for this project.",
    };
  }

  return {
    status: "operational",
    health: "operational",
    reason: "Runtime scope has valid gateway and route diagnostics.",
  };
}

export class HttpGatewayRouteRegistry implements ProjectLifecycleRouteRegistry {
  private readonly url: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;

  constructor(options: HttpGatewayRouteRegistryOptions = {}) {
    const host = options.host ?? "127.0.0.1";
    const port = options.port ?? 7331;
    const mcpPath = options.path ?? defaultGatewayRouteControlMcpPath;
    this.url = options.url ?? `http://${host}:${port}${mcpPath}`;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.fetchFn = options.fetch ?? fetch;
  }

  registerProjectRoute(
    input: ProjectLifecycleRouteRegistration,
  ): Promise<unknown> {
    return this.callTool("plexus_gateway_register_target", input);
  }

  unregisterProjectRoute(input: ProjectLifecycleRouteReference): Promise<unknown> {
    return this.callTool("plexus_gateway_unregister_target", input);
  }

  getRouteStatus(
    input: ProjectLifecycleRouteReference & { refreshHealth?: boolean },
  ): Promise<unknown> {
    return this.callTool("plexus_gateway_status", input);
  }

  private async callTool(
    name: string,
    argumentsValue: unknown,
  ): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchFn(this.url, {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: `plexus-core-${Date.now()}`,
          method: "tools/call",
          params: {
            name,
            arguments: argumentsValue,
          },
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`Gateway MCP request failed with HTTP ${response.status}`);
      }

      const payload = (await response.json()) as unknown;
      if (!isObject(payload)) {
        throw new Error("Gateway MCP response was not a JSON object");
      }
      if ("error" in payload) {
        throw new Error(JSON.stringify(payload.error));
      }

      return unwrapToolLikeResult(
        decodeMcpToolResult((payload as { result?: unknown }).result),
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}

export class HttpProjectLifecycleClient implements ProjectLifecycleRemoteClient {
  private readonly url: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;

  constructor(options: HttpProjectLifecycleClientOptions) {
    this.url = options.url;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.fetchFn = options.fetch ?? fetch;
  }

  async callTool<T = unknown>(
    name: string,
    argumentsValue: Record<string, unknown>,
  ): Promise<ProjectLifecycleToolResult<T>> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchFn(this.url, {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: `plexus-project-${Date.now()}`,
          method: "tools/call",
          params: {
            name,
            arguments: argumentsValue,
          },
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(
          `Remote project MCP request failed with HTTP ${response.status}`,
        );
      }

      const payload = (await response.json()) as unknown;
      if (!isObject(payload)) {
        throw new Error("Remote project MCP response was not a JSON object");
      }
      if ("error" in payload) {
        throw new Error(JSON.stringify(payload.error));
      }

      const decoded = decodeMcpToolResult(
        (payload as { result?: unknown }).result,
      );
      if (isObject(decoded) && typeof decoded.ok === "boolean") {
        return decoded as unknown as ProjectLifecycleToolResult<T>;
      }

      return {
        ok: true,
        data: decoded as T,
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}

function gatewayHasExplicitPharoTools(
  gateway: ProjectLifecycleOptions["gateway"],
): boolean {
  if (gateway?.pharoTools !== undefined) {
    return true;
  }

  const value = gateway?.env?.PLEXUS_PHARO_TOOLS_JSON;
  if (value === undefined || value.trim().length === 0) {
    return false;
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) && parsed.length > 0;
  } catch {
    return true;
  }
}

function imageMcpEndpointForToolDiscovery(
  image: ProjectImageState,
): ProjectImageMcpEndpoint | undefined {
  if (image.status !== "running") {
    return undefined;
  }

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

function stateHasRunningRoutableImage(state: ProjectState): boolean {
  return state.images.some(
    (image) =>
      image.status === "running" &&
      (image.mcpEndpoint !== undefined || image.assignedPort !== undefined),
  );
}

function hostForUrl(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function imageMcpEndpointUrl(endpoint: ProjectImageMcpEndpoint): string {
  return `http://${hostForUrl(endpoint.host)}:${endpoint.port}${endpoint.path}`;
}

function remoteGatewayEndpointFromUrl(value: string): ProjectImageMcpEndpoint {
  const url = new URL(value);

  if (url.protocol !== "http:") {
    throw new ProjectLifecycleInputError(
      `Remote gateway MCP URL must use http for PLexus gateway forwarding: ${value}`,
    );
  }

  const port = url.port ? Number(url.port) : 80;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new ProjectLifecycleInputError(
      `Remote gateway MCP URL must include a valid port: ${value}`,
    );
  }

  return {
    transport: "http",
    host: url.hostname,
    port,
    path: url.pathname || "/",
  };
}

function toolFromMcpListItem(value: unknown, index: number): Tool {
  if (!isObject(value) || typeof value.name !== "string") {
    throw new Error(`MCP tools/list returned an invalid tool at index ${index}`);
  }

  if (!isObject(value.inputSchema)) {
    throw new Error(
      `MCP tools/list returned tool ${value.name} without an inputSchema object`,
    );
  }

  return value as Tool;
}

async function fetchPharoMcpTools(options: {
  endpoint: ProjectImageMcpEndpoint;
  fetchFn: typeof fetch;
  timeoutMs: number;
}): Promise<Tool[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs);

  try {
    const response = await options.fetchFn(imageMcpEndpointUrl(options.endpoint), {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: `plexus-tools-list-${Date.now()}`,
        method: "tools/list",
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`MCP tools/list failed with HTTP ${response.status}`);
    }

    const payload = (await response.json()) as unknown;
    if (!isObject(payload)) {
      throw new Error("MCP tools/list response was not a JSON object");
    }

    if ("error" in payload) {
      throw new Error(JSON.stringify(payload.error));
    }

    const result = payload.result;
    if (!isObject(result) || !Array.isArray(result.tools)) {
      throw new Error("MCP tools/list response did not include result.tools");
    }

    return result.tools.map(toolFromMcpListItem);
  } finally {
    clearTimeout(timeout);
  }
}

async function discoverPharoMcpToolsFromRunningImages(options: {
  state: ProjectState;
  fetchFn: typeof fetch;
  timeoutMs?: number;
}): Promise<Tool[] | undefined> {
  const errors: string[] = [];
  let attempted = false;

  for (const image of options.state.images) {
    const endpoint = imageMcpEndpointForToolDiscovery(image);
    if (!endpoint) {
      continue;
    }

    attempted = true;
    try {
      const tools = await fetchPharoMcpTools({
        endpoint,
        fetchFn: options.fetchFn,
        timeoutMs: options.timeoutMs ?? defaultPharoToolsDiscoveryTimeoutMs,
      });
      if (tools.length > 0) {
        return tools;
      }
      errors.push(`${image.id}: MCP tools/list returned no tools`);
    } catch (error) {
      errors.push(
        `${image.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  if (attempted) {
    throw new Error(
      `Unable to discover Pharo MCP tools from running project images: ${errors.join("; ")}`,
    );
  }

  return undefined;
}

function remoteLifecycleMappingForInput(
  config: ProjectConfig,
  projectRoot: string,
  input: { workspaceId?: string; targetId?: string },
): ProjectRemoteLifecycleMapping | undefined {
  const runtime = resolveProjectRuntimePolicy(config);
  const remoteNodes = runtime.remoteNodes ?? [];
  if (remoteNodes.length === 0) {
    return undefined;
  }

  const workspaceId = input.workspaceId
    ? sanitizeRuntimeId(input.workspaceId)
    : defaultWorkspaceId(projectRoot);

  for (const remoteNode of remoteNodes) {
    for (const workspace of remoteNode.workspaces ?? []) {
      const target = input.targetId
        ? workspace.targets?.find(
            (candidate) => candidate.targetId === input.targetId,
          )
        : undefined;

      if (input.targetId && workspace.targets && !target) {
        continue;
      }

      if (workspace.workspaceId === workspaceId || target) {
        return {
          remoteNode,
          workspace,
          ...(target ? { target } : {}),
          workspaceId,
        };
      }
    }
  }

  return undefined;
}

function remoteLifecycleArguments<T extends {
  projectPath: string;
  workspaceId?: string;
  targetId?: string;
}>(
  input: T,
  mapping: ProjectRemoteLifecycleMapping,
): Record<string, unknown> {
  const projectPath = mapping.workspace?.remoteProjectPath ?? input.projectPath;
  const workspaceId =
    mapping.workspace?.remoteWorkspaceId ??
    input.workspaceId ??
    mapping.workspaceId;
  const targetId = mapping.target?.remoteTargetId ?? input.targetId;

  return Object.fromEntries(
    Object.entries({
      ...(input as Record<string, unknown>),
      projectPath,
      stateRoot: undefined,
      workspaceId,
      targetId,
    }).filter(([, value]) => value !== undefined),
  );
}

function hostRemoteRouteContext(input: {
  projectPath: string;
  workspaceId?: string;
  targetId?: string;
  stateRoot?: string;
}, mapping: ProjectRemoteLifecycleMapping): ProjectHostRemoteRouteContext {
  const projectRoot = path.resolve(input.projectPath);
  const config = loadProjectConfig(projectRoot);
  const projectId = projectConfigId(config);
  const workspaceId = mapping.workspaceId;
  const targetId = input.targetId ?? defaultTargetId(projectId, workspaceId);
  const stateRoot =
    projectStateRootForConfig(config, input.stateRoot) ??
    defaultPlexusStateRoot(projectRoot);
  const statePath = projectStatePathForConfig({
    projectRoot,
    config,
    workspaceId,
    stateRoot,
  });

  return {
    projectRoot,
    config,
    stateRoot,
    statePath,
    projectId,
    workspaceId,
    targetId,
  };
}

function hostOpenResultForRemoteOpen(
  input: ProjectOpenToolInput,
  mapping: ProjectRemoteLifecycleMapping,
  openResult: ProjectOpenResult,
  context: ProjectHostRemoteRouteContext,
): ProjectOpenResult {
  const {
    gateway: _remoteProjectGateway,
    projectId: _remoteProjectId,
    projectName: _remoteProjectName,
    workspaceId: _remoteWorkspaceId,
    targetId: _remoteTargetId,
    sourcePath: remoteSourcePath,
    ...remoteState
  } = openResult.state;
  const sourcePath = input.sourcePath ?? remoteSourcePath;
  const state: ProjectState = {
    ...remoteState,
    projectId: context.projectId,
    projectName: context.config.name,
    workspaceId: context.workspaceId,
    targetId: context.targetId,
    ...(sourcePath ? { sourcePath } : {}),
    remoteGateway: {
      remoteNodeId: mapping.remoteNode.id,
      endpoint: remoteGatewayEndpointFromUrl(mapping.remoteNode.gatewayMcpUrl),
      projectId: openResult.state.projectId,
      workspaceId: openResult.state.workspaceId,
      targetId: openResult.state.targetId,
    },
  };

  saveProjectState(context.statePath, state);

  return {
    ...openResult,
    projectRoot: context.projectRoot,
    statePath: context.statePath,
    state,
  };
}

export class PlexusProjectLifecycle {
  private readonly routeRegistry?: ProjectLifecycleRouteRegistry;
  private readonly imageToolCaller?: ProjectLifecycleImageToolCaller;
  private readonly homeImageCacheClient?: PharoLauncherMcpToolClient;
  private readonly defaultStateRoot?: string;
  private readonly projectOpen: typeof openProject;
  private readonly projectClose: typeof closeProject;
  private readonly imageRescue: typeof rescueImage;
  private readonly remoteClientFactory?: (
    remoteNode: ProjectRemoteNodeConfig,
  ) => ProjectLifecycleRemoteClient;
  private readonly gateway: NonNullable<ProjectLifecycleOptions["gateway"]>;

  constructor(options: ProjectLifecycleOptions = {}) {
    this.routeRegistry = options.routeRegistry;
    this.imageToolCaller = options.imageToolCaller;
    this.homeImageCacheClient = options.homeImageCacheClient;
    this.defaultStateRoot = options.defaultStateRoot;
    this.projectOpen = options.projectOpen ?? openProject;
    this.projectClose = options.projectClose ?? closeProject;
    this.imageRescue = options.imageRescue ?? rescueImage;
    this.remoteClientFactory = options.remoteClientFactory;
    this.gateway = options.gateway ?? {};
  }

  private effectiveStateRoot(stateRoot?: string): string | undefined {
    return stateRoot ?? this.defaultStateRoot;
  }

  private remoteLifecycleMapping(input: {
    projectPath: string;
    workspaceId?: string;
    targetId?: string;
  }): ProjectRemoteLifecycleMapping | undefined {
    const projectRoot = path.resolve(input.projectPath);
    if (path.basename(projectRoot) === plexusProjectConfigFileName) {
      return undefined;
    }

    let config: ProjectConfig;
    try {
      config = loadProjectConfig(projectRoot);
    } catch (error) {
      if (
        error instanceof Error &&
        (error.message.startsWith("ENOENT:") ||
          error.message.startsWith("ENOTDIR:"))
      ) {
        return undefined;
      }

      throw error;
    }

    return remoteLifecycleMappingForInput(config, projectRoot, input);
  }

  private remoteClientFor(
    remoteNode: ProjectRemoteNodeConfig,
  ): ProjectLifecycleRemoteClient {
    return (
      this.remoteClientFactory?.(remoteNode) ??
      new HttpProjectLifecycleClient({
        url: remoteNode.projectMcpUrl,
        timeoutMs: this.gateway.routeRegistryTimeoutMs,
        fetch: this.gateway.fetch,
      })
    );
  }

  private async registerHostRouteForRemoteOpen(
    input: ProjectOpenToolInput,
    mapping: ProjectRemoteLifecycleMapping,
    openResult: ProjectOpenResult,
  ): Promise<ProjectOpenResult> {
    const context = hostRemoteRouteContext(
      {
        ...input,
        stateRoot: this.effectiveStateRoot(input.stateRoot),
      },
      mapping,
    );
    const hostOpenResult = hostOpenResultForRemoteOpen(
      input,
      mapping,
      openResult,
      context,
    );

    await this.ensureGatewayRouteForOpenResult(hostOpenResult);

    return hostOpenResult;
  }

  private async unregisterHostRouteForRemote(
    input: {
      projectPath: string;
      workspaceId?: string;
      targetId?: string;
      stateRoot?: string;
    },
    mapping: ProjectRemoteLifecycleMapping,
    options: { deleteStateFile?: boolean } = {},
  ): Promise<void> {
    const context = hostRemoteRouteContext(
      {
        ...input,
        stateRoot: this.effectiveStateRoot(input.stateRoot),
      },
      mapping,
    );
    const state = loadProjectState(context.statePath);
    const routeRegistry =
      this.routeRegistry ?? this.routeRegistryForProject(context.config, state);

    await this.unregisterRoute(
      {
        projectId: context.projectId,
        workspaceId: context.workspaceId,
        ...(input.targetId ? { targetId: context.targetId } : {}),
      },
      routeRegistry,
    );

    if (state?.gateway?.managedByProject) {
      await closeProjectGateway({
        ...this.gateway,
        state,
      });
      state.updatedAt = (this.gateway.now ?? (() => new Date()))().toISOString();
      saveProjectState(context.statePath, state);
    }

    if (options.deleteStateFile) {
      fs.rmSync(context.statePath, { force: true });
    }
  }

  async open(
    input: ProjectOpenToolInput,
  ): Promise<ProjectLifecycleToolResult<ProjectOpenResult>> {
    try {
      const remote = this.remoteLifecycleMapping(input);
      if (remote) {
        const remoteResult =
          await this.remoteClientFor(remote.remoteNode).callTool<ProjectOpenResult>(
            "plexus_project_open",
            remoteLifecycleArguments(input, remote),
          );
        if (remoteResult.ok && remoteResult.data) {
          return result(
            await this.registerHostRouteForRemoteOpen(
              input,
              remote,
              remoteResult.data,
            ),
          );
        }

        return remoteResult;
      }

      const openResult = await this.projectOpen({
        projectRoot: input.projectPath,
        sourcePath: input.sourcePath,
        stateRoot: this.effectiveStateRoot(input.stateRoot),
        workspaceId: input.workspaceId,
        targetId: input.targetId,
        displayMode: input.displayMode,
        preparedImageCacheApproval: {
          approved: true,
          runnerId: "plexus-project-open",
        },
        homeImageCacheApproval: {
          approved: true,
          runnerId: "plexus-project-open",
        },
      });
      await this.ensureGatewayRouteForOpenResult(openResult);

      return result(openResult);
    } catch (error) {
      if (
        error instanceof ProjectOpenError &&
        stateHasRunningRoutableImage(error.result.state)
      ) {
        try {
          await this.ensureGatewayRouteForOpenResult(error.result);
        } catch {
          // Preserve the project-open failure; diagnostics already carry the
          // image startup failures that made this repair path partial.
        }
      }
      return failure(error);
    }
  }

  private async ensureGatewayRouteForOpenResult(
    openResult: ProjectOpenResult,
  ): Promise<void> {
    let routeRegistry = this.routeRegistry;
    let startedProjectGateway = false;

    if (!routeRegistry) {
      const config = loadProjectConfig(openResult.projectRoot);
      const discoveredPharoTools =
        await this.discoverGatewayPharoTools(openResult.state);
      const gatewayResult = await ensureProjectGateway({
        ...this.gateway,
        ...(discoveredPharoTools !== undefined
          ? { pharoTools: discoveredPharoTools }
          : {}),
        projectRoot: openResult.projectRoot,
        config,
        state: openResult.state,
      });
      startedProjectGateway = gatewayResult.started;
      saveProjectState(openResult.statePath, openResult.state);
      routeRegistry = this.routeRegistryFromControlUrl(gatewayResult.routeControlUrl);
    }

    try {
      await this.registerRoute(
        {
          projectRoot: openResult.projectRoot,
          statePath: openResult.statePath,
          state: openResult.state,
        },
        routeRegistry,
      );
    } catch (error) {
      if (startedProjectGateway) {
        await closeProjectGateway({
          ...this.gateway,
          state: openResult.state,
        });
        saveProjectState(openResult.statePath, openResult.state);
      }

      throw error;
    }
  }

  private async discoverGatewayPharoTools(
    state: ProjectState,
  ): Promise<Tool[] | undefined> {
    if (state.remoteGateway) {
      return undefined;
    }

    if (gatewayHasExplicitPharoTools(this.gateway)) {
      return undefined;
    }

    return discoverPharoMcpToolsFromRunningImages({
      state,
      fetchFn: this.gateway.fetch ?? fetch,
    });
  }

  async homeImageCacheStatus(
    input: ProjectHomeImageCacheToolInput,
  ): Promise<ProjectLifecycleToolResult<ProjectHomeImageCacheStatus>> {
    try {
      const projectRoot = path.resolve(input.projectPath);
      const config = loadProjectConfig(projectRoot);
      const homePath = resolvePlexusHomePath({ config });
      const cacheRoot = homeImageCacheRootPath(homePath);
      const entries = input.key
        ? [
            cacheEntryStatusFromReadResult(
              readHomeImageCacheManifest(
                homeImageCacheManifestPath(cacheRoot, input.key),
              ),
            ),
          ]
        : listHomeImageCacheManifests(cacheRoot).map(
            cacheEntryStatusFromReadResult,
          );

      return result({
        projectRoot,
        homePath,
        cacheRoot,
        entries,
      });
    } catch (error) {
      return failure(error);
    }
  }

  async flushHomeImageCache(
    input: ProjectHomeImageCacheFlushToolInput,
  ): Promise<ProjectLifecycleToolResult<ProjectHomeImageCacheFlushResult>> {
    try {
      if (input.confirm !== true) {
        throw new ProjectLifecycleInputError("confirm: true is required");
      }

      const projectRoot = path.resolve(input.projectPath);
      const config = loadProjectConfig(projectRoot);
      const plan = planHomeImageCacheFlush({
        config,
        key: input.key,
      });
      const homeProfile = homeImageCacheProfile(plan.homePath);
      const manifests: HomeImageCacheManifest[] = plan.entries
        .map((entry) => readHomeImageCacheManifest(entry.manifestPath))
        .filter(
          (
            readResult,
          ): readResult is Extract<
            HomeImageCacheManifestReadResult,
            { status: "ok" }
          > => readResult.status === "ok",
        )
        .map((readResult) => readResult.manifest);
      let client = this.homeImageCacheClient;
      let ownsClient = false;
      const deletedImages: string[] = [];

      try {
        if (manifests.length > 0 && !client) {
          client = await createStdioPharoLauncherMcpClient(undefined, {
            profileEnvironment: profileEnvironmentFromPaths(homeProfile),
          });
          ownsClient = true;
        }

        for (const manifest of manifests) {
          const deleteResult = await client!.callTool<LauncherCommandResult>(
            "pharo_launcher_image_delete",
            {
              imageName: manifest.cacheImageName,
              force: true,
              confirm: true,
            },
          );
          assertLauncherOk(deleteResult, "pharo_launcher_image_delete");
          deletedImages.push(manifest.cacheImageName);
        }
      } finally {
        if (ownsClient) {
          await client?.close?.();
        }
      }

      flushHomeImageCache(plan);

      return result({
        projectRoot,
        homePath: plan.homePath,
        cacheRoot: plan.cacheRoot,
        entries: listHomeImageCacheManifests(plan.cacheRoot).map(
          cacheEntryStatusFromReadResult,
        ),
        deletedImages,
        flushedEntries: plan.entries,
      });
    } catch (error) {
      return failure(error);
    }
  }

  async close(
    input: ProjectCloseToolInput,
  ): Promise<ProjectLifecycleToolResult<ProjectCloseResult>> {
    try {
      const remote = this.remoteLifecycleMapping(input);
      if (remote) {
        const remoteResult =
          await this.remoteClientFor(remote.remoteNode).callTool<ProjectCloseResult>(
            "plexus_project_close",
            remoteLifecycleArguments(input, remote),
          );
        if (remoteResult.ok) {
          await this.unregisterHostRouteForRemote(input, remote);
        }

        return remoteResult;
      }

      const closeResult = await this.projectClose({
        projectRoot: input.projectPath,
        stateRoot: this.effectiveStateRoot(input.stateRoot),
        workspaceId: input.workspaceId,
        ...(input.repositoryWorkspaceCleanupPolicy
          ? {
              repositoryWorkspaceCleanupPolicy:
                input.repositoryWorkspaceCleanupPolicy,
            }
          : {}),
        ...(input.repositoryWorkspaceArchiveRoot
          ? { repositoryWorkspaceArchiveRoot: input.repositoryWorkspaceArchiveRoot }
          : {}),
      });
      const projectRoot = path.resolve(input.projectPath);
      const config =
        !this.routeRegistry || !closeResult.state
          ? loadProjectConfig(projectRoot)
          : undefined;
      const routeRegistry =
        this.routeRegistry ??
        (config ? this.routeRegistryForProject(config, closeResult.state) : undefined);
      let unregisterError: unknown;

      try {
        if (closeResult.state) {
          await this.unregisterRoute(
            { targetId: closeResult.state.targetId },
            routeRegistry,
          );
        } else {
          const workspaceId = input.workspaceId
            ? sanitizeRuntimeId(input.workspaceId)
            : defaultWorkspaceId(projectRoot);
          await this.unregisterRoute(
            {
              projectId: config ? projectConfigId(config) : undefined,
              workspaceId,
            },
            routeRegistry,
          );
        }
      } catch (error) {
        unregisterError = error;
      } finally {
        if (closeResult.state?.gateway?.managedByProject) {
          await closeProjectGateway({
            ...this.gateway,
            state: closeResult.state,
          });
          closeResult.state.updatedAt = (
            this.gateway.now ?? (() => new Date())
          )().toISOString();
          saveProjectState(closeResult.statePath, closeResult.state);
        }
      }

      if (unregisterError) {
        throw unregisterError;
      }

      return result(closeResult);
    } catch (error) {
      return failure(error);
    }
  }

  async cleanup(
    input: ProjectCleanupToolInput,
  ): Promise<ProjectLifecycleToolResult<ProjectCleanupResult>> {
    try {
      const remote = this.remoteLifecycleMapping(input);
      if (remote) {
        const remoteResult =
          await this.remoteClientFor(remote.remoteNode).callTool<ProjectCleanupResult>(
            "plexus_project_cleanup",
            remoteLifecycleArguments(input, remote),
          );
        if (remoteResult.ok && input.confirm === true) {
          await this.unregisterHostRouteForRemote(input, remote, {
            deleteStateFile: input.deleteStateFile === true,
          });
        }

        return remoteResult;
      }

      const projectRoot = path.resolve(input.projectPath);
      const config = loadProjectConfig(projectRoot);
      const workspaceId = input.workspaceId
        ? sanitizeRuntimeId(input.workspaceId)
        : defaultWorkspaceId(projectRoot);
      const stateRoot =
        projectStateRootForConfig(config, this.effectiveStateRoot(input.stateRoot)) ??
        defaultPlexusStateRoot(projectRoot);
      const statePath = projectStatePathForConfig({
        projectRoot,
        config,
        workspaceId,
        stateRoot,
      });
      const state = loadProjectState(statePath);
      const routeResource = state ? routeCleanupResource(state) : undefined;
      let routeFailure: ProjectCleanupResult["failures"][number] | undefined;

      if (input.confirm === true && routeResource && state) {
        const routeRegistry = this.routeRegistryForProject(config, state);
        if (routeRegistry) {
          try {
            await this.unregisterRoute(
              { targetId: state.targetId },
              routeRegistry,
            );
            routeResource.status = "cleaned";
          } catch (error) {
            routeResource.status = "failed";
            routeResource.reason = errorMessage(error);
            routeFailure = {
              kind: "route",
              id: state.targetId,
              message: errorMessage(error),
            };
          }
        } else {
          routeResource.status = "skipped";
          routeResource.reason =
            "No route registry is configured for this project scope.";
        }
      }

      const cleanupResult = await cleanupProjectOwnedResources({
        projectRoot,
        stateRoot,
        workspaceId,
        confirm: input.confirm,
        deleteStateFile: input.deleteStateFile,
        deleteLauncherImages: input.deleteLauncherImages,
        repositoryWorkspaceCleanupPolicy:
          input.repositoryWorkspaceCleanupPolicy,
        repositoryWorkspaceArchiveRoot: input.repositoryWorkspaceArchiveRoot,
        gateway: this.gateway,
      });

      if (routeResource) {
        cleanupResult.resources.push(routeResource);
      }
      if (routeFailure) {
        cleanupResult.failures.push(routeFailure);
        cleanupResult.ok = false;
      }

      if (!cleanupResult.ok) {
        return {
          ok: false,
          data: cleanupResult,
          error: "One or more PLexus-owned resources failed to clean",
        };
      }

      return result(cleanupResult);
    } catch (error) {
      return failure(error);
    }
  }

  async status(
    input: ProjectStatusToolInput,
  ): Promise<
    ProjectLifecycleToolResult<ProjectLifecycleStatus | ProjectLifecycleStatus[]>
  > {
    try {
      if (input.projectPath) {
        const remote = this.remoteLifecycleMapping({
          ...input,
          projectPath: input.projectPath,
        });
        if (remote) {
          return this.remoteClientFor(
            remote.remoteNode,
          ).callTool<ProjectLifecycleStatus>(
            "plexus_project_status",
            remoteLifecycleArguments(
              {
                ...input,
                projectPath: input.projectPath,
              },
              remote,
            ),
          );
        }

        return result(
          await this.statusFromProjectPath({
            ...input,
            projectPath: input.projectPath,
          }),
        );
      }

      if (!this.routeRegistry?.getRouteStatus) {
        throw new ProjectLifecycleInputError(
          "projectPath is required when no gateway route registry is configured",
        );
      }

      const routeStatus = unwrapToolLikeResult(
        await this.routeRegistry.getRouteStatus({
          ...lifecycleReferenceFromInput(input),
          refreshHealth: input.refreshHealth,
        }),
      );
      const routes = Array.isArray(routeStatus) ? routeStatus : [routeStatus];
      const statuses = routes.map((route) =>
        lifecycleStatusFromRoute(route, input.includeDiagnostics),
      );

      return result(Array.isArray(routeStatus) ? statuses : statuses[0]);
    } catch (error) {
      return failure(error);
    }
  }

  async rescueImage(
    input: RescueImageToolInput,
  ): Promise<ProjectLifecycleToolResult<ImageRescueResult>> {
    try {
      const imageToolCaller = this.imageToolCaller;
      const options: ImageRescueOptions = {
        ...input,
        projectRoot: input.projectPath ?? "",
        stateRoot: this.effectiveStateRoot(input.stateRoot),
        imageMcpClient: imageToolCaller
          ? {
              callTool: async (image, toolName, argumentsValue) =>
                imageToolCaller.callImageTool(
                  lifecycleReferenceFromInput(input),
                  image.id,
                  toolName,
                  argumentsValue,
                ),
            }
          : undefined,
      };
      if (!options.projectRoot) {
        throw new ProjectLifecycleInputError(
          "projectPath is required for image rescue",
        );
      }

      const rescueResult = await this.imageRescue(options);
      if (rescueResult.state) {
        const config = loadProjectConfig(rescueResult.projectRoot);
        await this.registerRoute(
          {
            projectRoot: rescueResult.projectRoot,
            statePath: rescueResult.statePath,
            state: rescueResult.state,
          },
          this.routeRegistryForProject(config, rescueResult.state),
        );
      }

      return result(rescueResult);
    } catch (error) {
      return failure(error);
    }
  }

  async handleTool(
    name: string,
    inputValue: unknown,
  ): Promise<ProjectLifecycleToolResult> {
    try {
      const input = objectInput(inputValue);

      switch (name) {
        case "plexus_project_open":
          return this.open({
            projectPath: requireString(input, "projectPath"),
            sourcePath: optionalString(input, "sourcePath"),
            stateRoot: optionalString(input, "stateRoot"),
            workspaceId: optionalString(input, "workspaceId"),
            targetId: optionalString(input, "targetId"),
            displayMode: optionalDisplayMode(input, "displayMode"),
          });

        case "plexus_project_close":
          return this.close({
            projectPath: requireString(input, "projectPath"),
            stateRoot: optionalString(input, "stateRoot"),
            workspaceId: optionalString(input, "workspaceId"),
            repositoryWorkspaceCleanupPolicy:
              optionalRepositoryWorkspaceCleanupPolicy(input),
            repositoryWorkspaceArchiveRoot: optionalString(
              input,
              "repositoryWorkspaceArchiveRoot",
            ),
          });

        case "plexus_project_cleanup":
          return this.cleanup({
            projectPath: requireString(input, "projectPath"),
            stateRoot: optionalString(input, "stateRoot"),
            workspaceId: optionalString(input, "workspaceId"),
            confirm: optionalBooleanValue(input, "confirm"),
            deleteStateFile: optionalBooleanValue(input, "deleteStateFile"),
            deleteLauncherImages: optionalBooleanValue(
              input,
              "deleteLauncherImages",
            ),
            repositoryWorkspaceCleanupPolicy:
              optionalRepositoryWorkspaceCleanupPolicy(input),
            repositoryWorkspaceArchiveRoot: optionalString(
              input,
              "repositoryWorkspaceArchiveRoot",
            ),
          });

        case "plexus_project_status":
          return this.status({
            projectPath: optionalString(input, "projectPath"),
            sourcePath: optionalString(input, "sourcePath"),
            projectId: optionalString(input, "projectId"),
            workspaceId: optionalString(input, "workspaceId"),
            targetId: optionalString(input, "targetId"),
            stateRoot: optionalString(input, "stateRoot"),
            refreshHealth: optionalBoolean(input, "refreshHealth"),
            includeDiagnostics: optionalBoolean(input, "includeDiagnostics"),
          });

        case "plexus_home_image_cache_status":
          return this.homeImageCacheStatus({
            projectPath: requireString(input, "projectPath"),
            key: optionalString(input, "key"),
          });

        case "plexus_home_image_cache_flush":
          return this.flushHomeImageCache({
            projectPath: requireString(input, "projectPath"),
            key: optionalString(input, "key"),
            confirm: optionalBooleanValue(input, "confirm"),
          });

        case "plexus_rescue_image":
          return this.rescueImage({
            projectPath: requireString(input, "projectPath"),
            projectId: optionalString(input, "projectId"),
            workspaceId: optionalString(input, "workspaceId"),
            targetId: optionalString(input, "targetId"),
            stateRoot: optionalString(input, "stateRoot"),
            operation: requireRescueOperation(input),
            sourceImageId: requireString(input, "sourceImageId"),
            targetImageId: optionalString(input, "targetImageId"),
            targetImageName: optionalString(input, "targetImageName"),
            targetTemplateName: optionalString(input, "targetTemplateName"),
            targetTemplateCategory: optionalString(input, "targetTemplateCategory"),
            targetMcpPort: optionalNumber(input, "targetMcpPort"),
            sourceHistoryDirectoryPath: optionalString(
              input,
              "sourceHistoryDirectoryPath",
            ),
            historyFilePath: optionalString(input, "historyFilePath"),
            selection: optionalEntrySelection(input, "selection"),
            exclude: optionalEntrySelection(input, "exclude"),
            codeChangesOnly: optionalBooleanValue(input, "codeChangesOnly"),
            includeEntryCounts: optionalBooleanValue(
              input,
              "includeEntryCounts",
            ),
            loadRepositories: optionalBooleanValue(input, "loadRepositories"),
            repositoryActions: optionalRepositoryActions(
              input,
              "repositoryActions",
            ),
            confirm: optionalBooleanValue(input, "confirm"),
          });

        default:
          return {
            ok: false,
            error: `Unknown tool: ${name}`,
          };
      }
    } catch (error) {
      return failure(error);
    }
  }

  private async statusFromProjectPath(
    input: ProjectStatusToolInput & { projectPath: string },
  ): Promise<ProjectLifecycleStatus> {
    const projectRoot = path.resolve(input.projectPath);
    if (path.basename(projectRoot) === plexusProjectConfigFileName) {
      throw new ProjectLifecycleInputError(
        `projectPath must point to the PLexus project directory, not ${plexusProjectConfigFileName}: ` +
          `${projectRoot}. Pass ${path.dirname(projectRoot)} instead.`,
      );
    }

    const config = loadProjectConfig(projectRoot);
    const runtime = resolveProjectRuntimePolicy(config);
    const workspaceId = input.workspaceId
      ? sanitizeRuntimeId(input.workspaceId)
      : defaultWorkspaceId(projectRoot);
    const requestedStateRoot = this.effectiveStateRoot(input.stateRoot);
    const stateRoot =
      projectStateRootForConfig(config, requestedStateRoot) ??
      defaultPlexusStateRoot(projectRoot);
    const statePath = projectStatePathForConfig({
      projectRoot,
      config,
      workspaceId,
      stateRoot,
    });
    let state = loadProjectState(statePath);
    const checks = mergePortClaimChecks(this.gateway);
    const observedGateway = projectGatewayStatus(config, state);
    const gatewayReconciliation = input.refreshHealth
      ? await reconcileDeadProjectGatewayState({
          state,
          statePath,
          gateway: observedGateway,
          checks,
          now: this.gateway.now ?? (() => new Date()),
        })
      : undefined;
    if (gatewayReconciliation) {
      state = loadProjectState(statePath);
    }
    const requestedSourcePath = input.sourcePath ?? state?.sourcePath;
    const sourcePath = requestedSourcePath
      ? path.resolve(requestedSourcePath)
      : projectRoot;
    const gateway = gatewayReconciliation
      ? gatewayWithoutRuntimeIdentity(projectGatewayStatus(config, state))
      : projectGatewayStatus(config, state);
    const routeRegistry = gatewayReconciliation
      ? undefined
      : this.routeRegistryForProject(config, state);
    let route: unknown;
    let routeError: unknown;
    if (state) {
      try {
        route = await this.getRouteStatus(
          {
            targetId: state.targetId,
            refreshHealth: input.refreshHealth,
          },
          routeRegistry,
        );
        if (
          routeRegistry &&
          registeredRouteStatePath(route) &&
          !sameResolvedPath(registeredRouteStatePath(route), statePath)
        ) {
          await this.registerRoute(
            {
              projectRoot,
              statePath,
              state,
            },
            routeRegistry,
          );
          route = await this.getRouteStatus(
            {
              targetId: state.targetId,
              refreshHealth: input.refreshHealth,
            },
            routeRegistry,
          );
        }
      } catch (error) {
        routeError = error;
      }
    }
    const targetId =
      state?.targetId ??
      input.targetId ??
      defaultTargetId(projectConfigId(config), workspaceId);
    const scope = {
      projectId: state?.projectId ?? projectConfigId(config),
      workspaceId: state?.workspaceId ?? workspaceId,
      targetId,
    };
    const gatewayRepair = gatewayRepairAffordance({
      projectRoot,
      stateRoot,
      workspaceId: scope.workspaceId,
      targetId: scope.targetId,
    });
    const context = buildScopedProjectContext({
      projectRoot,
      sourcePath,
      projectConfig: config,
      workspaceId: scope.workspaceId,
      targetId: scope.targetId,
      stateRoot,
      projectState: state,
    });
    const imageClaimsRoot = imagePortClaimsRootForConfig(projectRoot, config);
    const portClaims = await inspectClaimRoots(
      configuredClaimRoots(projectRoot, config, state),
      checks,
      scope,
      currentScopeClaimPorts(config, state, gateway),
    );
    const routeTable = routeTableDiagnostics(
      targetId,
      route,
      routeError,
      statePath,
      gatewayReconciliation,
    );
    const conflictingListeners = await conflictingListenerDiagnostics(
      state,
      gateway,
      portClaims,
      checks,
    );
    const diagnostics: ProjectLifecycleDiagnostics = {
      toolRuntime: plexusRuntimeIdentity(),
      runtime: runtimeDiagnostics(
        state,
        gateway,
        portClaims,
        conflictingListeners,
        routeTable,
        gatewayReconciliation,
      ),
      project: projectDiagnostics(config, state),
      scope: {
        projectRoot,
        sourcePath,
        stateRoot,
        statePath,
        projectId: scope.projectId,
        workspaceId: scope.workspaceId,
        targetId: scope.targetId,
      },
      gateway: gatewayDiagnostic(gateway, gatewayReconciliation, gatewayRepair),
      runtimePolicy: runtime,
      remoteTopology: remoteTopologyDiagnostics(config, runtime),
      imagePortPolicy: imagePortPolicyDiagnostics(
        runtime,
        stateRoot,
        imageClaimsRoot,
      ),
      launcherProfile: describePharoLauncherMcpProfile({
        projectRoot,
        config,
        workspaceId: scope.workspaceId,
        targetId: scope.targetId,
        stateRoot,
        env: this.gateway.env,
      }),
      agentAccess: agentAccessDiagnostics(
        gateway,
        gatewayReconciliation,
      ),
      repositoryWorkspaces: repositoryWorkspaceDiagnostics(
        projectRoot,
        config,
        state,
        scope,
      ),
      dependencyRepositoryDetaches:
        dependencyRepositoryDetachDiagnostics(state),
      imageRecovery: imageRecoveryDiagnostics({
        projectRoot,
        stateRoot,
        workspaceId: scope.workspaceId,
        state,
      }),
      imageMcpPorts: imageMcpPorts(state),
      imagePortCoordination: imagePortCoordinationDiagnostics(
        projectRoot,
        stateRoot,
        config,
      ),
      portClaims,
      conflictingListeners,
      staleClaims: portClaims.stale,
      routeTable,
    };

    const safeStatus: ProjectLifecycleStatus = {
      projectId: scope.projectId,
      workspaceId: scope.workspaceId,
      targetId: scope.targetId,
      context,
    };

    if (!input.includeDiagnostics) {
      return safeStatus;
    }

    return {
      ...safeStatus,
      projectRoot,
      stateRoot,
      statePath,
      state,
      gateway,
      ...(route ? { route } : {}),
      diagnostics,
    };
  }

  private async getRouteStatus(
    input: ProjectLifecycleRouteReference & { refreshHealth?: boolean },
    routeRegistry = this.routeRegistry,
  ): Promise<unknown> {
    if (!routeRegistry?.getRouteStatus) {
      return undefined;
    }

    return unwrapToolLikeResult(await routeRegistry.getRouteStatus(input));
  }

  private async registerRoute(
    input: ProjectLifecycleRouteRegistration,
    routeRegistry = this.routeRegistry,
  ): Promise<void> {
    if (!routeRegistry) {
      return;
    }

    unwrapToolLikeResult(await routeRegistry.registerProjectRoute(input));
  }

  private async unregisterRoute(
    input: ProjectLifecycleRouteReference,
    routeRegistry = this.routeRegistry,
  ): Promise<void> {
    if (!routeRegistry) {
      return;
    }

    unwrapToolLikeResult(await routeRegistry.unregisterProjectRoute(input));
  }

  private routeRegistryFromControlUrl(url: string): ProjectLifecycleRouteRegistry {
    return new HttpGatewayRouteRegistry({
      url,
      timeoutMs: this.gateway.routeRegistryTimeoutMs,
      fetch: this.gateway.fetch,
    });
  }

  private routeRegistryForProject(
    config: ReturnType<typeof loadProjectConfig>,
    state?: ProjectState,
  ): ProjectLifecycleRouteRegistry | undefined {
    if (this.routeRegistry) {
      return this.routeRegistry;
    }

    const gateway = state?.gateway ?? projectGatewayStatus(config, state);
    return gateway.controlEndpoint
      ? this.routeRegistryFromControlUrl(gateway.controlEndpoint)
      : undefined;
  }
}

export function createProjectLifecycleFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): PlexusProjectLifecycle {
  const routeControlUrl = env.PLEXUS_GATEWAY_CONTROL_MCP_URL;
  const routeControlPath = env.PLEXUS_GATEWAY_CONTROL_MCP_PATH;
  const routeRegistry =
    routeControlUrl ||
    routeControlPath ||
    env.PLEXUS_GATEWAY_HOST ||
    env.PLEXUS_GATEWAY_PORT
      ? new HttpGatewayRouteRegistry({
          url: routeControlUrl,
          host: env.PLEXUS_GATEWAY_HOST,
          port: env.PLEXUS_GATEWAY_PORT
            ? Number(env.PLEXUS_GATEWAY_PORT)
            : undefined,
          path: routeControlPath,
        })
      : undefined;

  return new PlexusProjectLifecycle({
    routeRegistry,
    defaultStateRoot: env.PLEXUS_STATE_ROOT,
    gateway: { env },
  });
}
