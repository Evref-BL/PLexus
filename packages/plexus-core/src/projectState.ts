import fs from "node:fs";
import {
  projectConfigId,
  resolveProjectRuntimePolicy,
  type ProjectConfig,
  type ProjectImageConfig,
  type ProjectImageRepositoryWorkspaceMaterializationStrategy,
  type ProjectGatewayMode,
  type ProjectRuntimePortRange,
} from "./projectConfig.js";
import {
  basenamePathLike,
  dirnamePathLike,
  joinPathLike,
} from "./pathStyle.js";

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
  cleanupState?: ProjectImageRepositoryWorkspaceCleanupRecord;
}

export interface ProjectImagePharoMcpLoadStatus {
  state: ProjectImagePharoMcpLoadState;
  statusPath: string;
  source?: string;
  loadScript?: string;
  repository?: string;
  baseline?: string;
  error?: string;
}

export interface ProjectImageState {
  id: string;
  imageName: string;
  assignedPort?: number;
  mcpEndpoint?: ProjectImageMcpEndpoint;
  pid?: number;
  status: ProjectImageStatus;
  pharoMcpContract?: ProjectImagePharoMcpContractState;
  pharoMcpLoad?: ProjectImagePharoMcpLoadStatus;
  repositoryWorkspace?: ProjectImageRepositoryWorkspaceState;
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

export interface ProjectState {
  projectId: string;
  projectName: string;
  workspaceId: string;
  targetId: string;
  runtimeStatus?: ProjectRuntimeStatus;
  gateway?: ProjectGatewayState;
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
}

interface NormalizedCreateProjectStateOptions {
  updatedAt: string;
  previousState?: ProjectState;
  portRange?: ProjectPortRange;
  reservedPorts: Set<number>;
  workspaceId: string;
  targetId?: string;
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
  const sanitized = value.trim().replace(/[^A-Za-z0-9._-]+/g, "-");
  return sanitized.replace(/^-+|-+$/g, "") || defaultWorkspaceIdValue;
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

function previousImagePort(
  previousState: ProjectState | undefined,
  imageId: string,
): number | undefined {
  return previousState?.images.find((image) => image.id === imageId)
    ?.assignedPort;
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
): boolean {
  return supportState.pharoMcpContract?.status !== "unsupported";
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
  };
}

export function loadProjectState(filePath: string): ProjectState | undefined {
  if (!fs.existsSync(filePath)) {
    return undefined;
  }

  return JSON.parse(fs.readFileSync(filePath, "utf8")) as ProjectState;
}

export function saveProjectState(filePath: string, state: ProjectState): void {
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
  const workspace = image.repositoryWorkspace;
  if (!workspace) {
    return undefined;
  }

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
      .filter((image) => imageCanUsePharoMcpPort(pharoMcpSupportState(config, image)))
      .map((image) => image.mcp.port)
      .filter((port): port is number => port !== undefined),
  );
  const unavailablePorts = new Set([...options.reservedPorts, ...configuredPorts]);
  const images: ProjectImageState[] = config.images.map((image) => {
    const supportState = pharoMcpSupportState(config, image);
    const canUsePharoMcpPort = imageCanUsePharoMcpPort(supportState);
    const previousPort = previousImagePort(options.previousState, image.id);
    const imageContext = {
      projectId: projectConfigId(config),
      projectName: config.name,
      workspaceId: options.workspaceId,
      targetId,
      imageId: image.id,
    };
    const repositoryWorkspace = projectImageRepositoryWorkspaceState(
      image,
      imageContext,
    );
    let assignedPort = image.mcp.port;

    if (canUsePharoMcpPort) {
      if (assignedPort !== undefined && options.reservedPorts.has(assignedPort)) {
        throw new PortAllocationError(
          `Configured port ${assignedPort} is already reserved by another workspace`,
        );
      }

      if (assignedPort === undefined) {
        if (
          previousPort !== undefined &&
          !configuredPorts.has(previousPort) &&
          !unavailablePorts.has(previousPort)
        ) {
          assignedPort = previousPort;
        } else {
          assignedPort = nextAvailablePort(portRange, unavailablePorts);
        }
      }

      unavailablePorts.add(assignedPort);
    } else {
      assignedPort = undefined;
    }

    return {
      id: image.id,
      imageName: renderProjectImageName(image.imageName, imageContext),
      ...(assignedPort !== undefined ? { assignedPort } : {}),
      status: image.active ? "starting" : "stopped",
      ...supportState,
      ...(repositoryWorkspace ? { repositoryWorkspace } : {}),
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
    runtimeStatus: runtimeStatusForImages(images),
    ...(options.previousState?.gateway
      ? { gateway: options.previousState.gateway }
      : {}),
    updatedAt: options.updatedAt,
    images,
  };
}
