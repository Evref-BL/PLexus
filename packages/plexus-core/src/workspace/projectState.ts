import fs from "node:fs";
import {
  imageRepositoryWorkspaceConfigs,
  projectImageDisplayMode,
  projectConfigId,
  projectMcpStartupMode,
  resolveProjectRuntimePolicy,
  type ProjectConfig,
  type ProjectImageDisplayMode,
  type ProjectImageConfig,
  type ProjectImageCreationCleanupPolicy,
  type ProjectPharoMcpLoadPolicy,
  type ProjectImageRepositoryWorkspaceConfig,
  type ProjectImageRepositoryWorkspaceMaterializationStrategy,
  type ProjectGatewayMode,
  type ProjectRuntimePortRange,
} from "../config/projectConfig.js";
import {
  basenamePathLike,
  dirnamePathLike,
  joinPathLike,
  sanitizePathSegment,
} from "../support/pathStyle.js";

export const plexusStateDirectoryName = ".plexus";
export const plexusProjectsStateDirectoryName = "projects";
export const plexusWorkspacesStateDirectoryName = "workspaces";
export const projectStateFileName = "state.json";
export const defaultWorkspaceIdValue = "default";
export const defaultProjectPortRange = {
  start: 7_100,
  end: 7_199,
} as const;

export type ProjectImageStatus = "starting" | "running" | "stopped" | "failed";
export type ProjectRuntimeStatus = "idle" | "starting" | "running" | "failed";
export type PharoMcpContractStatus =
  | "unknown"
  | "matching"
  | "mismatched"
  | "unsupported";
export type ProjectImageMcpEndpointTransport = "http";

export interface ProjectImageMcpEndpoint {
  transport: ProjectImageMcpEndpointTransport;
  host: string;
  port: number;
  path: string;
}

export interface ProjectImageTemplateCreationSourceState {
  kind: "template";
  profileId?: string;
  templateName: string;
  templateCategory?: string;
}

export type ProjectImageCreationSourceState =
  ProjectImageTemplateCreationSourceState;

export interface ProjectImageCreationRouteState {
  serverName: "pharo_gateway";
  targetKey: "targetId";
  imageArgument: "imageId";
  imageId: string;
}

export interface ProjectImageCreationState {
  role?: string;
  source: ProjectImageCreationSourceState;
  cleanupPolicy: ProjectImageCreationCleanupPolicy;
  route: ProjectImageCreationRouteState;
}

export interface PharoMcpContractReference {
  id?: string;
  hash?: string;
}

export interface ProjectImagePharoMcpContractState
  extends PharoMcpContractReference {
  status?: PharoMcpContractStatus;
  expectedId?: string;
  expectedHash?: string;
  metadataKey?: string;
  actualMajorVersion?: number;
  supportedMajorVersions?: number[];
  reason?: string;
}

export type ProjectImageRepositoryWorkspaceDirtyState =
  | "unknown"
  | "clean"
  | "dirty";
export type ProjectImageRepositoryWorkspaceLoadState =
  | "not-loaded"
  | "pending"
  | "loaded"
  | "failed";
export type ProjectImageRepositoryWorkspaceRegistrationState =
  | "pending"
  | "registered"
  | "failed"
  | "skipped";
export type ProjectImageDependencyRepositoryDetachState =
  | "detached"
  | "failed"
  | "skipped";
export type ProjectImagePharoMcpLoadState =
  | "provided"
  | "loaded"
  | "failed";
export type ProjectImageRepositoryWorkspaceMaterializationState =
  | "planned"
  | "ready"
  | "reused"
  | "failed";
export type ProjectImageRepositoryWorkspaceCleanupPolicy =
  | "preserve"
  | "archive"
  | "delete-disposable";
export type ProjectImageRepositoryWorkspaceCleanupDecision =
  | "preserved"
  | "archived"
  | "deleted"
  | "refused"
  | "missing"
  | "failed";
export type ProjectImageLeaseOwnerKind =
  | "target"
  | "workspace"
  | "thread"
  | "session"
  | "workItem"
  | "agent"
  | "human"
  | "unknown";
export type ProjectImageLeaseMode = "mutable" | "read-only";

