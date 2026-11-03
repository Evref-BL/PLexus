import path from "node:path";
import { loadProjectConfig } from "../config/projectConfig.js";
import {
  openPharoLauncherClient,
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

import { processesForImage } from "./startProjectImage.js";

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

export interface StopProjectImageOptions {
  projectRoot: string;
  stateRoot?: string;
  workspaceId?: string;
  imageId: string;
  pharoLauncherMcpClient?: PharoLauncherMcpToolClient;
  now?: () => Date;
  env?: NodeJS.ProcessEnv;
}

export interface StopProjectImageFailure {
  imageId: string;
  imageName: string;
  message: string;
}

export interface StopProjectImageResult {
  ok: boolean;
  projectRoot: string;
  statePath: string;
  state?: ProjectState;
  stoppedImage?: ProjectImageState;
  failures: StopProjectImageFailure[];
}

export class StopProjectImageError extends Error {
  constructor(
    message: string,
    public readonly result: StopProjectImageResult,
  ) {
    super(message);
    this.name = "StopProjectImageError";
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Everything that might still be running. A start records the pid as soon as
 * the VM appears and only becomes "running" once its MCP answers, so an image
 * recorded "starting" or "failed" can have a live VM and a pid we wrote;
 * stopping only the ones recorded "running" left those behind, reported ok,
 * with nothing in PLexus able to stop them afterwards.
 *
 * What is stopped is still decided by the host: the kill goes by a pid
 * confirmed against the process list, so a stranger on the image is left
 * alone. An image recorded stopped with no pid is the one case nothing can be
 * running under, and it is skipped so an ordinary stop still costs no launcher
 * call.
 */
function imageToStop(
  state: ProjectState,
  imageId: string,
): ProjectImageState | undefined {
  const image = selectedImage(state, imageId);
  return image && (image.status !== "stopped" || image.pid !== undefined)
    ? image
    : undefined;
}

function selectedImage(
  state: ProjectState,
  imageId: string,
): ProjectImageState | undefined {
  return state.images.find((image) => image.id === imageId);
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

type LoadedStopProjectImageState = NonNullable<StopProjectImageResult["state"]>;

function addStopProjectImageFailure(
  failures: StopProjectImageFailure[],
  imageState: ProjectImageState,
  error: unknown,
): void {
  failures.push({
    imageId: imageState.id,
    imageName: imageState.imageName,
    message: errorMessage(error),
  });
}

function finalizeStopProjectImageResult(options: {
  projectRoot: string;
  statePath: string;
  state: LoadedStopProjectImageState;
  stoppedImage?: ProjectImageState;
  failures: StopProjectImageFailure[];
  now: () => Date;
}): StopProjectImageResult {
  options.state.updatedAt = options.now().toISOString();
  options.state.runtimeStatus = runtimeStatusForImages(options.state.images);
  saveProjectState(options.statePath, options.state);

  const result: StopProjectImageResult = {
    ok: options.failures.length === 0,
    projectRoot: options.projectRoot,
    statePath: options.statePath,
    state: options.state,
    ...(options.stoppedImage ? { stoppedImage: options.stoppedImage } : {}),
    failures: options.failures,
  };
  if (!result.ok) {
    // One image, so one failure: raise the message that says what went wrong.
    throw new StopProjectImageError(options.failures[0].message, result);
  }

  return result;
}

async function stopSelectedImage(options: {
  client: PharoLauncherMcpToolClient;
  projectRoot: string;
  state: LoadedStopProjectImageState;
  workspaceId: string;
  stateRoot: string | undefined;
  imageState: ProjectImageState;
  failures: StopProjectImageFailure[];
}): Promise<ProjectImageState | undefined> {
  const { imageState } = options;
  try {
    // By pid, never by name: killing by name reaches every VM on the image,
    // including ones PLexus never started. We stop what we started.
    // Nothing of ours is running: the image is already stopped, so record
    // that and leave any stranger on the image alone.
    const pid = await ownedProcessPid(options.client, imageState);
    if (pid !== undefined) {
      const killResult = await options.client.callTool(
        "pharo_launcher_process_kill",
        { pid },
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
    return { ...imageState };
  } catch (error) {
    addStopProjectImageFailure(options.failures, imageState, error);
    return undefined;
  }
}

/** Stop one image: the counterpart of `startProjectImage`. */
export async function stopProjectImage(
  options: StopProjectImageOptions,
): Promise<StopProjectImageResult> {
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
      failures: [],
    };
  }

  const selected = selectedImage(state, options.imageId);
  const imageState = imageToStop(state, options.imageId);
  const failures: StopProjectImageFailure[] = [];

  // Nothing of ours can be running under it, so there is no process to stop.
  // The endpoint record is still ours to clear.
  if (!imageState) {
    if (selected) {
      clearImageEndpointRuntimeState({
        projectRoot,
        projectId: state.projectId,
        workspaceId,
        stateRoot: resolvedStateRoot,
        imageState: selected,
      });
    }
    return finalizeStopProjectImageResult({
      projectRoot,
      statePath,
      state,
      failures,
      now,
    });
  }

  const client =
    options.pharoLauncherMcpClient ??
    openPharoLauncherClient({
      profileEnvironment: pharoLauncherMcpProfileEnvironment({
        projectRoot,
        config,
        workspaceId,
        stateRoot: resolvedStateRoot,
      }),
    });
  const ownsClient = !options.pharoLauncherMcpClient;

  try {
    const stoppedImage = await stopSelectedImage({
      client,
      projectRoot,
      state,
      workspaceId,
      stateRoot: resolvedStateRoot,
      imageState,
      failures,
    });

    return finalizeStopProjectImageResult({
      projectRoot,
      statePath,
      state,
      stoppedImage,
      failures,
      now,
    });
  } finally {
    if (ownsClient) {
      await client.close?.();
    }
  }
}
