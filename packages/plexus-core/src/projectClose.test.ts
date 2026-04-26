import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { McpPlToolClient } from "./mcpPlClient.js";
import { closeProject, ProjectCloseError } from "./projectClose.js";
import {
  loadProjectState,
  saveProjectState,
  type ProjectState,
} from "./projectState.js";

interface LauncherCommandResult<T = unknown> {
  ok: boolean;
  data?: T;
}

const tempDirs: string[] = [];
const fixedNow = () => new Date("2026-04-25T11:00:00.000Z");

interface ToolCall {
  name: string;
  argumentsValue: Record<string, unknown>;
}

class FakeMcpPlClient implements McpPlToolClient {
  readonly calls: ToolCall[] = [];

  constructor(private readonly killError?: Error) {}

  async callTool<T = unknown>(
    name: string,
    argumentsValue: Record<string, unknown> = {},
  ): Promise<T> {
    this.calls.push({ name, argumentsValue });

    if (name !== "pharo_launcher_process_kill") {
      throw new Error(`Unexpected tool call: ${name}`);
    }

    if (this.killError) {
      throw this.killError;
    }

    const result = { ok: true } satisfies LauncherCommandResult;
    return result as T;
  }
}

function makeTempDir(prefix: string): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(tempDir);
  return tempDir;
}

function writeProjectConfig(projectRoot: string): void {
  fs.writeFileSync(
    path.join(projectRoot, "plexus.project.json"),
    JSON.stringify(
      {
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
              port: 7124,
              loadScript: "pharo/load-mcp.st",
            },
          },
        ],
      },
      null,
      2,
    ),
    "utf8",
  );
}

function statePath(stateRoot: string): string {
  return path.join(
    stateRoot,
    "projects",
    "project-123",
    "workspaces",
    "worktree-a",
    "state.json",
  );
}

function writeRuntimeState(stateRoot: string, state: ProjectState): void {
  saveProjectState(statePath(stateRoot), state);
}

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("project close", () => {
  it("kills running images and marks them stopped", async () => {
    const projectRoot = makeTempDir("plexus-project-");
    const stateRoot = makeTempDir("plexus-state-");
    writeProjectConfig(projectRoot);
    writeRuntimeState(stateRoot, {
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
          assignedPort: 7124,
          status: "stopped",
        },
      ],
    });
    const mcpPlClient = new FakeMcpPlClient();

    const result = await closeProject({
      projectRoot,
      stateRoot,
      workspaceId: "worktree-a",
      mcpPlClient,
      now: fixedNow,
    });

    expect(result.ok).toBe(true);
    expect(mcpPlClient.calls).toEqual([
      {
        name: "pharo_launcher_process_kill",
        argumentsValue: {
          imageName: "MyProject-dev",
          confirm: true,
        },
      },
    ]);
    expect(loadProjectState(result.statePath)?.images).toEqual([
      {
        id: "dev",
        imageName: "MyProject-dev",
        assignedPort: 7123,
        status: "stopped",
      },
      {
        id: "baseline",
        imageName: "MyProject-baseline",
        assignedPort: 7124,
        status: "stopped",
      },
    ]);
  });

  it("does nothing when runtime state does not exist", async () => {
    const projectRoot = makeTempDir("plexus-project-");
    const stateRoot = makeTempDir("plexus-state-");
    writeProjectConfig(projectRoot);
    const mcpPlClient = new FakeMcpPlClient();

    const result = await closeProject({
      projectRoot,
      stateRoot,
      workspaceId: "worktree-a",
      mcpPlClient,
      now: fixedNow,
    });

    expect(result.ok).toBe(true);
    expect(result.state).toBeUndefined();
    expect(result.stoppedImages).toEqual([]);
    expect(mcpPlClient.calls).toEqual([]);
    expect(fs.existsSync(result.statePath)).toBe(false);
  });

  it("persists state and reports failures when a kill fails", async () => {
    const projectRoot = makeTempDir("plexus-project-");
    const stateRoot = makeTempDir("plexus-state-");
    writeProjectConfig(projectRoot);
    writeRuntimeState(stateRoot, {
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
      ],
    });

    await expect(
      closeProject({
        projectRoot,
        stateRoot,
        workspaceId: "worktree-a",
        mcpPlClient: new FakeMcpPlClient(new Error("kill failed")),
        now: fixedNow,
      }),
    ).rejects.toThrow(ProjectCloseError);

    expect(loadProjectState(statePath(stateRoot))?.images).toEqual([
      {
        id: "dev",
        imageName: "MyProject-dev",
        assignedPort: 7123,
        pid: 1234,
        status: "running",
      },
    ]);
  });
});
