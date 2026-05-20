import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PharoLauncherMcpToolClient } from "./pharoLauncherMcpClient.js";
import { claimPort, inspectPortClaim } from "./portClaims.js";
import { closeProject, ProjectCloseError } from "./projectClose.js";
import {
  loadProjectState,
  saveProjectState,
  type ProjectImageRepositoryWorkspaceState,
  type ProjectState,
} from "./projectState.js";

interface LauncherCommandResult<T = unknown> {
  ok: boolean;
  data?: T;
}

const tempDirs: string[] = [];
const fixedNow = () => new Date("2026-04-25T11:00:00.000Z");
const gitEnv = {
  GIT_AUTHOR_NAME: "PLexus Test",
  GIT_AUTHOR_EMAIL: "plexus-test@example.invalid",
  GIT_COMMITTER_NAME: "PLexus Test",
  GIT_COMMITTER_EMAIL: "plexus-test@example.invalid",
};

interface ToolCall {
  name: string;
  argumentsValue: Record<string, unknown>;
}

class FakePharoLauncherMcpClient implements PharoLauncherMcpToolClient {
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

function projectStateRuntime() {
  return {
    imagePorts: {
      allocation: "configured-or-dynamic",
      range: {
        start: 7100,
        end: 7199,
      },
      coordination: {
        mode: "project-state",
      },
    },
  };
}

function writeProjectConfig(projectRoot: string): void {
  fs.writeFileSync(
    path.join(projectRoot, "plexus.project.json"),
    JSON.stringify(
      {
        id: "project-123",
        name: "my-project",
        runtime: projectStateRuntime(),
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

function writeHostLocalProjectConfig(projectRoot: string, claimsRoot: string): void {
  fs.writeFileSync(
    path.join(projectRoot, "plexus.project.json"),
    JSON.stringify(
      {
        id: "project-123",
        name: "my-project",
        runtime: {
          imagePorts: {
            allocation: "configured-or-dynamic",
            range: {
              start: 7200,
              end: 7209,
            },
            coordination: {
              mode: "host-local",
              root: claimsRoot,
            },
          },
        },
        images: [
          {
            id: "dev",
            imageName: "MyProject-dev",
            active: true,
            mcp: {
              port: 7200,
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

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    env: {
      ...process.env,
      ...gitEnv,
    },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function writeFile(filePath: string, contents: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents, "utf8");
}

function initRepository(repositoryPath: string): string {
  fs.mkdirSync(repositoryPath, { recursive: true });
  git(repositoryPath, ["init", "--initial-branch=main"]);
  writeFile(path.join(repositoryPath, "src", "BaselineOfMyProject.class.st"), "baseline");
  git(repositoryPath, ["add", "."]);
  git(repositoryPath, ["commit", "-m", "Initial"]);
  return git(repositoryPath, ["rev-parse", "HEAD"]);
}

function repositoryWorkspace(
  repositoryPath: string,
  overrides: Partial<ProjectImageRepositoryWorkspaceState> = {},
): ProjectImageRepositoryWorkspaceState {
  return {
    repository: {
      id: "my-project",
      originPath: repositoryPath,
    },
    path: repositoryPath,
    materializationStrategy: "copy",
    sourceDirectory: "src",
    baseline: "MyProject",
    materializationState: "ready",
    diagnostics: [],
    dirtyState: "unknown",
    loadState: "not-loaded",
    ...overrides,
  };
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
    const pharoLauncherMcpClient = new FakePharoLauncherMcpClient();

    const result = await closeProject({
      projectRoot,
      stateRoot,
      workspaceId: "worktree-a",
      pharoLauncherMcpClient,
      now: fixedNow,
    });

    expect(result.ok).toBe(true);
    expect(pharoLauncherMcpClient.calls).toEqual([
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

  it("clears endpoint runtime state and handoff files when stopping images", async () => {
    const projectRoot = makeTempDir("plexus-project-");
    const stateRoot = makeTempDir("plexus-state-");
    const endpointPath = path.join(
      stateRoot,
      "projects",
      "project-123",
      "workspaces",
      "worktree-a",
      "mcp-endpoints",
      "dev.properties",
    );
    writeProjectConfig(projectRoot);
    fs.mkdirSync(path.dirname(endpointPath), { recursive: true });
    fs.writeFileSync(
      endpointPath,
      "transport=http\nhost=127.0.0.1\nport=7432\npath=/\n",
      "utf8",
    );
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
          mcpEndpoint: {
            transport: "http",
            host: "127.0.0.1",
            port: 7432,
            path: "/",
          },
          pid: 1234,
          status: "running",
        },
      ],
    });

    const result = await closeProject({
      projectRoot,
      stateRoot,
      workspaceId: "worktree-a",
      pharoLauncherMcpClient: new FakePharoLauncherMcpClient(),
      now: fixedNow,
    });

    expect(result.ok).toBe(true);
    expect(fs.existsSync(endpointPath)).toBe(false);
    expect(loadProjectState(result.statePath)?.images).toEqual([
      {
        id: "dev",
        imageName: "MyProject-dev",
        status: "stopped",
      },
    ]);
  });

  it("can scope project close to selected running images", async () => {
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
          pid: 5678,
          status: "running",
        },
      ],
    });
    const pharoLauncherMcpClient = new FakePharoLauncherMcpClient();

    const result = await closeProject({
      projectRoot,
      stateRoot,
      workspaceId: "worktree-a",
      imageIds: ["baseline"],
      pharoLauncherMcpClient,
      now: fixedNow,
    });

    expect(result.ok).toBe(true);
    expect(result.stoppedImages).toEqual([
      {
        id: "baseline",
        imageName: "MyProject-baseline",
        assignedPort: 7124,
        status: "stopped",
      },
    ]);
    expect(pharoLauncherMcpClient.calls).toEqual([
      {
        name: "pharo_launcher_process_kill",
        argumentsValue: {
          imageName: "MyProject-baseline",
          confirm: true,
        },
      },
    ]);
    expect(loadProjectState(result.statePath)?.images).toEqual([
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
    ]);
  });

  it("releases host-local image port claims after stopping owned images", async () => {
    const projectRoot = makeTempDir("plexus-project-");
    const stateRoot = makeTempDir("plexus-state-");
    const claimsRoot = makeTempDir("plexus-port-claims-");
    writeHostLocalProjectConfig(projectRoot, claimsRoot);
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
          assignedPort: 7200,
          pid: 1234,
          status: "running",
        },
      ],
    });
    await claimPort({
      claimsRoot,
      projectId: "project-123",
      projectName: "my-project",
      workspaceId: "worktree-a",
      targetId: "project-123--worktree-a",
      purpose: "image-mcp",
      imageId: "dev",
      requestedPort: 7200,
      now: fixedNow,
    });

    const result = await closeProject({
      projectRoot,
      stateRoot,
      workspaceId: "worktree-a",
      pharoLauncherMcpClient: new FakePharoLauncherMcpClient(),
      now: fixedNow,
    });

    expect(result.ok).toBe(true);
    await expect(inspectPortClaim({ claimsRoot, port: 7200 })).resolves.toEqual({
      status: "available",
      port: 7200,
    });
  });

  it("preserves repository workspaces by default and records live cleanup evidence", async () => {
    const projectRoot = makeTempDir("plexus-project-");
    const stateRoot = makeTempDir("plexus-state-");
    const repositoryPath = path.join(makeTempDir("plexus-repo-"), "my-project");
    const commit = initRepository(repositoryPath);
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
          status: "stopped",
          repositoryWorkspace: repositoryWorkspace(repositoryPath),
        },
      ],
    });

    const result = await closeProject({
      projectRoot,
      stateRoot,
      workspaceId: "worktree-a",
      pharoLauncherMcpClient: new FakePharoLauncherMcpClient(),
      now: fixedNow,
      env: gitEnv,
    });

    expect(result.ok).toBe(true);
    expect(fs.existsSync(repositoryPath)).toBe(true);
    expect(result.repositoryWorkspaceCleanups).toEqual([
      expect.objectContaining({
        policy: "preserve",
        decision: "preserved",
        imageId: "dev",
        repositoryId: "my-project",
        path: repositoryPath,
        branch: "main",
        currentCommit: commit,
        dirtyState: "clean",
      }),
    ]);
    expect(
      loadProjectState(result.statePath)?.images[0].repositoryWorkspace
        ?.cleanupState,
    ).toMatchObject({
      policy: "preserve",
      decision: "preserved",
      path: repositoryPath,
      currentCommit: commit,
      dirtyState: "clean",
    });
  });

  it("deletes clean disposable repository workspaces only when explicitly requested", async () => {
    const projectRoot = makeTempDir("plexus-project-");
    const stateRoot = makeTempDir("plexus-state-");
    const repositoryPath = path.join(makeTempDir("plexus-repo-"), "my-project");
    initRepository(repositoryPath);
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
          status: "stopped",
          repositoryWorkspace: repositoryWorkspace(repositoryPath),
        },
      ],
    });

    const result = await closeProject({
      projectRoot,
      stateRoot,
      workspaceId: "worktree-a",
      repositoryWorkspaceCleanupPolicy: "delete-disposable",
      pharoLauncherMcpClient: new FakePharoLauncherMcpClient(),
      now: fixedNow,
      env: gitEnv,
    });

    expect(result.ok).toBe(true);
    expect(fs.existsSync(repositoryPath)).toBe(false);
    expect(result.repositoryWorkspaceCleanups).toEqual([
      expect.objectContaining({
        policy: "delete-disposable",
        decision: "deleted",
        dirtyState: "clean",
        path: repositoryPath,
      }),
    ]);
  });

  it("refuses destructive cleanup of dirty repository workspaces", async () => {
    const projectRoot = makeTempDir("plexus-project-");
    const stateRoot = makeTempDir("plexus-state-");
    const repositoryPath = path.join(makeTempDir("plexus-repo-"), "my-project");
    initRepository(repositoryPath);
    writeFile(path.join(repositoryPath, "src", "Dirty.class.st"), "dirty");
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
          status: "stopped",
          repositoryWorkspace: repositoryWorkspace(repositoryPath),
        },
      ],
    });

    let thrown: ProjectCloseError | undefined;
    try {
      await closeProject({
        projectRoot,
        stateRoot,
        workspaceId: "worktree-a",
        repositoryWorkspaceCleanupPolicy: "delete-disposable",
        pharoLauncherMcpClient: new FakePharoLauncherMcpClient(),
        now: fixedNow,
        env: gitEnv,
      });
    } catch (error) {
      thrown = error as ProjectCloseError;
    }

    expect(thrown).toBeInstanceOf(ProjectCloseError);
    expect(fs.existsSync(repositoryPath)).toBe(true);
    expect(thrown?.result.repositoryWorkspaceCleanups).toEqual([
      expect.objectContaining({
        policy: "delete-disposable",
        decision: "refused",
        dirtyState: "dirty",
        path: repositoryPath,
      }),
    ]);
  });

  it("archives repository workspaces with an explicit archive policy", async () => {
    const projectRoot = makeTempDir("plexus-project-");
    const stateRoot = makeTempDir("plexus-state-");
    const archiveRoot = makeTempDir("plexus-archive-");
    const repositoryPath = path.join(makeTempDir("plexus-repo-"), "my-project");
    initRepository(repositoryPath);
    writeFile(path.join(repositoryPath, "src", "Dirty.class.st"), "dirty");
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
          status: "stopped",
          repositoryWorkspace: repositoryWorkspace(repositoryPath),
        },
      ],
    });

    const result = await closeProject({
      projectRoot,
      stateRoot,
      workspaceId: "worktree-a",
      repositoryWorkspaceCleanupPolicy: "archive",
      repositoryWorkspaceArchiveRoot: archiveRoot,
      pharoLauncherMcpClient: new FakePharoLauncherMcpClient(),
      now: fixedNow,
      env: gitEnv,
    });
    const archivePath = result.repositoryWorkspaceCleanups[0]?.archivePath;

    expect(result.ok).toBe(true);
    expect(fs.existsSync(repositoryPath)).toBe(false);
    expect(archivePath).toBeDefined();
    expect(fs.existsSync(path.join(archivePath!, "src", "Dirty.class.st"))).toBe(
      true,
    );
    expect(result.repositoryWorkspaceCleanups).toEqual([
      expect.objectContaining({
        policy: "archive",
        decision: "archived",
        dirtyState: "dirty",
        path: repositoryPath,
        archivePath,
      }),
    ]);
  });

  it("reports failed repository cleanup diagnostics without deleting boundary paths", async () => {
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
          status: "stopped",
          repositoryWorkspace: repositoryWorkspace(projectRoot),
        },
      ],
    });

    let thrown: ProjectCloseError | undefined;
    try {
      await closeProject({
        projectRoot,
        stateRoot,
        workspaceId: "worktree-a",
        repositoryWorkspaceCleanupPolicy: "delete-disposable",
        pharoLauncherMcpClient: new FakePharoLauncherMcpClient(),
        now: fixedNow,
        env: gitEnv,
      });
    } catch (error) {
      thrown = error as ProjectCloseError;
    }

    expect(thrown).toBeInstanceOf(ProjectCloseError);
    expect(fs.existsSync(path.join(projectRoot, "plexus.project.json"))).toBe(
      true,
    );
    expect(thrown?.result.repositoryWorkspaceCleanups).toEqual([
      expect.objectContaining({
        policy: "delete-disposable",
        decision: "failed",
        path: projectRoot,
        message: expect.stringContaining("image or project boundary path"),
      }),
    ]);
  });

  it("does nothing when runtime state does not exist", async () => {
    const projectRoot = makeTempDir("plexus-project-");
    const stateRoot = makeTempDir("plexus-state-");
    writeProjectConfig(projectRoot);
    const pharoLauncherMcpClient = new FakePharoLauncherMcpClient();

    const result = await closeProject({
      projectRoot,
      stateRoot,
      workspaceId: "worktree-a",
      pharoLauncherMcpClient,
      now: fixedNow,
    });

    expect(result.ok).toBe(true);
    expect(result.state).toBeUndefined();
    expect(result.stoppedImages).toEqual([]);
    expect(pharoLauncherMcpClient.calls).toEqual([]);
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
        pharoLauncherMcpClient: new FakePharoLauncherMcpClient(new Error("kill failed")),
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
