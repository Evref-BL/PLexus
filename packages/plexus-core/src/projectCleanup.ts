import fs from "node:fs";
import path from "node:path";
import {
  defaultImagePortClaimChecks,
  imagePortClaimsRootForConfig,
} from "./imagePortClaims.js";
import {
  createStdioPharoLauncherMcpClient,
  type PharoLauncherMcpToolClient,
} from "./pharoLauncherMcpClient.js";
import { pharoLauncherMcpProfileEnvironment } from "./pharoLauncherProfile.js";
import {
  imageMcpEndpointHandoffPath,
} from "./projectImageMcpEndpoint.js";
import {
  loadProjectConfig,
} from "./projectConfig.js";
import {
  closeProject,
  ProjectCloseError,
  type ProjectCloseResult,
} from "./projectClose.js";
import {
  closeProjectGateway,
  type ProjectGatewayRuntimeOptions,
} from "./projectGateway.js";
import type { PortClaimChecks } from "./portClaims.js";
import {
  defaultPlexusStateRoot,
  defaultWorkspaceId,
  loadProjectState,
  projectImageRepositoryWorkspaces,
  projectStatePathForConfig,
  projectStateRootForConfig,
  runtimeStatusForImages,
  sanitizeRuntimeId,
  saveProjectState,
  type ProjectImageRepositoryWorkspaceCleanupPolicy,
  type ProjectImageRepositoryWorkspaceCleanupRecord,
  type ProjectImageState,
  type ProjectState,
} from "./projectState.js";

interface LauncherCommandResult {
  ok: boolean;
}

export type ProjectCleanupResourceKind =
  | "state-file"
  | "image-process"
  | "launcher-image"
  | "image-port-claim"
  | "endpoint-handoff"
  | "gateway"
  | "gateway-port-claim"
  | "repository-workspace"
  | "route";

export type ProjectCleanupResourceStatus =
  | "planned"
  | "cleaned"
  | "skipped"
  | "failed";

export interface ProjectCleanupResource {
  kind: ProjectCleanupResourceKind;
  status: ProjectCleanupResourceStatus;
  id: string;
  projectId: string;
  workspaceId: string;
  targetId: string;
  imageId?: string;
  imageName?: string;
  path?: string;
  port?: number;
  pid?: number;
  reason?: string;
}

export interface ProjectCleanupFailure {
  kind: ProjectCleanupResourceKind;
  id: string;
  imageId?: string;
  imageName?: string;
  message: string;
}

export interface ProjectCleanupOptions {
  projectRoot: string;
  stateRoot?: string;
  workspaceId?: string;
  confirm?: boolean;
  deleteStateFile?: boolean;
  deleteLauncherImages?: boolean;
  repositoryWorkspaceCleanupPolicy?: ProjectImageRepositoryWorkspaceCleanupPolicy;
  repositoryWorkspaceArchiveRoot?: string;
  pharoLauncherMcpClient?: PharoLauncherMcpToolClient;
  portClaimChecks?: PortClaimChecks;
  gateway?: ProjectGatewayRuntimeOptions;
  now?: () => Date;
}