export interface ProjectImageLeaseState {
  ownerId: string;
  ownerKind: ProjectImageLeaseOwnerKind;
  mode: ProjectImageLeaseMode;
  purpose: string;
  createdAt: string;
  heartbeatAt: string;
  expiresAt?: string;
  repositoryPath?: string;
  branch?: string;
  cleanupCommand?: string;
}

export interface ProjectImageRepositoryWorkspaceRepositoryState {
  id: string;
  componentId?: string;
  remoteUrl?: string;
  originPath?: string;
}

export interface ProjectImageRepositoryWorkspaceCleanupRecord {
  policy: ProjectImageRepositoryWorkspaceCleanupPolicy;
  decision: ProjectImageRepositoryWorkspaceCleanupDecision;
  imageId: string;
  repositoryId: string;
  path: string;
  dirtyState: ProjectImageRepositoryWorkspaceDirtyState;
  recordedAt: string;
  branch?: string;
  baseCommit?: string;
  currentCommit?: string;
  archivePath?: string;
  message?: string;
}

export interface ProjectImageRepositoryWorkspaceState {
  repository: ProjectImageRepositoryWorkspaceRepositoryState;
  path: string;
  materializationStrategy: ProjectImageRepositoryWorkspaceMaterializationStrategy;
  sourceDirectory: string;
  baseline: string;
  loadGroup?: string;
  pharoVersion?: number;
  templateName?: string;
  templateCategory?: string;
  branch?: string;
  baseBranch?: string;
  baseCommit?: string;
  currentCommit?: string;
  sourcePath?: string;
  materializationState: ProjectImageRepositoryWorkspaceMaterializationState;
  diagnostics: string[];
  dirtyState: ProjectImageRepositoryWorkspaceDirtyState;
  loadState: ProjectImageRepositoryWorkspaceLoadState;
  loadSourcePath?: string;
  loadStatusPath?: string;
  loadError?: string;
  registrationState?: ProjectImageRepositoryWorkspaceRegistrationState;
  registeredRepositoryName?: string;
  registeredPackageNames?: string[];
  registrationError?: string;
  cleanupState?: ProjectImageRepositoryWorkspaceCleanupRecord;
}

export interface ProjectImageDetachedDependencyRepositoryState {
  location: string;
  name?: string;
}

export interface ProjectImageDependencyRepositoryDetachStatus {
  state: ProjectImageDependencyRepositoryDetachState;
  statusPath: string;
  cachePath?: string;
  detachedCount: number;
  repositories: ProjectImageDetachedDependencyRepositoryState[];
  message?: string;
  error?: string;
}

export interface ProjectImagePharoMcpLoadStatus {
  state: ProjectImagePharoMcpLoadState;
  statusPath: string;
  source?: string;
  loadScript?: string;
  loadPolicy?: ProjectPharoMcpLoadPolicy | string;
  repository?: string;
  configuredRepositoryHint?: string;
  baseline?: string;
  error?: string;
}

export interface ProjectImageState {
  id: string;
  imageName: string;
  displayMode?: ProjectImageDisplayMode;
  assignedPort?: number;
  mcpEndpoint?: ProjectImageMcpEndpoint;
  pid?: number;
  status: ProjectImageStatus;
  creation?: ProjectImageCreationState;
  lease?: ProjectImageLeaseState;
  pharoMcpContract?: ProjectImagePharoMcpContractState;
  pharoMcpLoad?: ProjectImagePharoMcpLoadStatus;
  dependencyRepositoryDetach?: ProjectImageDependencyRepositoryDetachStatus;
  repositoryWorkspace?: ProjectImageRepositoryWorkspaceState;
  repositoryWorkspaces?: ProjectImageRepositoryWorkspaceState[];
  imagePath?: string;
  imageDirectoryPath?: string;
  changesPath?: string;
  localDirectoryPath?: string;
  ombuDirectoryPath?: string;
  vmId?: string;
  pharoVersion?: string;
  originTemplate?: {
    name?: string;
    url?: string;
  };
  rescueSnapshot?: {
    capturedAt: string;
    launcherImage?: {
      name?: string;
      pharoVersion?: string;
      imagePath?: string;
      originTemplate?: {
        name?: string;
        url?: string;
      };
      vmId?: string;
    };
    paths: {
      imagePath?: string;
      imageDirectoryPath?: string;
      changesPath?: string;
      localDirectoryPath?: string;
      ombuDirectoryPath?: string;
    };
    repositories?: {
      capturedAt: string;
      status: "captured" | "unavailable";
      repositories: Record<string, unknown>[];
      error?: string;
    };
  };
}

