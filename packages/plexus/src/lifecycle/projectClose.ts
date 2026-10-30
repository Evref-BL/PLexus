import path from "node:path";
import { loadProjectConfig } from "../config/projectConfig.js";
import {
  createStdioPharoLauncherMcpClient,
  type PharoLauncherMcpToolClient,
} from "../launcher/pharoLauncherMcpClient.js";
import {
  imageMcpEndpointHandoffPath,
  removeImageMcpEndpointHandoff,
} from "../gateway/projectImageMcpEndpoint.js";
import { pharoLauncherMcpProfileEnvironment } from "../launcher/pharoLauncherProfile.js";
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
} from "../workspace/projectState.js";

import { processesForImage } from "./projectOpen.js";

interface LauncherCommandResult<T = unknown> {
  ok: boolean;
  data?: T;
}

/**
 * The pid PLexus recorded when it launched this image, confirmed against the
 * host before we signal it. A recorded pid that no longer runs this image was
 * reused by something else, and killing it would be killing a stranger.
 */
async function ownedProcessPid(
  client: PharoLauncherMcpToolClient,
  imageState: ProjectImageState,
): Promise<number | undefined> {
  if (imageState.pid === undefined) {
    return undefined;
  }

  const processes = await processesForImage(client, imageState.imageName);

  return processes.some((process) => process.pid === imageState.pid)
    ? imageState.pid
    : undefined;
}

export interface ProjectCloseOptions {
  projectRoot: string;
  stateRoot?: string;
  workspaceId?: string;
  imageIds?: string[];
  pharoLauncherMcpClient?: PharoLauncherMcpToolClient;
  now?: () => Date;
  env?: NodeJS.ProcessEnv;
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

function clearImageEndpointRuntimeState(options: {
  projectRoot: string;
  projectId: string;
  workspaceId: string;
  stateRoot?: string;
  imageState: ProjectImageState;
}): void {
  removeImageMcpEndpointHandoff(
    imageMcpEndpointHandoffPath({
      projectRoot: options.projectRoot,
      projectId: options.projectId,
      workspaceId: options.workspaceId,
      stateRoot: options.stateRoot,
      imageId: options.imageState.id,
    }),
  );
  delete options.imageState.mcpServers;
}

type LoadedProjectCloseState = NonNullable<ProjectCloseResult["state"]>;

function addProjectCloseFailure(
  failures: ProjectCloseFailure[],
  imageState: ProjectImageState,
  error: unknown,
): void {
  failures.push({
    imageId: imageState.id,
    imageName: imageState.imageName,
    message: errorMessage(error),
  });
}

function clearImageEndpointRuntimeStates(options: {
  projectRoot: string;
  projectId: string;
  workspaceId: string;
  stateRoot: string | undefined;
  imageStates: ProjectImageState[];
}): void {
  for (const imageState of options.imageStates) {
    clearImageEndpointRuntimeState({
      projectRoot: options.projectRoot,
      projectId: options.projectId,
      workspaceId: options.workspaceId,
      stateRoot: options.stateRoot,
      imageState,
    });
  }
}

function finalizeProjectCloseResult(options: {
  projectRoot: string;
  statePath: string;
  state: LoadedProjectCloseState;
  stoppedImages: ProjectImageState[];
  failures: ProjectCloseFailure[];
  now: () => Date;
}): ProjectCloseResult {
  options.state.updatedAt = options.now().toISOString();
  options.state.runtimeStatus = runtimeStatusForImages(options.state.images);
  saveProjectState(options.statePath, options.state);

  const result: ProjectCloseResult = {
    ok: options.failures.length === 0,
    projectRoot: options.projectRoot,
    statePath: options.statePath,
    state: options.state,
    stoppedImages: options.stoppedImages,
    failures: options.failures,
  };
  if (!result.ok) {
    throw new ProjectCloseError(
      "One or more project images failed to close",
      result,
    );
  }

  return result;
}

async function stopProjectImages(options: {
  client: PharoLauncherMcpToolClient;
  projectRoot: string;
  state: LoadedProjectCloseState;
  workspaceId: string;
  stateRoot: string | undefined;
  images: ProjectImageState[];
  stoppedImages: ProjectImageState[];
  failures: ProjectCloseFailure[];
}): Promise<void> {
  for (const imageState of options.images) {
    try {
      // By pid, never by name: killing by name reaches every VM on the image,
      // including ones PLexus never started. We stop what we started.
      // Nothing of ours is running: the image is already stopped, so record
      // that and leave any stranger on the image alone.
      const pid = await ownedProcessPid(options.client, imageState);
      if (pid !== undefined) {
        const killResult = await options.client.callTool<LauncherCommandResult>(
          "pharo_launcher_process_kill",
          {
            pid,
            confirm: true,
          },
        );

        assertLauncherOk(killResult, "pharo_launcher_process_kill");
      }

      imageState.status = "stopped";
      delete imageState.pid;
      clearImageEndpointRuntimeState({
        projectRoot: options.projectRoot,
        projectId: options.state.projectId,
        workspaceId: options.workspaceId,
        stateRoot: options.stateRoot,
        imageState,
      });
      options.stoppedImages.push({ ...imageState });
    } catch (error) {
      addProjectCloseFailure(options.failures, imageState, error);
    }
  }
}

export interface StopProjectImageOptions
  extends Omit<ProjectCloseOptions, "imageIds"> {
  imageId: string;
}

/** Stop one image: the counterpart of `startProjectImage`. */
export async function stopProjectImage(
  options: StopProjectImageOptions,
): Promise<ProjectCloseResult> {
  const { imageId, ...rest } = options;
  return await closeProject({ ...rest, imageIds: [imageId] });
}

/**
 * @deprecated Use `stopProjectImage`; kept while `pharo-agent-plugin` imports
 * the plural form.
 */
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
  const resolvedStateRoot = projectStateRootForConfig(config, options.stateRoot);
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
    clearImageEndpointRuntimeStates({
      projectRoot,
      projectId: state.projectId,
      workspaceId,
      stateRoot: resolvedStateRoot,
      imageStates: selected,
    });
    return finalizeProjectCloseResult({
      projectRoot,
      statePath,
      state,
      stoppedImages: [],
      failures,
      now,
    });
  }

  const client =
    options.pharoLauncherMcpClient ??
    (await createStdioPharoLauncherMcpClient(undefined, {
      profileEnvironment: pharoLauncherMcpProfileEnvironment({
        projectRoot,
        config,
        workspaceId,
        stateRoot: resolvedStateRoot,
      }),
    }));
  const ownsClient = !options.pharoLauncherMcpClient;

  try {
    await stopProjectImages({
      client,
      projectRoot,
      state,
      workspaceId,
      stateRoot: resolvedStateRoot,
      images,
      stoppedImages,
      failures,
    });

    return finalizeProjectCloseResult({
      projectRoot,
      statePath,
      state,
      stoppedImages,
      failures,
      now,
    });
  } finally {
    if (ownsClient) {
      await client.close?.();
    }
  }
}
