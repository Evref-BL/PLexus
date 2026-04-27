import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PharoLauncherMcpToolClient } from "./pharoLauncherMcpClient.js";
import type { PharoMcpHealthClient } from "./pharoMcpHealth.js";
import {
  openProject,
  ProjectOpenError,
  type LauncherCommandResult,
  type LauncherProcess,
} from "./projectOpen.js";
import {
  loadProjectState,
  saveProjectState,
  type ProjectState,
} from "./projectState.js";

const tempDirs: string[] = [];
const fixedNow = () => new Date("2026-04-25T10:00:00.000Z");

interface ToolCall {
  name: string;
  argumentsValue: Record<string, unknown>;
}

class FakePharoLauncherMcpClient implements PharoLauncherMcpToolClient {
  readonly calls: ToolCall[] = [];

  constructor(
    private readonly processes: LauncherProcess[] = [],
    private readonly launchError?: Error,
  ) {}

  async callTool<T = unknown>(
    name: string,
    argumentsValue: Record<string, unknown> = {},
  ): Promise<T> {
    this.calls.push({ name, argumentsValue });

    if (name === "pharo_launcher_image_launch") {
      if (this.launchError) {
        throw this.launchError;
      }

      return { ok: true } as T;
    }

    if (name === "pharo_launcher_process_list") {
      const result = {
        ok: true,
        data: this.processes,
      } satisfies LauncherCommandResult<LauncherProcess[]>;

      return result as T;
    }

    throw new Error(`Unexpected tool call: ${name}`);
  }
}

class FakeHealthClient implements PharoMcpHealthClient {
  readonly ports: number[] = [];

  constructor(private readonly healthy: boolean) {}

  async check(port: number): Promise<boolean> {
    this.ports.push(port);
    return this.healthy;
  }
}

function makeTempDir(prefix: string): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(tempDir);
  return tempDir;
}