export interface ProjectGatewayClaimState {
  claimsRoot: string;
  claimId: string;
  assignedPort: number;
}

export interface ProjectGatewayState {
  mode: ProjectGatewayMode;
  endpoint?: string;
  controlEndpoint?: string;
  host?: string;
  port?: number;
  portRange?: ProjectRuntimePortRange;
  routePath?: string;
  controlPath?: string;
  owningProjectId?: string;
  managedByProject: boolean;
  pid?: number;
  claim?: ProjectGatewayClaimState;
}

export interface ProjectRemoteGatewayState {
  remoteNodeId: string;
  endpoint: ProjectImageMcpEndpoint;
  projectId?: string;
  workspaceId?: string;
  targetId?: string;
}

export interface ProjectState {
  projectId: string;
  projectName: string;
  workspaceId: string;
  targetId: string;
  sourcePath?: string;
  runtimeStatus?: ProjectRuntimeStatus;
  gateway?: ProjectGatewayState;
  remoteGateway?: ProjectRemoteGatewayState;
  pharoMcpContract?: PharoMcpContractReference;
  images: ProjectImageState[];
  updatedAt: string;
}

export interface ProjectPortRange {
  start: number;
  end: number;
}

export interface CreateProjectStateOptions {
  updatedAt?: string;
  previousState?: ProjectState;
  portRange?: ProjectPortRange;
  reservedPorts?: Iterable<number>;
  workspaceId?: string;
  targetId?: string;
  sourcePath?: string;
}

interface NormalizedCreateProjectStateOptions {
  updatedAt: string;
  previousState?: ProjectState;
  portRange?: ProjectPortRange;
  reservedPorts: Set<number>;
  workspaceId: string;
  targetId?: string;
  sourcePath?: string;
}

export interface ProjectStatePathOptions {
  projectRoot: string;
  projectId: string;
  workspaceId?: string;
  stateRoot?: string;
}

export interface ProjectStatePathForConfigOptions {
  projectRoot: string;
  config: ProjectConfig;
  workspaceId?: string;
  stateRoot?: string;
}

export class PortAllocationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PortAllocationError";
  }
}

export class ProjectStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectStateError";
  }
}

export function defaultPlexusStateRoot(projectRoot: string): string {
  return joinPathLike(projectRoot, plexusStateDirectoryName);
}

export function sanitizeRuntimeId(value: string): string {
  return sanitizePathSegment(value.trim(), defaultWorkspaceIdValue);
}

export function defaultWorkspaceId(projectRoot: string): string {
  return sanitizeRuntimeId(basenamePathLike(projectRoot));
}

export function defaultTargetId(projectId: string, workspaceId: string): string {
  return `${projectId}--${workspaceId}`;
}

export function projectWorkspacesStateDirectoryPath(
  options: Omit<ProjectStatePathOptions, "workspaceId">,
): string {
  const stateRoot =
    options.stateRoot ?? defaultPlexusStateRoot(options.projectRoot);

  return joinPathLike(
    stateRoot,
    plexusProjectsStateDirectoryName,
    options.projectId,
    plexusWorkspacesStateDirectoryName,
  );
}

export function projectStateDirectoryPath(
  options: ProjectStatePathOptions,
): string {
  return joinPathLike(
    projectWorkspacesStateDirectoryPath(options),
    options.workspaceId
      ? sanitizeRuntimeId(options.workspaceId)
      : defaultWorkspaceId(options.projectRoot),
  );
}

export function projectStatePath(options: ProjectStatePathOptions): string {
  return joinPathLike(projectStateDirectoryPath(options), projectStateFileName);
}

export function projectStateRootForConfig(
  config: ProjectConfig,
  stateRoot?: string,
): string | undefined {
  if (stateRoot) {
    return stateRoot;
  }

  const runtime = resolveProjectRuntimePolicy(config);
  return runtime.stateRoot.mode === "external"
    ? runtime.stateRoot.path
    : undefined;
}

