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

function cleanupResources(input: {
  projectRoot: string;
  stateRoot: string;
  statePath: string;
  state: ProjectState;
  imageClaimsRoot?: string;
}): ProjectCleanupResource[] {
  const resources: ProjectCleanupResource[] = [
    {
      ...resourceBase(input.state),
      kind: "state-file",
      id: input.statePath,
      path: input.statePath,
    },
  ];

  for (const image of input.state.images) {
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

    if (image.repositoryWorkspace) {
      resources.push({
        ...resourceBase(input.state),
        kind: "repository-workspace",
        id: `${image.id}:${image.repositoryWorkspace.repository.id}`,
        imageId: image.id,
        imageName: image.imageName,
        path: image.repositoryWorkspace.path,
      });
    }
  }

  if (input.state.gateway?.managedByProject) {
    resources.push({
      ...resourceBase(input.state),
      kind: "gateway",
      id: input.state.gateway.endpoint ?? input.state.gateway.controlEndpoint ?? "gateway",
      ...(input.state.gateway.port !== undefined
        ? { port: input.state.gateway.port }
        : {}),
      ...(input.state.gateway.pid !== undefined ? { pid: input.state.gateway.pid } : {}),
    });
  }

  if (input.state.gateway?.managedByProject && input.state.gateway.claim) {
    resources.push({
      ...resourceBase(input.state),
      kind: "gateway-port-claim",
      id: `${input.state.gateway.claim.claimsRoot}:${input.state.gateway.claim.assignedPort}`,
      path: input.state.gateway.claim.claimsRoot,
      port: input.state.gateway.claim.assignedPort,
    });
  }

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
  const repositoryWorkspaceCleanups: ProjectImageRepositoryWorkspaceCleanupRecord[] =
    [];
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
    options.portClaimChecks ??
    options.gateway?.checks ??
    defaultImagePortClaimChecks();
  let latestState: ProjectState | undefined = initialState;
  let closeResult: ProjectCloseResult | undefined;

  try {
    closeResult = await closeProject({
      projectRoot,
      stateRoot,
      workspaceId,
      pharoLauncherMcpClient: options.pharoLauncherMcpClient,
      portClaimChecks: checks,
      repositoryWorkspaceCleanupPolicy:
        options.repositoryWorkspaceCleanupPolicy ?? "preserve",
      ...(options.repositoryWorkspaceArchiveRoot
        ? { repositoryWorkspaceArchiveRoot: options.repositoryWorkspaceArchiveRoot }
        : {}),
      now,
    });
    stoppedImages.push(...closeResult.stoppedImages);
    repositoryWorkspaceCleanups.push(...closeResult.repositoryWorkspaceCleanups);
    latestState = closeResult.state;
    markResources(resources, "image-process", "cleaned");
    markResources(resources, "image-port-claim", "cleaned");
    markResources(resources, "endpoint-handoff", "cleaned");
    for (const record of closeResult.repositoryWorkspaceCleanups) {
      markResources(
        resources,
        "repository-workspace",
        record.decision === "deleted" || record.decision === "archived"
          ? "cleaned"
          : "skipped",
        (resource) => resource.imageId === record.imageId,
        record.message ?? `Repository workspace cleanup decision: ${record.decision}`,
      );
    }
  } catch (error) {
    if (error instanceof ProjectCloseError) {
      closeResult = error.result;
      stoppedImages.push(...error.result.stoppedImages);
      repositoryWorkspaceCleanups.push(
        ...error.result.repositoryWorkspaceCleanups,
      );
      latestState = error.result.state;
      for (const failure of error.result.failures) {
        failures.push({
          kind: "image-process",
          id: failure.imageId,
          imageId: failure.imageId,
          imageName: failure.imageName,
          message: failure.message,
        });
      }
    } else {
      failures.push({
        kind: "state-file",
        id: statePath,
        message: errorMessage(error),
      });
    }
  }

  latestState = latestState ?? loadProjectState(statePath);
  if (latestState?.gateway?.managedByProject) {
    try {
      const gatewayResult = await closeProjectGateway({
        ...(options.gateway ?? {}),
        checks: options.gateway?.checks ?? checks,
        state: latestState,
      });
      gatewayClosed = gatewayResult.closed;
      markResources(resources, "gateway", "cleaned");
      markResources(
        resources,
        "gateway-port-claim",
        gatewayResult.releasedClaim ? "cleaned" : "skipped",
      );
      latestState.updatedAt = now().toISOString();
      saveProjectState(statePath, latestState);
    } catch (error) {
      const gatewayResources = resources.filter(
        (resource) => resource.kind === "gateway",
      );
      if (gatewayResources.length === 0) {
        failures.push({
          kind: "gateway",
          id: "gateway",
          message: errorMessage(error),
        });
      } else {
        for (const resource of gatewayResources) {
          addFailure(failures, resource, errorMessage(error));
        }
      }
    }
  }

  const failedImageIds = new Set(
    failures
      .filter((failure) => failure.imageId)
      .map((failure) => failure.imageId as string),
  );
  if (deleteLauncherImages) {
    const imagesToDelete = ownedLauncherImages(initialState).filter(
      (image) => !failedImageIds.has(image.id),
    );
    if (imagesToDelete.length > 0) {
      const { client, ownsClient } = await launcherClientForCleanup({
        projectRoot,
        config,
        state: initialState,
        stateRoot,
        provided: options.pharoLauncherMcpClient,
      });
      try {
        for (const image of imagesToDelete) {
          const resource = resources.find(
            (candidate) =>
              candidate.kind === "launcher-image" &&
              candidate.imageId === image.id,
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
            deletedLauncherImages.push(image.imageName);
            if (resource) {
              resource.status = "cleaned";
            }
          } catch (error) {
            if (resource) {
              addFailure(failures, resource, errorMessage(error));
            } else {
              failures.push({
                kind: "launcher-image",
                id: image.imageName,
                imageId: image.id,
                imageName: image.imageName,
                message: errorMessage(error),
              });
            }
          }
        }
      } finally {
        if (ownsClient) {
          await client.close?.();
        }
      }
    }
  } else {
    markResources(
      resources,
      "launcher-image",
      "skipped",
      () => true,
      "deleteLauncherImages is false.",
    );
  }

  latestState = loadProjectState(statePath) ?? latestState;
  if (latestState && deletedLauncherImages.length > 0) {
    const deletedImageIds = new Set(
      ownedLauncherImages(initialState)
        .filter((image) => deletedLauncherImages.includes(image.imageName))
        .map((image) => image.id),
    );
    latestState = stateWithoutDeletedLauncherImages(
      latestState,
      deletedImageIds,
      now,
    );
    saveProjectState(statePath, latestState);
  }

  if (deleteStateFile) {
    fs.rmSync(statePath, { force: true });
    markResources(resources, "state-file", "cleaned");
    latestState = undefined;
  } else {
    markResources(
      resources,
      "state-file",
      "skipped",
      () => true,
      "deleteStateFile is false.",
    );
  }

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
