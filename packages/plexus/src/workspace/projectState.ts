import fs from "node:fs";
import {
  projectImageDisplayMode,
  projectConfigId,
  resolveProjectRuntimePolicy,
  type ProjectConfig,
  type ProjectImageDisplayMode,
  type ProjectImageConfig,
  type ProjectImageCreationCleanupPolicy,
  type ProjectPharoMcpLoadPolicy,
  type ProjectGatewayMode,
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

export interface ProjectImageMcpServer {
  id: string;
  endpoint: ProjectImageMcpEndpoint;
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
  targetKey: "workspaceId";
  imageArgument: "mcpServerId";
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

export type ProjectImageDependencyRepositoryDetachState =
  | "detached"
  | "failed"
  | "skipped";
export type ProjectImagePharoMcpLoadState =
  | "provided"
  | "loaded"
  | "failed";
export type ProjectImageLeaseOwnerKind =
  | "target"
  | "workspace"
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
  mcpServers?: ProjectImageMcpServer[];
  pid?: number;
  status: ProjectImageStatus;
  creation?: ProjectImageCreationState;
  lease?: ProjectImageLeaseState;
  pharoMcpContract?: ProjectImagePharoMcpContractState;
  pharoMcpLoad?: ProjectImagePharoMcpLoadStatus;
  dependencyRepositoryDetach?: ProjectImageDependencyRepositoryDetachStatus;
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
      repositories: {
        name: string;
        location?: string;
        subdirectory?: string;
      }[];
      error?: string;
    };
  };
}

export interface ProjectGatewayState {
  mode: ProjectGatewayMode;
  endpoint?: string;
  controlEndpoint?: string;
  host?: string;
  port?: number;
  routePath?: string;
  controlPath?: string;
  owningProjectId?: string;
  managedByProject: boolean;
  pid?: number;
}

export interface ProjectRemoteGatewayState {
  remoteNodeId: string;
  endpoint: ProjectImageMcpEndpoint;
  projectId?: string;
  workspaceId?: string;
}

export interface ProjectState {
  projectId: string;
  projectName: string;
  workspaceId: string;
  sourcePath?: string;
  runtimeStatus?: ProjectRuntimeStatus;
  gateway?: ProjectGatewayState;
  remoteGateway?: ProjectRemoteGatewayState;
  pharoMcpContract?: PharoMcpContractReference;
  images: ProjectImageState[];
  updatedAt: string;
}

export interface CreateProjectStateOptions {
  updatedAt?: string;
  previousState?: ProjectState;
  workspaceId?: string;
  sourcePath?: string;
}

interface NormalizedCreateProjectStateOptions {
  updatedAt: string;
  previousState?: ProjectState;
  workspaceId: string;
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

function normalizeCreateProjectStateOptions(
  optionsOrUpdatedAt: string | CreateProjectStateOptions | undefined,
): NormalizedCreateProjectStateOptions {
  if (typeof optionsOrUpdatedAt === "string") {
    const workspaceId = defaultWorkspaceIdValue;
    return {
      updatedAt: optionsOrUpdatedAt,
      previousState: undefined,
      workspaceId,
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
    workspaceId,
    sourcePath:
      optionsOrUpdatedAt?.sourcePath ?? optionsOrUpdatedAt?.previousState?.sourcePath,
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

export interface ProjectImageNameTemplateContext {
  projectId: string;
  projectName: string;
  workspaceId: string;
  imageId: string;
}

export function renderProjectImageName(
  template: string,
  context: ProjectImageNameTemplateContext,
): string {
  return template.replace(
    /\{(projectId|projectName|workspaceId|imageId)\}/g,
    (_match, key: keyof ProjectImageNameTemplateContext) => context[key],
  );
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
  const images: ProjectImageState[] = config.images.map((image) => {
    const supportState = pharoMcpSupportState(config, image);
    const previousImage = options.previousState?.images.find(
      (candidate) => candidate.id === image.id,
    );
    const imageContext = {
      projectId: projectConfigId(config),
      projectName: config.name,
      workspaceId: options.workspaceId,
      imageId: image.id,
    };
    return {
      id: image.id,
      imageName: renderProjectImageName(image.imageName, imageContext),
      ...(image.displayMode !== undefined
        ? { displayMode: projectImageDisplayMode(image) }
        : {}),
      status: "stopped",
      ...(previousImage?.lease ? { lease: previousImage.lease } : {}),
      ...supportState,
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