export function projectStatePathForConfig(
  options: ProjectStatePathForConfigOptions,
): string {
  return projectStatePath({
    projectRoot: options.projectRoot,
    projectId: projectConfigId(options.config),
    workspaceId: options.workspaceId,
    stateRoot: projectStateRootForConfig(options.config, options.stateRoot),
  });
}

function validatePortRange(range: ProjectPortRange): void {
  if (
    !Number.isInteger(range.start) ||
    !Number.isInteger(range.end) ||
    range.start < 1 ||
    range.end > 65_535 ||
    range.start > range.end
  ) {
    throw new PortAllocationError(
      "Port range must use integer ports between 1 and 65535 with start <= end",
    );
  }
}

function nextAvailablePort(
  range: ProjectPortRange,
  unavailablePorts: Set<number>,
): number {
  for (let port = range.start; port <= range.end; port += 1) {
    if (!unavailablePorts.has(port)) {
      return port;
    }
  }

  throw new PortAllocationError(
    `No available port in range ${range.start}-${range.end}`,
  );
}

function pharoMajorVersionFromText(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const pharoMatch = /\bPharo\s*(\d{1,2})(?:\.\d+)?\b/i.exec(value);
  if (pharoMatch) {
    return Number.parseInt(pharoMatch[1], 10);
  }

  const numericMatch = /^(\d{1,2})(?:\.\d+)?$/.exec(value.trim());
  if (numericMatch) {
    return Number.parseInt(numericMatch[1], 10);
  }

  const launcherVersionMatch = /^(\d{2})0$/.exec(value.trim());
  if (launcherVersionMatch) {
    return Number.parseInt(launcherVersionMatch[1], 10);
  }

  return undefined;
}

function preparedImageForProjectImage(
  config: ProjectConfig,
  image: ProjectImageConfig,
) {
  const cacheId = image.preparedImage?.cacheId;
  return cacheId
    ? config.preparedImages?.find((candidate) => candidate.id === cacheId)
    : undefined;
}

function detectedPharoMajorVersion(
  config: ProjectConfig,
  image: ProjectImageConfig,
): number | undefined {
  return (
    pharoMajorVersionFromText(image.create?.templateName) ??
    pharoMajorVersionFromText(
      preparedImageForProjectImage(config, image)?.source.templateName,
    )
  );
}

function pharoMcpSupportState(
  config: ProjectConfig,
  image: ProjectImageConfig,
): Pick<ProjectImageState, "pharoVersion" | "pharoMcpContract"> {
  const majorVersion = detectedPharoMajorVersion(config, image);
  if (majorVersion === undefined) {
    return {};
  }

  const policy = resolveProjectRuntimePolicy(config).pharoMcp;
  const supported = policy.supportedMajorVersions.includes(majorVersion);
  const supportedLabel = policy.supportedMajorVersions.join(", ");

  return {
    pharoVersion: String(majorVersion),
    pharoMcpContract: {
      metadataKey: policy.metadataKey,
      status: supported ? "matching" : "unsupported",
      actualMajorVersion: majorVersion,
      supportedMajorVersions: [...policy.supportedMajorVersions],
      reason: supported
        ? `Pharo ${majorVersion} is supported by the Pharo MCP contract.`
        : `Pharo ${majorVersion} is outside the supported Pharo MCP range (${supportedLabel}).`,
    },
  };
}

function imageCanUsePharoMcpPort(
  supportState: Pick<ProjectImageState, "pharoMcpContract">,
  image: ProjectImageConfig,
): boolean {
  return (
    projectMcpStartupMode(image.mcp) !== "disabled" &&
    supportState.pharoMcpContract?.status !== "unsupported"
  );
}

