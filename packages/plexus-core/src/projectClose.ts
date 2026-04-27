import path from "node:path";
import { loadProjectConfig } from "./projectConfig.js";
import {
  createStdioPharoLauncherMcpClient,
  type PharoLauncherMcpToolClient,
} from "./pharoLauncherMcpClient.js";
import {
  defaultWorkspaceId,
  loadProjectState,
  projectStatePathForConfig,
  sanitizeRuntimeId,
  saveProjectState,
  type ProjectImageState,
  type ProjectState,
} from "./projectState.js";

interface LauncherCommandResult<T = unknown> {
  ok: boolean;
  data?: T;
}

export interface ProjectCloseOptions {
  projectRoot: string;
  stateRoot?: string;
  workspaceId?: string;
  pharoLauncherMcpClient?: PharoLauncherMcpToolClient;
  now?: () => Date;
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

function runningImages(state: ProjectState): ProjectImageState[] {
  return state.images.filter((image) => image.status === "running");
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

  if (!state) {
    return {
      ok: true,
      projectRoot,
      statePath,
      stoppedImages: [],
      failures: [],
    };
  }

  const client =
    options.pharoLauncherMcpClient ??
    (await createStdioPharoLauncherMcpClient());
  const ownsClient = !options.pharoLauncherMcpClient;
  const stoppedImages: ProjectImageState[] = [];
  const failures: ProjectCloseFailure[] = [];

  try {
    for (const imageState of runningImages(state)) {
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

    state.updatedAt = now().toISOString();
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