function writeProjectConfig(
  projectRoot: string,
  overrides: Record<string, unknown> = {},
): void {
  const config = {
    name: "my-project",
    kanban: {
      provider: "vibe-kanban",
      projectId: "project-123",
    },
    images: [
      {
        id: "dev",
        imageName: "MyProject-dev",
        active: true,
        mcp: {
          port: 7123,
          loadScript: "pharo/load-mcp.st",
        },
      },
      {
        id: "baseline",
        imageName: "MyProject-baseline",
        active: false,
        mcp: {
          loadScript: "pharo/load-mcp.st",
        },
      },
    ],
    ...overrides,
  };

  fs.writeFileSync(
    path.join(projectRoot, "plexus.project.json"),
    JSON.stringify(config, null, 2),
    "utf8",
  );
}

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("project open", () => {
  it("launches active images, polls process and health, and persists runtime state", async () => {
    const projectRoot = makeTempDir("plexus-project-");
    const stateRoot = makeTempDir("plexus-state-");
    writeProjectConfig(projectRoot);
    const pharoLauncherMcpClient = new FakePharoLauncherMcpClient([
      {
        pid: 1234,
        imageName: "MyProject-dev",
        commandLine: "PharoConsole.exe MyProject-dev.image",
      },
    ]);
    const healthClient = new FakeHealthClient(true);

    const result = await openProject({
      projectRoot,
      stateRoot,
      workspaceId: "worktree-a",
      pharoLauncherMcpClient,
      healthClient,
      now: fixedNow,
      sleep: async () => {},
      poll: {
        intervalMs: 0,
      },
    });

    const scriptPath = path.join(
      stateRoot,
      "projects",
      "project-123",
      "workspaces",
      "worktree-a",
      "scripts",
      "start-dev.st",
    );

    expect(result.ok).toBe(true);
    expect(pharoLauncherMcpClient.calls).toEqual([
      {
        name: "pharo_launcher_image_launch",
        argumentsValue: {
          imageName: "MyProject-dev",
          detached: true,
          script: scriptPath,
        },
      },
      {
        name: "pharo_launcher_process_list",
        argumentsValue: {},
      },
    ]);
    expect(healthClient.ports).toEqual([7123]);
    expect(fs.existsSync(scriptPath)).toBe(true);
    expect(loadProjectState(result.statePath)).toEqual({
      projectId: "project-123",
      projectName: "my-project",
      workspaceId: "worktree-a",
      targetId: "project-123--worktree-a",
      updatedAt: "2026-04-25T10:00:00.000Z",
      images: [
        {
          id: "dev",
          imageName: "MyProject-dev",
          assignedPort: 7123,
          pid: 1234,
          status: "running",
        },
        {
          id: "baseline",
          imageName: "MyProject-baseline",
          assignedPort: 7100,
          status: "stopped",
        },
      ],
    });
  });

  it("reuses previous runtime port allocations before launching", async () => {
    const projectRoot = makeTempDir("plexus-project-");
    const stateRoot = makeTempDir("plexus-state-");
    writeProjectConfig(projectRoot, {
      images: [
        {
          id: "dev",
          imageName: "MyProject-dev",
          active: true,
          mcp: {
            loadScript: "pharo/load-mcp.st",
          },
        },
      ],
    });
    const previousStatePath = path.join(
      stateRoot,
      "projects",
      "project-123",
      "workspaces",
      "worktree-a",
      "state.json",
    );
    const previousState: ProjectState = {
      projectId: "project-123",
      projectName: "my-project",
      workspaceId: "worktree-a",
      targetId: "project-123--worktree-a",
      updatedAt: "2026-04-25T09:00:00.000Z",
      images: [
        {
          id: "dev",
          imageName: "MyProject-dev",
          assignedPort: 7130,
          status: "stopped",
        },
      ],
    };
    saveProjectState(previousStatePath, previousState);

    const result = await openProject({
      projectRoot,
      stateRoot,
      workspaceId: "worktree-a",
      pharoLauncherMcpClient: new FakePharoLauncherMcpClient([
        {
          pid: 1234,
          imageName: "MyProject-dev",
          commandLine: "PharoConsole.exe MyProject-dev.image",
        },
      ]),
      healthClient: new FakeHealthClient(true),
      now: fixedNow,
      sleep: async () => {},
      poll: {
        intervalMs: 0,
      },
    });

    expect(result.state.images[0]).toEqual({
      id: "dev",
      imageName: "MyProject-dev",
      assignedPort: 7130,
      pid: 1234,
      status: "running",
    });
  });

  it("marks active images failed and still writes state when launch fails", async () => {
    const projectRoot = makeTempDir("plexus-project-");
    const stateRoot = makeTempDir("plexus-state-");
    writeProjectConfig(projectRoot);

    await expect(
      openProject({
        projectRoot,
        stateRoot,
        workspaceId: "worktree-a",
        pharoLauncherMcpClient: new FakePharoLauncherMcpClient([], new Error("launch failed")),
        healthClient: new FakeHealthClient(true),
        now: fixedNow,
        sleep: async () => {},
      }),
    ).rejects.toThrow(ProjectOpenError);

    const statePath = path.join(
      stateRoot,
      "projects",
      "project-123",
      "workspaces",
      "worktree-a",
      "state.json",
    );

    expect(loadProjectState(statePath)?.images).toEqual([
      {
        id: "dev",
        imageName: "MyProject-dev",
        assignedPort: 7123,
        status: "failed",
      },
      {
        id: "baseline",
        imageName: "MyProject-baseline",
        assignedPort: 7100,
        status: "stopped",
      },
    ]);
  });

  it("marks active images failed when the launched process is not visible", async () => {
    const projectRoot = makeTempDir("plexus-project-");
    const stateRoot = makeTempDir("plexus-state-");
    writeProjectConfig(projectRoot);

    await expect(
      openProject({
        projectRoot,
        stateRoot,
        workspaceId: "worktree-a",
        pharoLauncherMcpClient: new FakePharoLauncherMcpClient([]),
        healthClient: new FakeHealthClient(true),
        now: fixedNow,
        sleep: async () => {},
        poll: {
          intervalMs: 0,
          processTimeoutMs: 0,
        },
      }),
    ).rejects.toThrow(ProjectOpenError);

    expect(
      loadProjectState(
        path.join(
          stateRoot,
          "projects",
          "project-123",
          "workspaces",
          "worktree-a",
          "state.json",
        ),
      )?.images[0],
    ).toEqual({
      id: "dev",
      imageName: "MyProject-dev",
      assignedPort: 7123,
      status: "failed",
    });
  });
});
