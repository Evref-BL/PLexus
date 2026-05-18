import path from "node:path";
import {
  defaultImagePortClaimChecks,
  imagePortClaimsRootForConfig,
  releaseImagePortClaimIfOwned,
} from "./imagePortClaims.js";
import { loadProjectConfig } from "./projectConfig.js";
import {
  createStdioPharoLauncherMcpClient,
  type PharoLauncherMcpToolClient,
} from "./pharoLauncherMcpClient.js";
import { pharoLauncherMcpProfileEnvironment } from "./pharoLauncherProfile.js";
import {
  defaultWorkspaceId,
  loadProjectState,
  projectStateRootForConfig,
  projectStatePathForConfig,
  runtimeStatusForImages,
  sanitizeRuntimeId,
  saveProjectState,
  type ProjectImageState,
  type ProjectState,
} from "./projectState.js";
import type { PortClaimChecks } from "./portClaims.js";

interface LauncherCommandResult<T = unknown> {
  ok: boolean;
  data?: T;
}

export interface ProjectCloseOptions {
  projectRoot: string;
  stateRoot?: string;
  workspaceId?: string;
  imageIds?: string[];
  pharoLauncherMcpClient?: PharoLauncherMcpToolClient;
  now?: () => Date;
  portClaimChecks?: PortClaimChecks;
}

export interface ProjectCloseFailure {
  imageId: string;
  imageName: string;
  message: string;
}

export interface ProjectCloseResult {
  ok: boolean;
  projectRoot: string;
  statePath: string;
  state?: ProjectState;
  stoppedImages: ProjectImageState[];
  failures: ProjectCloseFailure[];
}

export class ProjectCloseError extends Error {
  constructor(
    message: string,
    public readonly result: ProjectCloseResult,
  ) {
    super(message);
    this.name = "ProjectCloseError";
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function imagesToClose(
  state: ProjectState,
  imageIds: string[] | undefined,
): ProjectImageState[] {
  return selectedImages(state, imageIds).filter(
    (image) => image.status === "running",
  );
}

function selectedImages(
  state: ProjectState,
  imageIds: string[] | undefined,
): ProjectImageState[] {
  const selectedIds = imageIds ? new Set(imageIds) : undefined;
  return state.images.filter((image) => !selectedIds || selectedIds.has(image.id));
}

function assertLauncherOk(
  result: LauncherCommandResult | undefined,
  toolName: string,
): void {
  if (result && result.ok === false) {
    throw new Error(`${toolName} returned ok: false`);
  }
}

export async function closeProject(
  options: ProjectCloseOptions,
): Promise<ProjectCloseResult> {
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
  const state = loadProjectState(statePath);
  const now = options.now ?? (() => new Date());
  const claimsRoot = imagePortClaimsRootForConfig(projectRoot, config);
  const portClaimChecks =
    options.portClaimChecks ?? defaultImagePortClaimChecks();

  if (!state) {
    return {
      ok: true,
      projectRoot,
      statePath,
      stoppedImages: [],
      failures: [],
    };
  }

  const selected = selectedImages(state, options.imageIds);
  const images = imagesToClose(state, options.imageIds);
  const stoppedImages: ProjectImageState[] = [];
  const failures: ProjectCloseFailure[] = [];

  if (images.length === 0) {
    if (claimsRoot) {
      for (const imageState of selected) {
        try {
          await releaseImagePortClaimIfOwned({
            state,
            image: imageState,
            claimsRoot,
            checks: portClaimChecks,
          });
        } catch (error) {
          failures.push({
            imageId: imageState.id,
            imageName: imageState.imageName,
            message: errorMessage(error),
          });
        }
      }
    }

    state.updatedAt = now().toISOString();
    state.runtimeStatus = runtimeStatusForImages(state.images);
    saveProjectState(statePath, state);

    const result: ProjectCloseResult = {
      ok: failures.length === 0,
      projectRoot,
      statePath,
      state,
      stoppedImages: [],
      failures,
    };

    if (!result.ok) {
      throw new ProjectCloseError(
        "One or more project images failed to close",
        result,
      );
    }

    return result;
  }

  const client =
    options.pharoLauncherMcpClient ??
    (await createStdioPharoLauncherMcpClient(undefined, {
      profileEnvironment: pharoLauncherMcpProfileEnvironment({
        projectRoot,
        config,
        workspaceId,
        targetId: state.targetId,
        stateRoot: projectStateRootForConfig(config, options.stateRoot),
      }),
    }));
  const ownsClient = !options.pharoLauncherMcpClient;

  try {
    for (const imageState of images) {
      try {
        const killResult = await client.callTool<LauncherCommandResult>(
          "pharo_launcher_process_kill",
          {
            imageName: imageState.imageName,
            confirm: true,
          },
        );
        assertLauncherOk(killResult, "pharo_launcher_process_kill");

        imageState.status = "stopped";
        delete imageState.pid;
        stoppedImages.push({ ...imageState });
      } catch (error) {
        failures.push({
          imageId: imageState.id,
          imageName: imageState.imageName,
          message: errorMessage(error),
        });
      }
    }

    if (claimsRoot) {
      for (const imageState of selected.filter(
        (image) => image.status !== "running",
      )) {
        try {
          await releaseImagePortClaimIfOwned({
            state,
            image: imageState,
            claimsRoot,
            checks: portClaimChecks,
          });
        } catch (error) {
          failures.push({
            imageId: imageState.id,
            imageName: imageState.imageName,
            message: errorMessage(error),
          });
        }
      }
    }

    state.updatedAt = now().toISOString();
    state.runtimeStatus = runtimeStatusForImages(state.images);
    saveProjectState(statePath, state);

    const result: ProjectCloseResult = {
      ok: failures.length === 0,
      projectRoot,
      statePath,
      state,
      stoppedImages,
      failures,
    };

    if (!result.ok) {
      throw new ProjectCloseError(
        "One or more project images failed to close",
        result,
      );
    }

    return result;
  } finally {
    if (ownsClient) {
      await client.close?.();
    }
  }
}