function normalizeCreateProjectStateOptions(
  optionsOrUpdatedAt: string | CreateProjectStateOptions | undefined,
): NormalizedCreateProjectStateOptions {
  if (typeof optionsOrUpdatedAt === "string") {
    const workspaceId = defaultWorkspaceIdValue;
    return {
      updatedAt: optionsOrUpdatedAt,
      previousState: undefined,
      portRange: undefined,
      reservedPorts: new Set(),
      workspaceId,
      targetId: undefined,
      sourcePath: undefined,
    };
  }

  const workspaceId = sanitizeRuntimeId(
    optionsOrUpdatedAt?.workspaceId ??
      optionsOrUpdatedAt?.previousState?.workspaceId ??
      defaultWorkspaceIdValue,
  );

  return {
    updatedAt: optionsOrUpdatedAt?.updatedAt ?? new Date().toISOString(),
    previousState: optionsOrUpdatedAt?.previousState,
    portRange: optionsOrUpdatedAt?.portRange,
    reservedPorts: new Set(optionsOrUpdatedAt?.reservedPorts ?? []),
    workspaceId,
    targetId:
      optionsOrUpdatedAt?.targetId ?? optionsOrUpdatedAt?.previousState?.targetId,
    sourcePath:
      optionsOrUpdatedAt?.sourcePath ?? optionsOrUpdatedAt?.previousState?.sourcePath,
  };
}

export function loadProjectState(filePath: string): ProjectState | undefined {
  if (!fs.existsSync(filePath)) {
    return undefined;
  }

  const state = JSON.parse(fs.readFileSync(filePath, "utf8")) as ProjectState;
  for (const image of state.images) {
    syncProjectImageRepositoryWorkspaceAliases(image);
  }
  return state;
}