export interface ProjectCleanupResult {
  ok: boolean;
  projectRoot: string;
  stateRoot: string;
  statePath: string;
  confirmed: boolean;
  deleteStateFile: boolean;
  deleteLauncherImages: boolean;
  state?: ProjectState;
  resources: ProjectCleanupResource[];
  failures: ProjectCleanupFailure[];
  stoppedImages: ProjectImageState[];
  repositoryWorkspaceCleanups: ProjectImageRepositoryWorkspaceCleanupRecord[];
  deletedLauncherImages: string[];
  gatewayClosed: boolean;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function projectStateRoot(
  config: ReturnType<typeof loadProjectConfig>,
  stateRoot: string | undefined,
  projectRoot: string,
): string {
  return projectStateRootForConfig(config, stateRoot) ?? defaultPlexusStateRoot(projectRoot);
}

function resourceBase(state: ProjectState): Pick<
  ProjectCleanupResource,
  "projectId" | "workspaceId" | "targetId" | "status"
> {
  return {
    projectId: state.projectId,
    workspaceId: state.workspaceId,
    targetId: state.targetId,
    status: "planned",
  };
}

function endpointHandoffPath(input: {
  projectRoot: string;
  stateRoot: string;
  state: ProjectState;
  image: ProjectImageState;
}): string {
  return imageMcpEndpointHandoffPath({
    projectRoot: input.projectRoot,
    projectId: input.state.projectId,
    workspaceId: input.state.workspaceId,
    stateRoot: input.stateRoot,
    imageId: input.image.id,
  });
}

interface CleanupResourcesInput {
  projectRoot: string;
  stateRoot: string;
  statePath: string;
  state: ProjectState;
  imageClaimsRoot?: string;
}

function imageCleanupResources(
  input: CleanupResourcesInput,
  image: ProjectImageState,
): ProjectCleanupResource[] {
  const resources: ProjectCleanupResource[] = [
  ];

  if (image.status === "running" || image.pid !== undefined) {
    resources.push({
      ...resourceBase(input.state),
      kind: "image-process",
      id: image.id,
      imageId: image.id,
      imageName: image.imageName,
      ...(image.pid !== undefined ? { pid: image.pid } : {}),
    });
  }

  if (image.creation) {
    resources.push({
      ...resourceBase(input.state),
      kind: "launcher-image",
      id: image.imageName,
      imageId: image.id,
      imageName: image.imageName,
      reason: "Image has PLexus creation ownership metadata.",
    });
  }

  if (input.imageClaimsRoot && image.assignedPort !== undefined) {
    resources.push({
      ...resourceBase(input.state),
      kind: "image-port-claim",
      id: `${input.imageClaimsRoot}:${image.assignedPort}`,
      imageId: image.id,
      imageName: image.imageName,
      path: input.imageClaimsRoot,
      port: image.assignedPort,
    });
  }

  const handoffPath = endpointHandoffPath({
    projectRoot: input.projectRoot,
    stateRoot: input.stateRoot,
    state: input.state,
    image,
  });
  if (image.mcpEndpoint || fs.existsSync(handoffPath)) {
    resources.push({
      ...resourceBase(input.state),
      kind: "endpoint-handoff",
      id: handoffPath,
      imageId: image.id,
      imageName: image.imageName,
      path: handoffPath,
    });
  }

  for (const workspace of projectImageRepositoryWorkspaces(image)) {
    resources.push({
      ...resourceBase(input.state),
      kind: "repository-workspace",
      id: `${image.id}:${workspace.repository.id}`,
      imageId: image.id,
      imageName: image.imageName,
      path: workspace.path,
    });
  }

  return resources;
}

function gatewayCleanupResources(
  state: ProjectState,
): ProjectCleanupResource[] {
  const resources: ProjectCleanupResource[] = [];
  if (state.gateway?.managedByProject) {
    resources.push({
      ...resourceBase(state),
      kind: "gateway",
      id: state.gateway.endpoint ?? state.gateway.controlEndpoint ?? "gateway",
      ...(state.gateway.port !== undefined ? { port: state.gateway.port } : {}),
      ...(state.gateway.pid !== undefined ? { pid: state.gateway.pid } : {}),
    });
  }

  if (state.gateway?.managedByProject && state.gateway.claim) {
    resources.push({
      ...resourceBase(state),
      kind: "gateway-port-claim",
      id: `${state.gateway.claim.claimsRoot}:${state.gateway.claim.assignedPort}`,
      path: state.gateway.claim.claimsRoot,
      port: state.gateway.claim.assignedPort,
    });
  }

  return resources;
}

function cleanupResources(input: CleanupResourcesInput): ProjectCleanupResource[] {
  const resources: ProjectCleanupResource[] = [
    {
      ...resourceBase(input.state),
      kind: "state-file",
      id: input.statePath,
      path: input.statePath,
    },
  ];

  for (const image of input.state.images) {
    resources.push(...imageCleanupResources(input, image));
  }

  resources.push(...gatewayCleanupResources(input.state));
  return resources;
}

function markResources(
  resources: ProjectCleanupResource[],
  kind: ProjectCleanupResourceKind,
  status: ProjectCleanupResourceStatus,
  predicate: (resource: ProjectCleanupResource) => boolean = () => true,
  reason?: string,
): void {
  for (const resource of resources) {
    if (resource.kind === kind && predicate(resource)) {
      resource.status = status;
      if (reason) {
        resource.reason = reason;
      }
    }
  }
}

function addFailure(
  failures: ProjectCleanupFailure[],
  resource: ProjectCleanupResource,
  message: string,
): void {
  failures.push({
    kind: resource.kind,
    id: resource.id,
    ...(resource.imageId ? { imageId: resource.imageId } : {}),
    ...(resource.imageName ? { imageName: resource.imageName } : {}),
    message,
  });
  resource.status = "failed";
  resource.reason = message;
}

function ownedLauncherImages(state: ProjectState): ProjectImageState[] {
  return state.images.filter((image) => image.creation !== undefined);
}

async function launcherClientForCleanup(input: {
  projectRoot: string;
  config: ReturnType<typeof loadProjectConfig>;
  state: ProjectState;
  stateRoot: string;
  provided?: PharoLauncherMcpToolClient;
}): Promise<{ client: PharoLauncherMcpToolClient; ownsClient: boolean }> {
  if (input.provided) {
    return { client: input.provided, ownsClient: false };
  }

  return {
    client: await createStdioPharoLauncherMcpClient(undefined, {
      profileEnvironment: pharoLauncherMcpProfileEnvironment({
        projectRoot: input.projectRoot,
        config: input.config,
        workspaceId: input.state.workspaceId,
        targetId: input.state.targetId,
        stateRoot: input.stateRoot,
      }),
    }),
    ownsClient: true,
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

function stateWithoutDeletedLauncherImages(
  state: ProjectState,
  deletedImages: Set<string>,
  now: () => Date,
): ProjectState {
  return {
    ...state,
    images: state.images.filter((image) => !deletedImages.has(image.id)),
    runtimeStatus: runtimeStatusForImages(
      state.images.filter((image) => !deletedImages.has(image.id)),
    ),
    updatedAt: now().toISOString(),
  };
}

function markRepositoryWorkspaceCleanupResources(
  resources: ProjectCleanupResource[],
  records: ProjectImageRepositoryWorkspaceCleanupRecord[],
): void {
  for (const record of records) {
    markResources(
      resources,
      "repository-workspace",
      record.decision === "deleted" || record.decision === "archived"
        ? "cleaned"
        : "skipped",
      (resource) => resource.id === `${record.imageId}:${record.repositoryId}`,
      record.message ?? `Repository workspace cleanup decision: ${record.decision}`,
    );
  }
}

function recordProjectCloseResult(options: {
  closeResult: ProjectCloseResult;
  resources: ProjectCleanupResource[];
  stoppedImages: ProjectImageState[];
  repositoryWorkspaceCleanups: ProjectImageRepositoryWorkspaceCleanupRecord[];
}): ProjectState | undefined {
  options.stoppedImages.push(...options.closeResult.stoppedImages);
  options.repositoryWorkspaceCleanups.push(
    ...options.closeResult.repositoryWorkspaceCleanups,
  );
  markRepositoryWorkspaceCleanupResources(
    options.resources,
    options.closeResult.repositoryWorkspaceCleanups,
  );
  return options.closeResult.state;
}

function recordProjectCloseError(options: {
  error: ProjectCloseError;
  resources: ProjectCleanupResource[];
  failures: ProjectCleanupFailure[];
  stoppedImages: ProjectImageState[];
  repositoryWorkspaceCleanups: ProjectImageRepositoryWorkspaceCleanupRecord[];
}): ProjectState | undefined {
  const closeResult = options.error.result;
  const latestState = recordProjectCloseResult({
    closeResult,
    resources: options.resources,
    stoppedImages: options.stoppedImages,
    repositoryWorkspaceCleanups: options.repositoryWorkspaceCleanups,
  });

  for (const failure of closeResult.failures) {
    options.failures.push({
      kind: "image-process",
      id: failure.imageId,
      imageId: failure.imageId,
      imageName: failure.imageName,
      message: failure.message,
    });
  }

  return latestState;
}

async function closeProjectForCleanup(options: {
  projectRoot: string;
  stateRoot: string;
  statePath: string;
  workspaceId: string;
  pharoLauncherMcpClient?: PharoLauncherMcpToolClient;
  checks: PortClaimChecks;
  repositoryWorkspaceCleanupPolicy?: ProjectImageRepositoryWorkspaceCleanupPolicy;
  repositoryWorkspaceArchiveRoot?: string;
  resources: ProjectCleanupResource[];
  failures: ProjectCleanupFailure[];
  stoppedImages: ProjectImageState[];
  repositoryWorkspaceCleanups: ProjectImageRepositoryWorkspaceCleanupRecord[];
}): Promise<ProjectState | undefined> {
  try {
    const closeResult = await closeProject({
      projectRoot: options.projectRoot,
      stateRoot: options.stateRoot,
      workspaceId: options.workspaceId,
      pharoLauncherMcpClient: options.pharoLauncherMcpClient,
      portClaimChecks: options.checks,
      repositoryWorkspaceCleanupPolicy:
        options.repositoryWorkspaceCleanupPolicy ?? "preserve",
      ...(options.repositoryWorkspaceArchiveRoot
        ? { repositoryWorkspaceArchiveRoot: options.repositoryWorkspaceArchiveRoot }
        : {}),
    });

    return recordProjectCloseResult({
      closeResult,
      resources: options.resources,
      stoppedImages: options.stoppedImages,
      repositoryWorkspaceCleanups: options.repositoryWorkspaceCleanups,
    });
  } catch (error) {
    if (error instanceof ProjectCloseError) {
      return recordProjectCloseError({
        error,
        resources: options.resources,
        failures: options.failures,
        stoppedImages: options.stoppedImages,
        repositoryWorkspaceCleanups: options.repositoryWorkspaceCleanups,
      });
    }

    options.failures.push({
      kind: "state-file",
      id: options.statePath,
      message: errorMessage(error),
    });
    return undefined;
  }
}

async function closeManagedGatewayForCleanup(options: {
  latestState: ProjectState | undefined;
  statePath: string;
  gateway: ProjectCleanupOptions["gateway"];
  now: () => Date;
  resources: ProjectCleanupResource[];
  failures: ProjectCleanupFailure[];
}): Promise<{ latestState: ProjectState | undefined; gatewayClosed: boolean }> {
  if (!options.latestState?.gateway?.managedByProject) {
    return { latestState: options.latestState, gatewayClosed: false };
  }

  try {
    const gatewayResult = await closeProjectGateway({
      ...options.gateway,
      state: options.latestState,
    });
    markResources(options.resources, "gateway", "cleaned");
    options.latestState.updatedAt = options.now().toISOString();
    saveProjectState(options.statePath, options.latestState);
    return {
      latestState: options.latestState,
      gatewayClosed: gatewayResult.closed,
    };
  } catch (error) {
    const gatewayResources = options.resources.filter(
      (resource) => resource.kind === "gateway",
    );
    if (gatewayResources.length === 0) {
      options.failures.push({
        kind: "gateway",
        id: "gateway",
        message: errorMessage(error),
      });
    }
    for (const resource of gatewayResources) {
      addFailure(options.failures, resource, errorMessage(error));
    }
    return { latestState: options.latestState, gatewayClosed: false };
  }
}

async function deleteLauncherImagesForCleanup(options: {
  deleteLauncherImages: boolean;
  initialState: ProjectState;
  failedImageIds: Set<string>;
  projectRoot: string;
  config: ReturnType<typeof loadProjectConfig>;
  stateRoot: string;
  pharoLauncherMcpClient?: PharoLauncherMcpToolClient;
  resources: ProjectCleanupResource[];
  failures: ProjectCleanupFailure[];
  deletedLauncherImages: string[];
}): Promise<void> {
  if (!options.deleteLauncherImages) {
    markResources(
      options.resources,
      "launcher-image",
      "skipped",
      () => true,
      "deleteLauncherImages is false.",
    );
    return;
  }

  const imagesToDelete = ownedLauncherImages(options.initialState).filter(
    (image) => !options.failedImageIds.has(image.id),
  );
  if (imagesToDelete.length === 0) {
    return;
  }

  const { client, ownsClient } = await launcherClientForCleanup({
    projectRoot: options.projectRoot,
    config: options.config,
    state: options.initialState,
    stateRoot: options.stateRoot,
    provided: options.pharoLauncherMcpClient,
  });

  try {
    for (const image of imagesToDelete) {
      const resource = options.resources.find(
        (candidate) =>
          candidate.kind === "launcher-image" && candidate.imageId === image.id,
      );
      try {
        const deleteResult = await client.callTool<LauncherCommandResult>(
          "pharo_launcher_image_delete",
          {
            imageName: image.imageName,
            force: true,
            confirm: true,
          },
        );
        assertLauncherOk(deleteResult, "pharo_launcher_image_delete");
        options.deletedLauncherImages.push(image.imageName);
        if (resource) {
          resource.status = "cleaned";
        }
      } catch (error) {
        if (resource) {
          addFailure(options.failures, resource, errorMessage(error));
        }
        options.failures.push({
          kind: "launcher-image",
          id: image.imageName,
          imageId: image.id,
          imageName: image.imageName,
          message: errorMessage(error),
        });
      }
    }
  } finally {
    if (ownsClient) {
      await client.close?.();
    }
  }
}

function syncStateAfterLauncherImageDeletion(options: {
  statePath: string;
  latestState: ProjectState | undefined;
  initialState: ProjectState;
  deletedLauncherImages: string[];
  now: () => Date;
}): ProjectState | undefined {
  const latestState = loadProjectState(options.statePath) ?? options.latestState;
  if (!latestState || options.deletedLauncherImages.length === 0) {
    return latestState;
  }

  const deletedImageIds = new Set(
    ownedLauncherImages(options.initialState)
      .filter((image) =>
        options.deletedLauncherImages.includes(image.imageName),
      )
      .map((image) => image.id),
  );
  const updatedState = stateWithoutDeletedLauncherImages(
    latestState,
    deletedImageIds,
    options.now,
  );
  saveProjectState(options.statePath, updatedState);
  return updatedState;
}

function cleanupStateFileForCleanup(options: {
  deleteStateFile: boolean;
  statePath: string;
  resources: ProjectCleanupResource[];
  latestState: ProjectState | undefined;
}): ProjectState | undefined {
  if (options.deleteStateFile) {
    fs.rmSync(options.statePath, { force: true });
    markResources(options.resources, "state-file", "cleaned");
    return undefined;
  }

  markResources(
    options.resources,
    "state-file",
    "skipped",
    () => true,
    "deleteStateFile is false.",
  );
  return options.latestState;
}

export async function cleanupProjectOwnedResources(
  options: ProjectCleanupOptions,
): Promise<ProjectCleanupResult> {
  const projectRoot = path.resolve(options.projectRoot);
  const config = loadProjectConfig(projectRoot);
  const workspaceId = options.workspaceId
    ? sanitizeRuntimeId(options.workspaceId)
    : defaultWorkspaceId(projectRoot);
  const stateRoot = projectStateRoot(config, options.stateRoot, projectRoot);
  const statePath = projectStatePathForConfig({
    projectRoot,
    config,
    workspaceId,
    stateRoot,
  });
  const initialState = loadProjectState(statePath);
  const confirmed = options.confirm === true;
  const deleteStateFile = options.deleteStateFile === true;
  const deleteLauncherImages = options.deleteLauncherImages ?? true;
  const failures: ProjectCleanupFailure[] = [];
  const stoppedImages: ProjectImageState[] = [];
  const repositoryWorkspaceCleanups: ProjectImageRepositoryWorkspaceCleanupRecord[] = [];
  const deletedLauncherImages: string[] = [];
  let gatewayClosed = false;
  const imageClaimsRoot = imagePortClaimsRootForConfig(projectRoot, config);
  const resources = initialState
    ? cleanupResources({
        projectRoot,
        stateRoot,
        statePath,
        state: initialState,
        imageClaimsRoot,
      })
    : [];

  if (!initialState || !confirmed) {
    return {
      ok: true,
      projectRoot,
      stateRoot,
      statePath,
      confirmed,
      deleteStateFile,
      deleteLauncherImages,
      ...(initialState ? { state: initialState } : {}),
      resources,
      failures,
      stoppedImages,
      repositoryWorkspaceCleanups,
      deletedLauncherImages,
      gatewayClosed,
    };
  }

  const now = options.now ?? (() => new Date());
  const checks =
    options.portClaimChecks ?? options.gateway?.checks ?? defaultImagePortClaimChecks();
  let latestState: ProjectState | undefined = initialState;
  latestState =
    (await closeProjectForCleanup({
      projectRoot,
      stateRoot,
      statePath,
      workspaceId,
      pharoLauncherMcpClient: options.pharoLauncherMcpClient,
      checks,
      repositoryWorkspaceCleanupPolicy: options.repositoryWorkspaceCleanupPolicy,
      repositoryWorkspaceArchiveRoot: options.repositoryWorkspaceArchiveRoot,
      resources,
      failures,
      stoppedImages,
      repositoryWorkspaceCleanups,
    })) ?? latestState;

  const gatewayCleanup = await closeManagedGatewayForCleanup({
    latestState: latestState ?? loadProjectState(statePath),
    statePath,
    gateway: options.gateway,
    now,
    resources,
    failures,
  });
  latestState = gatewayCleanup.latestState;
  gatewayClosed = gatewayCleanup.gatewayClosed;

  const failedImageIds = new Set(
    failures
      .filter((failure) => failure.imageId)
      .map((failure) => failure.imageId as string),
  );
  await deleteLauncherImagesForCleanup({
    deleteLauncherImages,
    initialState,
    failedImageIds,
    projectRoot,
    config,
    stateRoot,
    pharoLauncherMcpClient: options.pharoLauncherMcpClient,
    resources,
    failures,
    deletedLauncherImages,
  });

  latestState = syncStateAfterLauncherImageDeletion({
    statePath,
    latestState,
    initialState,
    deletedLauncherImages,
    now,
  });
  latestState = cleanupStateFileForCleanup({
    deleteStateFile,
    statePath,
    resources,
    latestState,
  });

  return {
    ok: failures.length === 0,
    projectRoot,
    stateRoot,
    statePath,
    confirmed,
    deleteStateFile,
    deleteLauncherImages,
    ...(latestState ? { state: latestState } : {}),
    resources,
    failures,
    stoppedImages,
    repositoryWorkspaceCleanups,
    deletedLauncherImages,
    gatewayClosed,
  };
}
