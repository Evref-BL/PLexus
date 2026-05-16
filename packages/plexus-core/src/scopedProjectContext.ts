import {
  loadProjectConfig,
  type ProjectConfig,
  type ProjectImageConfig,
} from "./projectConfig.js";
import {
  defaultTargetId,
  defaultWorkspaceId,
  loadProjectState,
  projectStatePathForConfig,
  renderProjectImageName,
  sanitizeRuntimeId,
  type ProjectImageState,
  type ProjectImageStatus,
  type ProjectState,
} from "./projectState.js";
import { resolvePathLike } from "./pathStyle.js";

export type ScopedProjectContextSchemaVersion = 1;
export type ScopedImageStatus = ProjectImageStatus | "declared";
export type ScopedImageCleanupPolicy = "workspace_cleanup_only";

export interface ScopedProjectContextScope {
  projectRoot: string;
  projectId: string;
  projectName: string;
  workspaceId: string;
  targetId: string;
  stateRoot?: string;
  statePath: string;
}

export interface ScopedImageOwnership {
  projectId: string;
  workspaceId: string;
  targetId: string;
  owned: true;
  disposable: true;
}

export interface ScopedImageAffordanceAllowed {
  allowed: true;
  toolName: string;
  arguments: Record<string, unknown>;
}

export interface ScopedImageAffordanceDenied {
  allowed: false;
  reason: string;
}

export type ScopedImageAffordance =
  | ScopedImageAffordanceAllowed
  | ScopedImageAffordanceDenied;

export interface ScopedImageAffordances {
  create: ScopedImageAffordance;
  start: ScopedImageAffordance;
  stop: ScopedImageAffordance;
  delete: ScopedImageAffordanceDenied;
}

export interface ScopedImageCleanupPaths {
  imagePath?: string;
  imageDirectoryPath?: string;
  changesPath?: string;
  localDirectoryPath?: string;
  ombuDirectoryPath?: string;
}

export interface ScopedImageCleanupMetadata {
  disposable: true;
  statePath: string;
  launcherImageName: string;
  policy: ScopedImageCleanupPolicy;
  paths: ScopedImageCleanupPaths;
}

export interface ScopedImageGatewayRouteMetadata {
  serverName: "gateway";
  requiredArgument: "imageId";
  imageId: string;
  routeReference: {
    projectId: string;
    workspaceId: string;
    targetId: string;
  };
  imageIdSource: string;
  recordHint: string;
}

export interface ScopedImageContext {
  imageId: string;
  launcherImageName: string;
  active: boolean;
  status: ScopedImageStatus;
  assignedPort?: number;
  pid?: number;
  ownership: ScopedImageOwnership;
  affordances: ScopedImageAffordances;
  cleanup: ScopedImageCleanupMetadata;
  route: ScopedImageGatewayRouteMetadata;
}

export interface ScopedProjectContext {
  schemaVersion: ScopedProjectContextSchemaVersion;
  scope: ScopedProjectContextScope;
  images: ScopedImageContext[];
}

export interface BuildScopedProjectContextOptions {
  projectRoot: string;
  projectConfig?: ProjectConfig;
  workspaceId?: string;
  targetId?: string;
  stateRoot?: string;
  projectState?: ProjectState;
}

export class ScopedProjectContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScopedProjectContextError";
  }
}

function allowed(
  toolName: string,
  argumentsValue: Record<string, unknown>,
): ScopedImageAffordanceAllowed {
  return {
    allowed: true,
    toolName,
    arguments: argumentsValue,
  };
}

function denied(reason: string): ScopedImageAffordanceDenied {
  return {
    allowed: false,
    reason,
  };
}

function cleanupPaths(
  imageState: ProjectImageState | undefined,
): ScopedImageCleanupPaths {
  return {
    ...(imageState?.imagePath ? { imagePath: imageState.imagePath } : {}),
    ...(imageState?.imageDirectoryPath
      ? { imageDirectoryPath: imageState.imageDirectoryPath }
      : {}),
    ...(imageState?.changesPath ? { changesPath: imageState.changesPath } : {}),
    ...(imageState?.localDirectoryPath
      ? { localDirectoryPath: imageState.localDirectoryPath }
      : {}),
    ...(imageState?.ombuDirectoryPath
      ? { ombuDirectoryPath: imageState.ombuDirectoryPath }
      : {}),
  };
}

function imageStatus(
  imageState: ProjectImageState | undefined,
): ScopedImageStatus {
  return imageState?.status ?? "declared";
}

function createAffordance(
  imageId: string,
  imageState: ProjectImageState | undefined,
): ScopedImageAffordance {
  if (imageState) {
    return denied("Image already has runtime state");
  }

  return allowed("pharo_launcher_image_create", { imageId });
}

function startAffordance(
  imageConfig: ProjectImageConfig,
  status: ScopedImageStatus,
): ScopedImageAffordance {
  if (!imageConfig.active) {
    return denied("Image is inactive in project config");
  }

  if (status === "running") {
    return denied("Image is already running");
  }

  if (status === "starting") {
    return denied("Image is already starting");
  }

  return allowed("pharo_launcher_image_start", { imageId: imageConfig.id });
}