export function saveProjectState(filePath: string, state: ProjectState): void {
  for (const image of state.images) {
    syncProjectImageRepositoryWorkspaceAliases(image);
  }
  fs.mkdirSync(dirnamePathLike(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

export interface ReservedProjectPortOwner {
  port: number;
  projectId: string;
  projectName: string;
  workspaceId: string;
  targetId: string;
  imageId: string;
  imageName: string;
  status: ProjectImageStatus;
}

export function collectReservedProjectPortOwners(
  options: Omit<ProjectStatePathOptions, "workspaceId"> & {
    excludeWorkspaceId?: string;
  },
): ReservedProjectPortOwner[] {
  const workspacesDir = projectWorkspacesStateDirectoryPath(options);
  if (!fs.existsSync(workspacesDir)) {
    return [];
  }

  const excludedWorkspaceId = options.excludeWorkspaceId
    ? sanitizeRuntimeId(options.excludeWorkspaceId)
    : undefined;
  const owners: ReservedProjectPortOwner[] = [];

  for (const entry of fs.readdirSync(workspacesDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === excludedWorkspaceId) {
      continue;
    }

    const state = loadProjectState(
      joinPathLike(workspacesDir, entry.name, projectStateFileName),
    );
    if (!state) {
      continue;
    }

    for (const image of state.images) {
      if (image.status !== "stopped" && image.assignedPort !== undefined) {
        owners.push({
          port: image.assignedPort,
          projectId: state.projectId,
          projectName: state.projectName,
          workspaceId: state.workspaceId,
          targetId: state.targetId,
          imageId: image.id,
          imageName: image.imageName,
          status: image.status,
        });
      }
    }
  }

  return owners;
}

export function collectReservedProjectPorts(
  options: Omit<ProjectStatePathOptions, "workspaceId"> & {
    excludeWorkspaceId?: string;
  },
): number[] {
  return [
    ...new Set(
      collectReservedProjectPortOwners(options).map((owner) => owner.port),
    ),
  ];
}

export interface ProjectImageNameTemplateContext {
  projectId: string;
  projectName: string;
  workspaceId: string;
  targetId: string;
  imageId: string;
}

export interface ProjectImageRepositoryWorkspacePathTemplateContext
  extends ProjectImageNameTemplateContext {
  repositoryId: string;
}

export function renderProjectImageName(
  template: string,
  context: ProjectImageNameTemplateContext,
): string {
  return template.replace(
    /\{(projectId|projectName|workspaceId|targetId|imageId)\}/g,
    (_match, key: keyof ProjectImageNameTemplateContext) => context[key],
  );
}

export function renderProjectImageRepositoryWorkspacePath(
  template: string,
  context: ProjectImageRepositoryWorkspacePathTemplateContext,
): string {
  return template.replace(
    /\{(projectId|projectName|workspaceId|targetId|imageId|repositoryId)\}/g,
    (
      _match,
      key: keyof ProjectImageRepositoryWorkspacePathTemplateContext,
    ) => context[key],
  );
}

function defaultRepositoryWorkspacePath(
  context: ProjectImageRepositoryWorkspacePathTemplateContext,
): string {
  return (
    `image-local://${sanitizeRuntimeId(context.imageId)}/pharo-local/iceberg/` +
    sanitizeRuntimeId(context.repositoryId)
  );
}

export function projectImageRepositoryWorkspaceState(
  image: ProjectImageConfig,
  context: ProjectImageNameTemplateContext,
): ProjectImageRepositoryWorkspaceState | undefined {
  return projectImageRepositoryWorkspaceStates(image, context)[0];
}

function projectImageRepositoryWorkspaceConfigState(
  workspace: ProjectImageRepositoryWorkspaceConfig,
  context: ProjectImageNameTemplateContext,
): ProjectImageRepositoryWorkspaceState {
  const pathContext = {
    ...context,
    repositoryId: workspace.repository.id,
  };
  const path = workspace.materialization.path
    ? renderProjectImageRepositoryWorkspacePath(
        workspace.materialization.path,
        pathContext,
      )
    : defaultRepositoryWorkspacePath(pathContext);

  return {
    repository: {
      id: workspace.repository.id,
      ...(workspace.repository.componentId
        ? { componentId: workspace.repository.componentId }
        : {}),
      ...(workspace.repository.remoteUrl
        ? { remoteUrl: workspace.repository.remoteUrl }
        : {}),
      ...(workspace.repository.originPath
        ? { originPath: workspace.repository.originPath }
        : {}),
    },
    path,
    materializationStrategy: workspace.materialization.strategy,
    sourceDirectory: workspace.sourceDirectory,
    baseline: workspace.baseline,
    ...(workspace.loadGroup ? { loadGroup: workspace.loadGroup } : {}),
    ...(workspace.pharoVersion !== undefined
      ? { pharoVersion: workspace.pharoVersion }
      : {}),
    ...(workspace.templateName ? { templateName: workspace.templateName } : {}),
    ...(workspace.templateCategory
      ? { templateCategory: workspace.templateCategory }
      : {}),
    ...(workspace.branch ? { branch: workspace.branch } : {}),
    ...(workspace.baseBranch ? { baseBranch: workspace.baseBranch } : {}),
    ...(workspace.baseCommit ? { baseCommit: workspace.baseCommit } : {}),
    materializationState: "planned",
    diagnostics: [],
    dirtyState: "unknown",
    loadState: "not-loaded",
  };
}

export function projectImageRepositoryWorkspaceStates(
  image: ProjectImageConfig,
  context: ProjectImageNameTemplateContext,
): ProjectImageRepositoryWorkspaceState[] {
  return imageRepositoryWorkspaceConfigs(image).map((workspace) =>
    projectImageRepositoryWorkspaceConfigState(workspace, context),
  );
}

export function projectImageRepositoryWorkspaces(
  image: Pick<
    ProjectImageState,
    "repositoryWorkspace" | "repositoryWorkspaces"
  >,
): ProjectImageRepositoryWorkspaceState[] {
  if (image.repositoryWorkspaces && image.repositoryWorkspaces.length > 0) {
    return image.repositoryWorkspaces;
  }
  return image.repositoryWorkspace ? [image.repositoryWorkspace] : [];
}

export function syncProjectImageRepositoryWorkspaceAliases(
  image: ProjectImageState,
): void {
  const workspaces = projectImageRepositoryWorkspaces(image);
  if (workspaces.length === 0) {
    delete image.repositoryWorkspace;
    delete image.repositoryWorkspaces;
    return;
  }

  image.repositoryWorkspaces = workspaces;
  image.repositoryWorkspace = workspaces[0];
}

export function runtimeStatusForImages(
  images: readonly ProjectImageState[],
): ProjectRuntimeStatus {
  if (images.length === 0) {
    return "idle";
  }
  if (images.some((image) => image.status === "failed")) {
    return "failed";
  }
  if (images.some((image) => image.status === "starting")) {
    return "starting";
  }
  if (images.some((image) => image.status === "running")) {
    return "running";
  }

  return "idle";
}

function assignedProjectImagePort(input: {
  image: ProjectImageConfig;
  canUsePharoMcpPort: boolean;
  previousPort: number | undefined;
  configuredPorts: ReadonlySet<number>;
  unavailablePorts: Set<number>;
  reservedPorts: ReadonlySet<number>;
  portRange: ProjectRuntimePortRange;
}): number | undefined {
  if (!input.canUsePharoMcpPort) {
    return undefined;
  }

  const configuredPort = input.image.mcp.port;
  if (configuredPort !== undefined && input.reservedPorts.has(configuredPort)) {
    throw new PortAllocationError(
      `Configured port ${configuredPort} is already reserved by another workspace`,
    );
  }

  const assignedPort =
    configuredPort ??
    (input.previousPort !== undefined &&
    !input.configuredPorts.has(input.previousPort) &&
    !input.unavailablePorts.has(input.previousPort)
      ? input.previousPort
      : nextAvailablePort(input.portRange, input.unavailablePorts));

  input.unavailablePorts.add(assignedPort);
  return assignedPort;
}

export function createProjectState(
  config: ProjectConfig,
  optionsOrUpdatedAt?: string | CreateProjectStateOptions,
): ProjectState {
  const options = normalizeCreateProjectStateOptions(optionsOrUpdatedAt);
  const runtime = resolveProjectRuntimePolicy(config);
  const portRange = options.portRange ?? runtime.imagePorts.range;
  validatePortRange(portRange);

  const targetId =
    options.targetId ??
    defaultTargetId(projectConfigId(config), options.workspaceId);
  const configuredPorts = new Set(
    config.images
      .filter((image) =>
        imageCanUsePharoMcpPort(pharoMcpSupportState(config, image), image),
      )
      .map((image) => image.mcp.port)
      .filter((port): port is number => port !== undefined),
  );
  const unavailablePorts = new Set([...options.reservedPorts, ...configuredPorts]);
  const images: ProjectImageState[] = config.images.map((image) => {
    const supportState = pharoMcpSupportState(config, image);
    const canUsePharoMcpPort = imageCanUsePharoMcpPort(supportState, image);
    const previousImage = options.previousState?.images.find(
      (candidate) => candidate.id === image.id,
    );
    const previousPort = previousImage?.assignedPort;
    const imageContext = {
      projectId: projectConfigId(config),
      projectName: config.name,
      workspaceId: options.workspaceId,
      targetId,
      imageId: image.id,
    };
    const repositoryWorkspaces = projectImageRepositoryWorkspaceStates(
      image,
      imageContext,
    );
    const assignedPort = assignedProjectImagePort({
      image,
      canUsePharoMcpPort,
      previousPort,
      configuredPorts,
      unavailablePorts,
      reservedPorts: options.reservedPorts,
      portRange,
    });

    return {
      id: image.id,
      imageName: renderProjectImageName(image.imageName, imageContext),
      ...(image.displayMode !== undefined
        ? { displayMode: projectImageDisplayMode(image) }
        : {}),
      ...(assignedPort !== undefined ? { assignedPort } : {}),
      status: image.active ? "starting" : "stopped",
      ...(previousImage?.lease ? { lease: previousImage.lease } : {}),
      ...supportState,
      ...(repositoryWorkspaces.length > 0
        ? {
            repositoryWorkspaces,
            repositoryWorkspace: repositoryWorkspaces[0],
          }
        : {}),
    };
  });

  const imageNames = new Set<string>();
  for (const image of images) {
    if (imageNames.has(image.imageName)) {
      throw new ProjectStateError(
        `Rendered image names must be unique: ${image.imageName}`,
      );
    }

    imageNames.add(image.imageName);
  }

  return {
    projectId: projectConfigId(config),
    projectName: config.name,
    workspaceId: options.workspaceId,
    targetId,
    ...(options.sourcePath ?? options.previousState?.sourcePath
      ? { sourcePath: options.sourcePath ?? options.previousState?.sourcePath }
      : {}),
    runtimeStatus: runtimeStatusForImages(images),
    ...(options.previousState?.gateway
      ? { gateway: options.previousState.gateway }
      : {}),
    updatedAt: options.updatedAt,
    images,
  };
}
