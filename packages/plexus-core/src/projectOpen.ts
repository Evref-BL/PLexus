import path from "node:path";
import { loadProjectConfig } from "./projectConfig.js";
import { createStdioMcpPlClient, type McpPlToolClient } from "./mcpPlClient.js";
import {
  HttpPharoMcpHealthClient,
  type PharoMcpHealthClient,
} from "./pharoMcpHealth.js";
import {
  collectReservedProjectPorts,
  createProjectState,
  defaultWorkspaceId,
  loadProjectState,
  projectStatePathForConfig,
  sanitizeRuntimeId,
  saveProjectState,
  type ProjectImageState,
  type ProjectPortRange,
  type ProjectState,
} from "./projectState.js";
import { writeProjectImageStartupScript } from "./projectStartupScript.js";

export interface LauncherCommandResult<T = unknown> {
  ok: boolean;
  data?: T;
}

export interface LauncherProcess {
  pid: number;
  imageName?: string;
  imagePath?: string;
  commandLine: string;
}

export interface ProjectOpenPollOptions {
  intervalMs?: number;
  processTimeoutMs?: number;
  healthTimeoutMs?: number;
}

export interface ProjectOpenOptions {
  projectRoot: string;
  stateRoot?: string;
  workspaceId?: string;
  targetId?: string;
  mcpPlClient?: McpPlToolClient;
  healthClient?: PharoMcpHealthClient;
  portRange?: ProjectPortRange;
  now?: () => Date;
  poll?: ProjectOpenPollOptions;
  sleep?: (durationMs: number) => Promise<void>;
}

export interface ProjectOpenFailure {
  imageId: string;
  imageName: string;
  message: string;
}

export interface ProjectOpenResult {
  ok: boolean;
  projectRoot: string;
  statePath: string;
  state: ProjectState;
  failures: ProjectOpenFailure[];
}

export class ProjectOpenError extends Error {
  constructor(
    message: string,
    public readonly result: ProjectOpenResult,
  ) {
    super(message);
    this.name = "ProjectOpenError";
  }
}

function defaultSleep(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function processMatchesImage(
  process: LauncherProcess,
  imageName: string,
): boolean {
  return (
    process.imageName === imageName ||
    path.basename(process.imagePath ?? "", ".image") === imageName ||
    process.commandLine.includes(`${imageName}.image`) ||
    process.commandLine.includes(imageName)
  );
}

function launcherResultData<T>(result: LauncherCommandResult<T>): T | undefined {
  return result.ok ? result.data : undefined;
}

function assertLauncherOk(
  result: LauncherCommandResult | undefined,
  toolName: string,
): void {
  if (result && result.ok === false) {
    throw new Error(`${toolName} returned ok: false`);
  }
}

async function pollUntil<T>(
  timeoutMs: number,
  intervalMs: number,
  sleep: (durationMs: number) => Promise<void>,
  attempt: () => Promise<T | undefined>,
): Promise<T | undefined> {
  const startedAt = Date.now();

  while (Date.now() - startedAt <= timeoutMs) {
    const result = await attempt();
    if (result !== undefined) {
      return result;
    }

    await sleep(intervalMs);
  }

  return undefined;
}

async function pollProcessForImage(
  client: McpPlToolClient,
  imageName: string,
  timeoutMs: number,
  intervalMs: number,
  sleep: (durationMs: number) => Promise<void>,
): Promise<LauncherProcess | undefined> {
  return pollUntil(timeoutMs, intervalMs, sleep, async () => {
    const result = await client.callTool<LauncherCommandResult<LauncherProcess[]>>(
      "pharo_launcher_process_list",
      {},
    );
    assertLauncherOk(result, "pharo_launcher_process_list");
    const processes = launcherResultData(result) ?? [];

    return processes.find((process) => processMatchesImage(process, imageName));
  });
}

async function pollHealth(
  healthClient: PharoMcpHealthClient,
  port: number,
  timeoutMs: number,
  intervalMs: number,
  sleep: (durationMs: number) => Promise<void>,
): Promise<boolean> {
  const result = await pollUntil(timeoutMs, intervalMs, sleep, async () =>
    (await healthClient.check(port)) ? true : undefined,
  );

  return result === true;
}

function activeStateImages(state: ProjectState): ProjectImageState[] {
  return state.images.filter((image) => image.status === "starting");
}

export async function openProject(
  options: ProjectOpenOptions,
): Promise<ProjectOpenResult> {
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
  const previousState = loadProjectState(statePath);
  const now = options.now ?? (() => new Date());
  const reservedPorts = collectReservedProjectPorts({
    projectRoot,
    projectId: config.kanban.projectId,
    stateRoot: options.stateRoot,
    excludeWorkspaceId: workspaceId,
  });
  const state = createProjectState(config, {
    updatedAt: now().toISOString(),
    previousState,
    workspaceId,
    targetId: options.targetId,
    reservedPorts,
    ...(options.portRange ? { portRange: options.portRange } : {}),
  });
  const client = options.mcpPlClient ?? (await createStdioMcpPlClient());
  const ownsClient = !options.mcpPlClient;
  const healthClient =
    options.healthClient ?? new HttpPharoMcpHealthClient();
  const poll = {
    intervalMs: options.poll?.intervalMs ?? 500,
    processTimeoutMs: options.poll?.processTimeoutMs ?? 30_000,
    healthTimeoutMs: options.poll?.healthTimeoutMs ?? 60_000,
  };
  const sleep = options.sleep ?? defaultSleep;
  const failures: ProjectOpenFailure[] = [];

  try {
    for (const imageState of activeStateImages(state)) {
      const imageConfig = config.images.find((image) => image.id === imageState.id);
      if (!imageConfig) {
        continue;
      }

      try {
        const startupScript = writeProjectImageStartupScript({
          projectRoot,
          config,
          imageId: imageState.id,
          imageState,
          workspaceId,
          stateRoot: options.stateRoot,
        });

        const launchResult = await client.callTool<LauncherCommandResult>(
          "pharo_launcher_image_launch",
          {
            imageName: imageState.imageName,
            detached: true,
            script: startupScript.filePath,
          },
        );
        assertLauncherOk(launchResult, "pharo_launcher_image_launch");

        const process = await pollProcessForImage(
          client,
          imageState.imageName,
          poll.processTimeoutMs,
          poll.intervalMs,
          sleep,
        );
        if (process) {
          imageState.pid = process.pid;
        } else {
          throw new Error(
            `Timed out waiting for PharoLauncher process for image ${imageState.imageName}`,
          );
        }

        const healthy = await pollHealth(
          healthClient,
          imageState.assignedPort,
          poll.healthTimeoutMs,
          poll.intervalMs,
          sleep,
        );
        if (!healthy) {
          throw new Error(
            `Timed out waiting for Pharo MCP health on port ${imageState.assignedPort}`,
          );
        }

        imageState.status = "running";
      } catch (error) {
        imageState.status = "failed";
        failures.push({
          imageId: imageState.id,
          imageName: imageState.imageName,
          message: errorMessage(error),
        });
      }
    }

    state.updatedAt = now().toISOString();
    saveProjectState(statePath, state);

    const result: ProjectOpenResult = {
      ok: failures.length === 0,
      projectRoot,
      statePath,
      state,
      failures,
    };

    if (!result.ok) {
      throw new ProjectOpenError("One or more project images failed to open", result);
    }

    return result;
  } finally {
    if (ownsClient) {
      await client.close?.();
    }
  }
}