function stopAffordance(
  imageId: string,
  status: ScopedImageStatus,
): ScopedImageAffordance {
  if (status !== "running" && status !== "starting") {
    return denied("Image is not running");
  }

  return allowed("pharo_launcher_image_stop", {
    imageId,
    confirm: true,
  });
}

function lifecycleAffordances(
  imageConfig: ProjectImageConfig,
  imageState: ProjectImageState | undefined,
): ScopedImageAffordances {
  const status = imageStatus(imageState);
  return {
    create: createAffordance(imageConfig.id, imageState),
    start: startAffordance(imageConfig, status),
    stop: stopAffordance(imageConfig.id, status),
    delete: denied(
      "Deletion is reserved for PLexus workspace cleanup policy, not the agent launcher surface",
    ),
  };
}

function routeMetadata(
  scope: ScopedProjectContextScope,
  imageId: string,
): ScopedImageGatewayRouteMetadata {
  return {
    serverName: "gateway",
    requiredArgument: "imageId",
    imageId,
    routeReference: {
      projectId: scope.projectId,
      workspaceId: scope.workspaceId,
      targetId: scope.targetId,
    },
    imageIdSource:
      "Read images[].imageId from this scoped context or pharo-launcher image list",
    recordHint:
      "Store the selected imageId with the scoped project/workspace/target before calling gateway tools",
  };
}

function validateProjectState(
  scope: ScopedProjectContextScope,
  projectState: ProjectState | undefined,
  imageIds: Set<string>,
): void {
  if (!projectState) {
    return;
  }

  if (projectState.projectId !== scope.projectId) {
    throw new ScopedProjectContextError(
      `Project state projectId ${projectState.projectId} does not match scoped project ${scope.projectId}`,
    );
  }

  if (projectState.workspaceId !== scope.workspaceId) {
    throw new ScopedProjectContextError(
      `Project state workspaceId ${projectState.workspaceId} does not match scoped workspace ${scope.workspaceId}`,
    );
  }

  if (projectState.targetId !== scope.targetId) {
    throw new ScopedProjectContextError(
      `Project state targetId ${projectState.targetId} does not match scoped target ${scope.targetId}`,
    );
  }

  for (const image of projectState.images) {
    if (!imageIds.has(image.id)) {
      throw new ScopedProjectContextError(
        `State image ${image.id} is not declared in project config`,
      );
    }
  }
}

function scopedImageContext(
  scope: ScopedProjectContextScope,
  imageConfig: ProjectImageConfig,
  imageState: ProjectImageState | undefined,
): ScopedImageContext {
  const launcherImageName =
    imageState?.imageName ??
    renderProjectImageName(imageConfig.imageName, {
      projectId: scope.projectId,
      projectName: scope.projectName,
      workspaceId: scope.workspaceId,
      targetId: scope.targetId,
      imageId: imageConfig.id,
    });

  return {
    imageId: imageConfig.id,
    launcherImageName,
    active: imageConfig.active,
    status: imageStatus(imageState),
    ...(imageState?.assignedPort
      ? { assignedPort: imageState.assignedPort }
      : {}),
    ...(imageState?.pid ? { pid: imageState.pid } : {}),
    ownership: {
      projectId: scope.projectId,
      workspaceId: scope.workspaceId,
      targetId: scope.targetId,
      owned: true,
      disposable: true,
    },
    affordances: lifecycleAffordances(imageConfig, imageState),
    cleanup: {
      disposable: true,
      statePath: scope.statePath,
      launcherImageName,
      policy: "workspace_cleanup_only",
      paths: cleanupPaths(imageState),
    },
    route: routeMetadata(scope, imageConfig.id),
  };
}

export function buildScopedProjectContext(
  options: BuildScopedProjectContextOptions,
): ScopedProjectContext {
  const projectRoot = resolvePathLike(options.projectRoot);
  const projectConfig = options.projectConfig ?? loadProjectConfig(projectRoot);
  const workspaceId = options.workspaceId
    ? sanitizeRuntimeId(options.workspaceId)
    : defaultWorkspaceId(projectRoot);
  const targetId =
    options.targetId ??
    defaultTargetId(projectConfig.kanban.projectId, workspaceId);
  const stateRoot = options.stateRoot
    ? resolvePathLike(options.stateRoot)
    : undefined;
  const statePath = projectStatePathForConfig({
    projectRoot,
    config: projectConfig,
    workspaceId,
    stateRoot,
  });
  const projectState = options.projectState ?? loadProjectState(statePath);
  const scope: ScopedProjectContextScope = {
    projectRoot,
    projectId: projectConfig.kanban.projectId,
    projectName: projectConfig.name,
    workspaceId,
    targetId,
    ...(stateRoot ? { stateRoot } : {}),
    statePath,
  };
  const configuredImageIds = new Set(
    projectConfig.images.map((image) => image.id),
  );

  validateProjectState(scope, projectState, configuredImageIds);

  return {
    schemaVersion: 1,
    scope,
    images: projectConfig.images.map((imageConfig) =>
      scopedImageContext(
        scope,
        imageConfig,
        projectState?.images.find((image) => image.id === imageConfig.id),
      ),
    ),
  };
}
