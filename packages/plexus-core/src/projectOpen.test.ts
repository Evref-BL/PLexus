import fs from "node:fs";
import { execFileSync } from "node:child_process";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PharoLauncherMcpToolClient } from "./pharoLauncherMcpClient.js";
import type { PharoMcpHealthClient } from "./pharoMcpHealth.js";
import {
  claimPort,
  inspectPortClaim,
  listPortClaims,
} from "./portClaims.js";
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
const fakeLivePortClaimChecks = {
  isProcessAlive: async () => true,
  isPortListening: async () => false,
};
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

  constructor(
    private readonly processes: LauncherProcess[] = [],
    private readonly launchError?: Error,
    private readonly onLaunch?: (argumentsValue: Record<string, unknown>) => void,
    private readonly imagesDir?: string,
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

      this.onLaunch?.(argumentsValue);
      return { ok: true } as T;
    }

    if (
      name === "pharo_launcher_template_update" ||
      name === "pharo_launcher_image_create" ||
      name === "pharo_launcher_image_copy" ||
      name === "pharo_launcher_image_copy_between_profiles"
    ) {
      return { ok: true } as T;
    }

    if (name === "pharo_launcher_process_list") {
      const result = {
        ok: true,
        data: this.processes,
      } satisfies LauncherCommandResult<LauncherProcess[]>;

      return result as T;
    }

    if (name === "pharo_launcher_image_info") {
      const imageName = argumentsValue.imageName as string;
      return {
        ok: true,
        data: {
          name: imageName,
          imagePath: path.join(imageName, `${imageName}.image`),
          pharoVersion: "13",
          vmId: "vm-13",
        },
      } as T;
    }

    if (name === "pharo_launcher_config") {
      return {
        ok: true,
        data: {
          profile: {
            imagesDir: {
              path: this.imagesDir ?? makeTempDir("plexus-images-"),
              exists: true,
            },
          },
        },
      } as T;
    }

    throw new Error(`Unexpected tool call: ${name}`);
  }
}

class FakeHealthClient implements PharoMcpHealthClient {
  readonly ports: number[] = [];
  readonly endpoints: Array<{
    transport: "http";
    host: string;
    port: number;
    path: string;
  }> = [];

  constructor(private readonly healthy: boolean) {}

  async check(port: number): Promise<boolean> {
    this.ports.push(port);
    return this.healthy;
  }

  async checkEndpoint(endpoint: {
    transport: "http";
    host: string;
    port: number;
    path: string;
  }): Promise<boolean> {
    this.endpoints.push(endpoint);
    return this.healthy;
  }
}

function makeTempDir(prefix: string): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(tempDir);
  return tempDir;
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

function initRepository(sourceRoot: string): string {
  git(sourceRoot, ["init", "--initial-branch=main"]);
  fs.mkdirSync(path.join(sourceRoot, "src"), { recursive: true });
  fs.writeFileSync(
    path.join(sourceRoot, "src", "BaselineOfMyProject.class.st"),
    "baseline",
    "utf8",
  );
  git(sourceRoot, ["add", "."]);
  git(sourceRoot, ["commit", "-m", "Initial"]);
  return git(sourceRoot, ["rev-parse", "HEAD"]);
}

function projectStateRuntime(start = 7100, end = 7199) {
  return {
    imagePorts: {
      allocation: "configured-or-dynamic",
      range: { start, end },
      coordination: {
        mode: "project-state",
      },
    },
  };
}

function hostLocalRuntime(claimsRoot: string, start = 7200, end = 7209) {
  return {
    imagePorts: {
      allocation: "configured-or-dynamic",
      range: { start, end },
      coordination: {
        root: claimsRoot,
      },
    },
  };
}

function dynamicImage(id = "dev", imageName = "MyProject-dev") {
  return {
    id,
    imageName,
    active: true,
    mcp: {
      loadScript: "pharo/load-mcp.st",
    },
  };
}

function listenOnLoopback(): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve(server);
    });
  });
}

function writeProjectConfig(
  projectRoot: string,
  overrides: Record<string, unknown> = {},
): void {
  const config = {
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
      runtimeStatus: "running",
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

  it("materializes image-local repository workspaces before startup launch", async () => {
    const projectRoot = makeTempDir("plexus-project-");
    const stateRoot = makeTempDir("plexus-state-");
    const sourceRoot = makeTempDir("plexus-source-");
    const imagesDir = makeTempDir("plexus-images-");
    const sourceCommit = initRepository(sourceRoot);
    writeProjectConfig(projectRoot, {
      images: [
        {
          id: "dev",
          imageName: "MyProject-dev",
          active: true,
          mcp: {
            port: 7123,
            loadScript: "pharo/load-mcp.st",
          },
          repositoryWorkspace: {
            repository: {
              id: "my-project",
              originPath: sourceRoot,
            },
            sourceDirectory: "src",
            baseline: "MyProject",
            materialization: {
              strategy: "copy",
            },
          },
        },
      ],
    });
    const pharoLauncherMcpClient = new FakePharoLauncherMcpClient(
      [
        {
          pid: 1234,
          imageName: "MyProject-dev",
          commandLine: "PharoConsole.exe MyProject-dev.image",
        },
      ],
      undefined,
      (argumentsValue) => {
        const scriptPath = argumentsValue.script as string;
        fs.writeFileSync(
          path.join(
            path.dirname(scriptPath),
            "repository-workspace-load-dev.properties",
          ),
          [
            "status=loaded",
            `sourcePath=${repositoryPath}/src`,
            "sourceDirectory=src",
            "baseline=MyProject",
            `currentCommit=${sourceCommit}`,
            "",
          ].join("\n"),
          "utf8",
        );
      },
      imagesDir,
    );

    const repositoryPath = path.join(
      imagesDir,
      "MyProject-dev",
      "pharo-local",
      "iceberg",
      "my-project",
    );
    const result = await openProject({
      projectRoot,
      stateRoot,
      workspaceId: "worktree-a",
      pharoLauncherMcpClient,
      healthClient: new FakeHealthClient(true),
      now: fixedNow,
      sleep: async () => {},
      poll: {
        intervalMs: 0,
      },
    });

    const launchIndex = pharoLauncherMcpClient.calls.findIndex(
      (call) => call.name === "pharo_launcher_image_launch",
    );
    const infoIndex = pharoLauncherMcpClient.calls.findIndex(
      (call) => call.name === "pharo_launcher_image_info",
    );

    expect(infoIndex).toBeGreaterThanOrEqual(0);
    expect(launchIndex).toBeGreaterThan(infoIndex);
    expect(git(repositoryPath, ["rev-parse", "HEAD"])).toBe(sourceCommit);
    expect(result.state.images[0].repositoryWorkspace).toMatchObject({
      path: repositoryPath,
      sourcePath: sourceRoot,
      currentCommit: sourceCommit,
      baseCommit: sourceCommit,
      materializationState: "ready",
      dirtyState: "clean",
      loadState: "loaded",
      loadSourcePath: `${repositoryPath}/src`,
      loadStatusPath: path.join(
        stateRoot,
        "projects",
        "project-123",
        "workspaces",
        "worktree-a",
        "scripts",
        "repository-workspace-load-dev.properties",
      ),
    });
  });

  it("records Pharo project load failures reported by the startup script", async () => {
    const projectRoot = makeTempDir("plexus-project-");
    const stateRoot = makeTempDir("plexus-state-");
    const sourceRoot = makeTempDir("plexus-source-");
    const imagesDir = makeTempDir("plexus-images-");
    initRepository(sourceRoot);
    writeProjectConfig(projectRoot, {
      images: [
        {
          id: "dev",
          imageName: "MyProject-dev",
          active: true,
          mcp: {
            port: 7123,
            loadScript: "pharo/load-mcp.st",
          },
          repositoryWorkspace: {
            repository: {
              id: "my-project",
              originPath: sourceRoot,
            },
            sourceDirectory: "missing",
            baseline: "MyProject",
            materialization: {
              strategy: "copy",
            },
          },
        },
      ],
    });
    const pharoLauncherMcpClient = new FakePharoLauncherMcpClient(
      [
        {
          pid: 1234,
          imageName: "MyProject-dev",
          commandLine: "PharoConsole.exe MyProject-dev.image",
        },
      ],
      undefined,
      (argumentsValue) => {
        const scriptPath = argumentsValue.script as string;
        fs.writeFileSync(
          path.join(
            path.dirname(scriptPath),
            "repository-workspace-load-dev.properties",
          ),
          [
            "status=failed",
            "sourcePath=/image/pharo-local/iceberg/my-project/missing",
            "sourceDirectory=missing",
            "baseline=MyProject",
            "message=Configured Pharo project source directory does not exist",
            "",
          ].join("\n"),
          "utf8",
        );
      },
      imagesDir,
    );

    await expect(
      openProject({
        projectRoot,
        stateRoot,
        workspaceId: "worktree-a",
        pharoLauncherMcpClient,
        healthClient: new FakeHealthClient(true),
        now: fixedNow,
        sleep: async () => {},
        poll: {
          intervalMs: 0,
        },
      }),
    ).rejects.toMatchObject({
      result: {
        ok: false,
        failures: [
          {
            imageId: "dev",
            message:
              "Pharo project load failed for image dev: Configured Pharo project source directory does not exist",
          },
        ],
      },
    });
    const failedState = loadProjectState(
      path.join(
        stateRoot,
        "projects",
        "project-123",
        "workspaces",
        "worktree-a",
        "state.json",
      ),
    );
    expect(failedState?.images[0].repositoryWorkspace).toMatchObject({
      loadState: "failed",
      loadError: "Configured Pharo project source directory does not exist",
      loadSourcePath: "/image/pharo-local/iceberg/my-project/missing",
    });
  });

  it("records an auto-bound MCP endpoint and releases the fallback port claim", async () => {
    const claimsRoot = makeTempDir("plexus-port-claims-");
    const projectRoot = makeTempDir("plexus-project-");
    const stateRoot = makeTempDir("plexus-state-");
    writeProjectConfig(projectRoot, {
      runtime: hostLocalRuntime(claimsRoot, 7200, 7200),
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
    const endpointPath = path.join(
      stateRoot,
      "projects",
      "project-123",
      "workspaces",
      "worktree-a",
      "mcp-endpoints",
      "dev.properties",
    );
    const pharoLauncherMcpClient = new FakePharoLauncherMcpClient(
      [
        {
          pid: 1234,
          imageName: "MyProject-dev",
          commandLine: "PharoConsole.exe MyProject-dev.image",
        },
      ],
      undefined,
      () => {
        fs.mkdirSync(path.dirname(endpointPath), { recursive: true });
        fs.writeFileSync(
          endpointPath,
          "transport=http\nhost=127.0.0.1\nport=7432\npath=/mcp\n",
          "utf8",
        );
      },
    );
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
      portClaimChecks: fakeLivePortClaimChecks,
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
    expect(fs.readFileSync(scriptPath, "utf8")).toContain("mcp bindToLoopback.");
    expect(healthClient.endpoints).toEqual([
      {
        transport: "http",
        host: "127.0.0.1",
        port: 7432,
        path: "/mcp",
      },
    ]);
    expect(healthClient.ports).toEqual([]);
    expect(result.state.images[0]).toEqual({
      id: "dev",
      imageName: "MyProject-dev",
      mcpEndpoint: {
        transport: "http",
        host: "127.0.0.1",
        port: 7432,
        path: "/mcp",
      },
      pid: 1234,
      status: "running",
    });
    await expect(listPortClaims({ claimsRoot })).resolves.toEqual([]);
  });

  it("falls back to the assigned port when endpoint handoff is unavailable", async () => {
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

    expect(result.ok).toBe(true);
    expect(healthClient.endpoints).toEqual([]);
    expect(healthClient.ports).toEqual([7100]);
    expect(result.state.images[0]).toMatchObject({
      id: "dev",
      assignedPort: 7100,
      pid: 1234,
      status: "running",
    });
    expect(result.state.images[0]).not.toHaveProperty("mcpEndpoint");
  });

  it("fails when endpoint handoff content is invalid", async () => {
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
    const endpointPath = path.join(
      stateRoot,
      "projects",
      "project-123",
      "workspaces",
      "worktree-a",
      "mcp-endpoints",
      "dev.properties",
    );
    const pharoLauncherMcpClient = new FakePharoLauncherMcpClient(
      [
        {
          pid: 1234,
          imageName: "MyProject-dev",
          commandLine: "PharoConsole.exe MyProject-dev.image",
        },
      ],
      undefined,
      () => {
        fs.mkdirSync(path.dirname(endpointPath), { recursive: true });
        fs.writeFileSync(
          endpointPath,
          "transport=http\nhost=127.0.0.1\nport=nope\npath=/\n",
          "utf8",
        );
      },
    );

    await expect(
      openProject({
        projectRoot,
        stateRoot,
        workspaceId: "worktree-a",
        pharoLauncherMcpClient,
        healthClient: new FakeHealthClient(true),
        now: fixedNow,
        sleep: async () => {},
        poll: {
          intervalMs: 0,
        },
      }),
    ).rejects.toThrow(ProjectOpenError);
  });

  it("reports missing endpoint handoff when fallback health never becomes ready", async () => {
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
    const pharoLauncherMcpClient = new FakePharoLauncherMcpClient([
      {
        pid: 1234,
        imageName: "MyProject-dev",
        commandLine: "PharoConsole.exe MyProject-dev.image",
      },
    ]);

    await expect(
      openProject({
        projectRoot,
        stateRoot,
        workspaceId: "worktree-a",
        pharoLauncherMcpClient,
        healthClient: new FakeHealthClient(false),
        now: fixedNow,
        sleep: async () => {},
        poll: {
          intervalMs: 0,
          healthTimeoutMs: 1,
        },
      }),
    ).rejects.toThrow(ProjectOpenError);
  });

  it("materializes first-open template images from the PLexus home image cache", async () => {
    const projectRoot = makeTempDir("plexus-project-");
    const stateRoot = makeTempDir("plexus-state-");
    const homePath = makeTempDir("plexus-home-");
    writeProjectConfig(projectRoot, {
      home: {
        path: homePath,
        imageCache: { enabled: true },
      },
      images: [
        {
          id: "dev",
          imageName: "MyProject-{workspaceId}-dev",
          active: true,
          create: {
            kind: "template",
            templateName: "Pharo 13.0 - 64bit",
            templateCategory: "Official",
          },
          mcp: {
            port: 7123,
            loadScript: "pharo/load-mcp.st",
          },
        },
      ],
    });
    const pharoLauncherMcpClient = new FakePharoLauncherMcpClient([
      {
        pid: 1234,
        imageName: "MyProject-worktree-a-dev",
        commandLine: "PharoConsole.exe MyProject-worktree-a-dev.image",
      },
    ]);
    const healthClient = new FakeHealthClient(true);

    const result = await openProject({
      projectRoot,
      stateRoot,
      workspaceId: "worktree-a",
      pharoLauncherMcpClient,
      healthClient,
      homeImageCacheApproval: {
        approved: true,
        runnerId: "isolated-runner-1",
      },
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
    const entriesRoot = path.join(homePath, "image-cache", "entries");
    const [entryKey] = fs.readdirSync(entriesRoot);
    const manifestPath = path.join(entriesRoot, entryKey!, "manifest.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
      pharoMcp: { preparationStatus: string };
    };

    expect(result.ok).toBe(true);
    expect(manifest.pharoMcp.preparationStatus).toBe("prepared");
    expect(pharoLauncherMcpClient.calls).toEqual([
      {
        name: "pharo_launcher_template_update",
        argumentsValue: {},
      },
      {
        name: "pharo_launcher_image_create",
        argumentsValue: {
          newImageName: expect.stringMatching(/^PlexusHomeCache-/),
          templateName: "Pharo 13.0 - 64bit",
          templateCategory: "Official",
          noLaunch: true,
        },
      },
      {
        name: "pharo_launcher_image_launch",
        argumentsValue: {
          imageName: expect.stringMatching(/^PlexusHomeCache-/),
          detached: false,
          script: expect.stringContaining(
            path.join(homePath, "image-cache", "entries"),
          ),
        },
      },
      {
        name: "pharo_launcher_image_copy_between_profiles",
        argumentsValue: {
          sourceProfile: expect.objectContaining({
            stateRoot: path.join(
              homePath,
              "profiles",
              "pharo-launcher-mcp",
              "image-cache",
            ),
          }),
          destinationProfile: expect.objectContaining({
            stateRoot: path.join(
              stateRoot,
              "profiles",
              "pharo-launcher-mcp",
              "project-123",
            ),
          }),
          sourceImageName: expect.stringMatching(/^PlexusHomeCache-/),
          destinationImageName: "MyProject-worktree-a-dev",
        },
      },
      {
        name: "pharo_launcher_image_launch",
        argumentsValue: {
          imageName: "MyProject-worktree-a-dev",
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
  });

  it("opens zero-image projects as an idle runtime setup", async () => {
    const projectRoot = makeTempDir("plexus-project-");
    const stateRoot = makeTempDir("plexus-state-");
    writeProjectConfig(projectRoot, {
      images: [],
    });

    const result = await openProject({
      projectRoot,
      stateRoot,
      workspaceId: "worktree-a",
      now: fixedNow,
    });

    expect(result).toMatchObject({
      ok: true,
      failures: [],
      state: {
        projectId: "project-123",
        projectName: "my-project",
        workspaceId: "worktree-a",
        targetId: "project-123--worktree-a",
        runtimeStatus: "idle",
        updatedAt: "2026-04-25T10:00:00.000Z",
        images: [],
      },
    });
    expect(loadProjectState(result.statePath)).toEqual(result.state);
  });

  it("records the launched image process instead of the launcher wrapper", async () => {
    const projectRoot = makeTempDir("plexus-project-");
    const stateRoot = makeTempDir("plexus-state-");
    writeProjectConfig(projectRoot);
    const pharoLauncherMcpClient = new FakePharoLauncherMcpClient([
      {
        pid: 1000,
        imageName: "PharoLauncher",
        imagePath: "/Applications/PharoLauncher.app/PharoLauncher.image",
        commandLine:
          "/Applications/PharoLauncher.app/PharoLauncher.image image launch MyProject-dev",
      },
      {
        pid: 1234,
        imageName: "MyProject-dev",
        imagePath: "/Users/ada/images/MyProject-dev/MyProject-dev.image",
        commandLine:
          "/Users/ada/vms/pharo /Users/ada/images/MyProject-dev/MyProject-dev.image eval start-dev.st",
      },
    ]);

    const result = await openProject({
      projectRoot,
      stateRoot,
      workspaceId: "worktree-a",
      pharoLauncherMcpClient,
      healthClient: new FakeHealthClient(true),
      now: fixedNow,
      sleep: async () => {},
      poll: {
        intervalMs: 0,
      },
    });

    expect(result.state.images[0]).toMatchObject({
      id: "dev",
      pid: 1234,
      status: "running",
    });
  });

  it("can scope project open to selected active images", async () => {
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
        {
          id: "baseline",
          imageName: "MyProject-baseline",
          active: true,
          mcp: {
            loadScript: "pharo/load-mcp.st",
          },
        },
      ],
    });
    const pharoLauncherMcpClient = new FakePharoLauncherMcpClient([
      {
        pid: 5678,
        imageName: "MyProject-baseline",
        commandLine: "PharoConsole.exe MyProject-baseline.image",
      },
    ]);
    const healthClient = new FakeHealthClient(true);

    const result = await openProject({
      projectRoot,
      stateRoot,
      workspaceId: "worktree-a",
      imageIds: ["baseline"],
      pharoLauncherMcpClient,
      healthClient,
      now: fixedNow,
      sleep: async () => {},
      poll: {
        intervalMs: 0,
      },
    });

    const baselineScriptPath = path.join(
      stateRoot,
      "projects",
      "project-123",
      "workspaces",
      "worktree-a",
      "scripts",
      "start-baseline.st",
    );

    expect(result.ok).toBe(true);
    expect(pharoLauncherMcpClient.calls).toEqual([
      {
        name: "pharo_launcher_image_launch",
        argumentsValue: {
          imageName: "MyProject-baseline",
          detached: true,
          script: baselineScriptPath,
        },
      },
      {
        name: "pharo_launcher_process_list",
        argumentsValue: {},
      },
    ]);
    expect(healthClient.ports).toEqual([7101]);
    expect(fs.existsSync(baselineScriptPath)).toBe(true);
    expect(result.state.images).toEqual([
      {
        id: "dev",
        imageName: "MyProject-dev",
        assignedPort: 7100,
        status: "stopped",
      },
      {
        id: "baseline",
        imageName: "MyProject-baseline",
        assignedPort: 7101,
        pid: 5678,
        status: "running",
      },
    ]);
  });

  it("blocks prepared image cache copies without approved runner input", async () => {
    const projectRoot = makeTempDir("plexus-project-");
    const stateRoot = makeTempDir("plexus-state-");
    writeProjectConfig(projectRoot, {
      preparedImages: [
        {
          id: "pharo-13-mcp",
          imageName: "MyProject-{projectId}-{cacheId}",
          source: {
            kind: "template",
            templateName: "Pharo 13.0 - 64bit",
          },
          mcp: {
            loadScript: "pharo/load-mcp.st",
          },
        },
      ],
      images: [
        {
          id: "dev",
          imageName: "MyProject-{workspaceId}-dev",
          active: true,
          preparedImage: {
            cacheId: "pharo-13-mcp",
            copyMode: "copy-on-open",
          },
          mcp: {
            port: 7123,
            loadScript: "pharo/load-mcp.st",
          },
        },
      ],
    });
    const pharoLauncherMcpClient = new FakePharoLauncherMcpClient();

    await expect(
      openProject({
        projectRoot,
        stateRoot,
        workspaceId: "worktree-a",
        pharoLauncherMcpClient,
        healthClient: new FakeHealthClient(true),
        now: fixedNow,
        sleep: async () => {},
        poll: {
          intervalMs: 0,
        },
      }),
    ).rejects.toThrow(ProjectOpenError);
    expect(pharoLauncherMcpClient.calls).toEqual([]);
  });

  it("copies prepared cache images before launching when runner approval is explicit", async () => {
    const projectRoot = makeTempDir("plexus-project-");
    const stateRoot = makeTempDir("plexus-state-");
    writeProjectConfig(projectRoot, {
      preparedImages: [
        {
          id: "pharo-13-mcp",
          imageName: "MyProject-{projectId}-{cacheId}",
          source: {
            kind: "template",
            templateName: "Pharo 13.0 - 64bit",
          },
          mcp: {
            loadScript: "pharo/load-mcp.st",
          },
        },
      ],
      images: [
        {
          id: "dev",
          imageName: "MyProject-{workspaceId}-dev",
          active: true,
          preparedImage: {
            cacheId: "pharo-13-mcp",
            copyMode: "copy-on-open",
          },
          mcp: {
            port: 7123,
            loadScript: "pharo/load-mcp.st",
          },
        },
      ],
    });
    const pharoLauncherMcpClient = new FakePharoLauncherMcpClient([
      {
        pid: 1234,
        imageName: "MyProject-worktree-a-dev",
        commandLine: "PharoConsole.exe MyProject-worktree-a-dev.image",
      },
    ]);
    const healthClient = new FakeHealthClient(true);

    const result = await openProject({
      projectRoot,
      stateRoot,
      workspaceId: "worktree-a",
      pharoLauncherMcpClient,
      healthClient,
      preparedImageCacheApproval: {
        approved: true,
        runnerId: "isolated-runner-1",
      },
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
        name: "pharo_launcher_image_copy",
        argumentsValue: {
          imageName: "MyProject-project-123-pharo-13-mcp",
          newImageName: "MyProject-worktree-a-dev",
        },
      },
      {
        name: "pharo_launcher_image_launch",
        argumentsValue: {
          imageName: "MyProject-worktree-a-dev",
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
  });

  it("opens known unsupported Pharo versions without waiting for MCP health", async () => {
    const projectRoot = makeTempDir("plexus-project-");
    const stateRoot = makeTempDir("plexus-state-");
    writeProjectConfig(projectRoot, {
      images: [
        {
          id: "legacy",
          imageName: "MyProject-legacy",
          active: true,
          create: {
            kind: "template",
            templateName: "Pharo 11.0 - 64bit",
          },
          mcp: {
            port: 7123,
            loadScript: "pharo/load-mcp.st",
          },
        },
      ],
    });
    const pharoLauncherMcpClient = new FakePharoLauncherMcpClient([
      {
        pid: 1234,
        imageName: "MyProject-legacy",
        commandLine: "PharoConsole.exe MyProject-legacy.image",
      },
    ]);
    const healthClient = new FakeHealthClient(false);

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
      "start-legacy.st",
    );

    expect(result.ok).toBe(true);
    expect(pharoLauncherMcpClient.calls).toEqual([
      {
        name: "pharo_launcher_image_launch",
        argumentsValue: {
          imageName: "MyProject-legacy",
          detached: true,
          script: scriptPath,
        },
      },
      {
        name: "pharo_launcher_process_list",
        argumentsValue: {},
      },
    ]);
    expect(healthClient.ports).toEqual([]);
    expect(fs.readFileSync(scriptPath, "utf8")).toContain(
      "Pharo MCP startup is disabled",
    );
    expect(result.state.images[0]).toMatchObject({
      id: "legacy",
      imageName: "MyProject-legacy",
      pid: 1234,
      status: "running",
      pharoVersion: "11",
      pharoMcpContract: {
        status: "unsupported",
        actualMajorVersion: 11,
        supportedMajorVersions: [12, 13, 14],
      },
    });
    expect(result.state.images[0]).not.toHaveProperty("assignedPort");
  });

  it("does not claim host-local image MCP ports for known unsupported Pharo versions", async () => {
    const claimsRoot = makeTempDir("plexus-port-claims-");
    const projectRoot = makeTempDir("plexus-project-");
    const stateRoot = makeTempDir("plexus-state-");
    writeProjectConfig(projectRoot, {
      runtime: hostLocalRuntime(claimsRoot, 7200, 7200),
      images: [
        {
          id: "legacy",
          imageName: "MyProject-legacy",
          active: true,
          create: {
            kind: "template",
            templateName: "Pharo 11.0 - 64bit",
          },
          mcp: {
            port: 7200,
            loadScript: "pharo/load-mcp.st",
          },
        },
      ],
    });
    const pharoLauncherMcpClient = new FakePharoLauncherMcpClient([
      {
        pid: 1234,
        imageName: "MyProject-legacy",
        commandLine: "PharoConsole.exe MyProject-legacy.image",
      },
    ]);

    const result = await openProject({
      projectRoot,
      stateRoot,
      workspaceId: "worktree-a",
      pharoLauncherMcpClient,
      healthClient: new FakeHealthClient(false),
      now: fixedNow,
      sleep: async () => {},
      poll: {
        intervalMs: 0,
      },
      portClaimChecks: fakeLivePortClaimChecks,
    });

    expect(result.ok).toBe(true);
    expect(result.state.images[0]).not.toHaveProperty("assignedPort");
    await expect(listPortClaims({ claimsRoot })).resolves.toEqual([]);
  });

  it("keeps unselected scoped images in their previous runtime state", async () => {
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
        {
          id: "baseline",
          imageName: "MyProject-baseline",
          active: true,
          mcp: {
            loadScript: "pharo/load-mcp.st",
          },
        },
      ],
    });
    saveProjectState(
      path.join(
        stateRoot,
        "projects",
        "project-123",
        "workspaces",
        "worktree-a",
        "state.json",
      ),
      {
        projectId: "project-123",
        projectName: "my-project",
        workspaceId: "worktree-a",
        targetId: "project-123--worktree-a",
        updatedAt: "2026-04-25T09:00:00.000Z",
        images: [
          {
            id: "dev",
            imageName: "MyProject-dev",
            assignedPort: 7100,
            pid: 1234,
            status: "running",
          },
          {
            id: "baseline",
            imageName: "MyProject-baseline",
            assignedPort: 7101,
            status: "stopped",
          },
        ],
      },
    );

    const result = await openProject({
      projectRoot,
      stateRoot,
      workspaceId: "worktree-a",
      imageIds: ["baseline"],
      pharoLauncherMcpClient: new FakePharoLauncherMcpClient([
        {
          pid: 5678,
          imageName: "MyProject-baseline",
          commandLine: "PharoConsole.exe MyProject-baseline.image",
        },
      ]),
      healthClient: new FakeHealthClient(true),
      now: fixedNow,
      sleep: async () => {},
      poll: {
        intervalMs: 0,
      },
    });

    expect(result.state.images).toEqual([
      {
        id: "dev",
        imageName: "MyProject-dev",
        assignedPort: 7100,
        pid: 1234,
        status: "running",
      },
      {
        id: "baseline",
        imageName: "MyProject-baseline",
        assignedPort: 7101,
        pid: 5678,
        status: "running",
      },
    ]);
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

  it("uses host-local claims to allocate dynamic ports across separate state roots", async () => {
    const claimsRoot = makeTempDir("plexus-port-claims-");
    const projectRootA = makeTempDir("plexus-project-a-");
    const projectRootB = makeTempDir("plexus-project-b-");
    const stateRootA = makeTempDir("plexus-state-a-");
    const stateRootB = makeTempDir("plexus-state-b-");
    writeProjectConfig(projectRootA, {
      name: "project-a",
      id: "project-a",
      runtime: hostLocalRuntime(claimsRoot, 7200, 7201),
      images: [dynamicImage("dev", "ProjectA-dev")],
    });
    writeProjectConfig(projectRootB, {
      name: "project-b",
      id: "project-b",
      runtime: hostLocalRuntime(claimsRoot, 7200, 7201),
      images: [dynamicImage("dev", "ProjectB-dev")],
    });

    const resultA = await openProject({
      projectRoot: projectRootA,
      stateRoot: stateRootA,
      workspaceId: "worktree-a",
      pharoLauncherMcpClient: new FakePharoLauncherMcpClient([
        {
          pid: 1001,
          imageName: "ProjectA-dev",
          commandLine: "PharoConsole.exe ProjectA-dev.image",
        },
      ]),
      healthClient: new FakeHealthClient(true),
      now: fixedNow,
      sleep: async () => {},
      poll: { intervalMs: 0 },
      portClaimChecks: fakeLivePortClaimChecks,
    });
    const resultB = await openProject({
      projectRoot: projectRootB,
      stateRoot: stateRootB,
      workspaceId: "worktree-b",
      pharoLauncherMcpClient: new FakePharoLauncherMcpClient([
        {
          pid: 1002,
          imageName: "ProjectB-dev",
          commandLine: "PharoConsole.exe ProjectB-dev.image",
        },
      ]),
      healthClient: new FakeHealthClient(true),
      now: fixedNow,
      sleep: async () => {},
      poll: { intervalMs: 0 },
      portClaimChecks: fakeLivePortClaimChecks,
    });

    expect(resultA.state.images[0].assignedPort).toBe(7200);
    expect(resultB.state.images[0].assignedPort).toBe(7201);
    await expect(listPortClaims({ claimsRoot })).resolves.toMatchObject([
      { projectId: "project-a", workspaceId: "worktree-a", assignedPort: 7200 },
      { projectId: "project-b", workspaceId: "worktree-b", assignedPort: 7201 },
    ]);
  });

  it("rejects unrelated projects that request the same configured image MCP port by default", async () => {
    const claimsRoot = makeTempDir("plexus-port-claims-");
    const projectRootA = makeTempDir("plexus-project-a-");
    const projectRootB = makeTempDir("plexus-project-b-");
    const stateRootA = makeTempDir("plexus-state-a-");
    const stateRootB = makeTempDir("plexus-state-b-");
    writeProjectConfig(projectRootA, {
      name: "project-a",
      id: "project-a",
      runtime: hostLocalRuntime(claimsRoot, 7200, 7209),
      images: [
        {
          id: "dev",
          imageName: "ProjectA-dev",
          active: true,
          mcp: {
            port: 7200,
            loadScript: "pharo/load-mcp.st",
          },
        },
      ],
    });
    writeProjectConfig(projectRootB, {
      name: "project-b",
      id: "project-b",
      runtime: hostLocalRuntime(claimsRoot, 7200, 7209),
      images: [
        {
          id: "dev",
          imageName: "ProjectB-dev",
          active: true,
          mcp: {
            port: 7200,
            loadScript: "pharo/load-mcp.st",
          },
        },
      ],
    });
    const pharoLauncherMcpClientB = new FakePharoLauncherMcpClient([
      {
        pid: 2002,
        imageName: "ProjectB-dev",
        commandLine: "PharoConsole.exe ProjectB-dev.image",
      },
    ]);

    await openProject({
      projectRoot: projectRootA,
      stateRoot: stateRootA,
      workspaceId: "worktree-a",
      pharoLauncherMcpClient: new FakePharoLauncherMcpClient([
        {
          pid: 2001,
          imageName: "ProjectA-dev",
          commandLine: "PharoConsole.exe ProjectA-dev.image",
        },
      ]),
      healthClient: new FakeHealthClient(true),
      now: fixedNow,
      sleep: async () => {},
      poll: { intervalMs: 0 },
      portClaimChecks: fakeLivePortClaimChecks,
    });

    await expect(
      openProject({
        projectRoot: projectRootB,
        stateRoot: stateRootB,
        workspaceId: "worktree-b",
        pharoLauncherMcpClient: pharoLauncherMcpClientB,
        healthClient: new FakeHealthClient(true),
        now: fixedNow,
        sleep: async () => {},
        poll: { intervalMs: 0 },
        portClaimChecks: fakeLivePortClaimChecks,
      }),
    ).rejects.toThrow(
      "Project project-b image dev cannot use image MCP port 7200: already claimed",
    );
    expect(pharoLauncherMcpClientB.calls).toEqual([]);
    await expect(listPortClaims({ claimsRoot })).resolves.toMatchObject([
      {
        projectId: "project-a",
        workspaceId: "worktree-a",
        targetId: "project-a--worktree-a",
        purpose: "image-mcp",
        imageId: "dev",
        assignedPort: 7200,
        pid: 2001,
        claimedAt: "2026-04-25T10:00:00.000Z",
        updatedAt: "2026-04-25T10:00:00.000Z",
      },
    ]);
  });

  it("keeps dynamic host-local allocation away from sibling workspace state", async () => {
    const claimsRoot = makeTempDir("plexus-port-claims-");
    const projectRoot = makeTempDir("plexus-project-");
    const stateRoot = makeTempDir("plexus-state-");
    writeProjectConfig(projectRoot, {
      runtime: hostLocalRuntime(claimsRoot, 7200, 7201),
      images: [dynamicImage()],
    });
    saveProjectState(
      path.join(
        stateRoot,
        "projects",
        "project-123",
        "workspaces",
        "worktree-a",
        "state.json",
      ),
      {
        projectId: "project-123",
        projectName: "my-project",
        workspaceId: "worktree-a",
        targetId: "project-123--worktree-a",
        updatedAt: "2026-04-25T09:00:00.000Z",
        images: [
          {
            id: "dev",
            imageName: "MyProject-dev",
            assignedPort: 7200,
            pid: 1111,
            status: "running",
          },
        ],
      },
    );

    const result = await openProject({
      projectRoot,
      stateRoot,
      workspaceId: "worktree-b",
      pharoLauncherMcpClient: new FakePharoLauncherMcpClient([
        {
          pid: 2222,
          imageName: "MyProject-dev",
          commandLine: "PharoConsole.exe MyProject-dev.image",
        },
      ]),
      healthClient: new FakeHealthClient(true),
      now: fixedNow,
      sleep: async () => {},
      poll: { intervalMs: 0 },
    });

    expect(result.state.images[0].assignedPort).toBe(7201);
    await expect(listPortClaims({ claimsRoot })).resolves.toMatchObject([
      { projectId: "project-123", workspaceId: "worktree-b", assignedPort: 7201 },
    ]);
  });

  it("reclaims stale host-local image port claims before dynamic allocation", async () => {
    const claimsRoot = makeTempDir("plexus-port-claims-");
    const projectRoot = makeTempDir("plexus-project-");
    const stateRoot = makeTempDir("plexus-state-");
    writeProjectConfig(projectRoot, {
      runtime: hostLocalRuntime(claimsRoot, 7200, 7200),
      images: [dynamicImage()],
    });
    await claimPort({
      claimsRoot,
      projectId: "old-project",
      projectName: "Old Project",
      workspaceId: "old-worktree",
      targetId: "old-project--old-worktree",
      purpose: "image-mcp",
      imageId: "dev",
      requestedPort: 7200,
      pid: 999_999,
      claimId: "stale-image-claim",
      now: () => new Date("2026-04-25T09:00:00.000Z"),
    });

    const result = await openProject({
      projectRoot,
      stateRoot,
      workspaceId: "worktree-a",
      pharoLauncherMcpClient: new FakePharoLauncherMcpClient([
        {
          pid: 3003,
          imageName: "MyProject-dev",
          commandLine: "PharoConsole.exe MyProject-dev.image",
        },
      ]),
      healthClient: new FakeHealthClient(true),
      now: fixedNow,
      sleep: async () => {},
      poll: { intervalMs: 0 },
      portClaimChecks: {
        isProcessAlive: async () => false,
        isPortListening: async () => false,
      },
    });

    expect(result.state.images[0].assignedPort).toBe(7200);
    const claims = await listPortClaims({ claimsRoot });
    expect(claims).toMatchObject([
      {
        projectId: "project-123",
        workspaceId: "worktree-a",
        targetId: "project-123--worktree-a",
        purpose: "image-mcp",
        imageId: "dev",
        assignedPort: 7200,
        pid: 3003,
        claimedAt: "2026-04-25T10:00:00.000Z",
        updatedAt: "2026-04-25T10:00:00.000Z",
      },
    ]);
    expect(claims[0].claimId).not.toBe("stale-image-claim");
  });

  it("treats occupied host listener ports as unavailable before launch", async () => {
    const claimsRoot = makeTempDir("plexus-port-claims-");
    const projectRoot = makeTempDir("plexus-project-");
    const stateRoot = makeTempDir("plexus-state-");
    const server = await listenOnLoopback();
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected TCP listener address");
    }
    writeProjectConfig(projectRoot, {
      runtime: hostLocalRuntime(claimsRoot, address.port, address.port),
      images: [dynamicImage()],
    });
    const pharoLauncherMcpClient = new FakePharoLauncherMcpClient([
      {
        pid: 3333,
        imageName: "MyProject-dev",
        commandLine: "PharoConsole.exe MyProject-dev.image",
      },
    ]);

    try {
      await expect(
        openProject({
          projectRoot,
          stateRoot,
          workspaceId: "worktree-a",
          pharoLauncherMcpClient,
          healthClient: new FakeHealthClient(true),
          now: fixedNow,
          sleep: async () => {},
          poll: { intervalMs: 0 },
        }),
      ).rejects.toThrow(`No available port in range ${address.port}-${address.port}`);
      expect(pharoLauncherMcpClient.calls).toEqual([]);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("fails configured image MCP ports clearly when a host listener already owns the port", async () => {
    const claimsRoot = makeTempDir("plexus-port-claims-");
    const projectRoot = makeTempDir("plexus-project-");
    const stateRoot = makeTempDir("plexus-state-");
    const server = await listenOnLoopback();
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected TCP listener address");
    }
    writeProjectConfig(projectRoot, {
      runtime: hostLocalRuntime(claimsRoot, address.port, address.port),
      images: [
        {
          id: "dev",
          imageName: "MyProject-dev",
          active: true,
          mcp: {
            port: address.port,
            loadScript: "pharo/load-mcp.st",
          },
        },
      ],
    });
    const pharoLauncherMcpClient = new FakePharoLauncherMcpClient([
      {
        pid: 3333,
        imageName: "MyProject-dev",
        commandLine: "PharoConsole.exe MyProject-dev.image",
      },
    ]);

    try {
      await expect(
        openProject({
          projectRoot,
          stateRoot,
          workspaceId: "worktree-a",
          pharoLauncherMcpClient,
          healthClient: new FakeHealthClient(true),
          now: fixedNow,
          sleep: async () => {},
          poll: { intervalMs: 0 },
        }),
      ).rejects.toThrow(
        `Project project-123 image dev cannot use image MCP port ${address.port}: occupied by a host listener`,
      );
      expect(pharoLauncherMcpClient.calls).toEqual([]);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("allows duplicate configured image MCP ports across projects with explicit project-state coordination", async () => {
    const projectRootA = makeTempDir("plexus-project-a-");
    const projectRootB = makeTempDir("plexus-project-b-");
    const stateRootA = makeTempDir("plexus-state-a-");
    const stateRootB = makeTempDir("plexus-state-b-");
    writeProjectConfig(projectRootA, {
      name: "project-a",
      id: "project-a",
      runtime: projectStateRuntime(7200, 7209),
      images: [
        {
          id: "dev",
          imageName: "ProjectA-dev",
          active: true,
          mcp: {
            port: 7200,
            loadScript: "pharo/load-mcp.st",
          },
        },
      ],
    });
    writeProjectConfig(projectRootB, {
      name: "project-b",
      id: "project-b",
      runtime: projectStateRuntime(7200, 7209),
      images: [
        {
          id: "dev",
          imageName: "ProjectB-dev",
          active: true,
          mcp: {
            port: 7200,
            loadScript: "pharo/load-mcp.st",
          },
        },
      ],
    });

    const resultA = await openProject({
      projectRoot: projectRootA,
      stateRoot: stateRootA,
      workspaceId: "worktree-a",
      pharoLauncherMcpClient: new FakePharoLauncherMcpClient([
        {
          pid: 4001,
          imageName: "ProjectA-dev",
          commandLine: "PharoConsole.exe ProjectA-dev.image",
        },
      ]),
      healthClient: new FakeHealthClient(true),
      now: fixedNow,
      sleep: async () => {},
      poll: { intervalMs: 0 },
    });
    const resultB = await openProject({
      projectRoot: projectRootB,
      stateRoot: stateRootB,
      workspaceId: "worktree-b",
      pharoLauncherMcpClient: new FakePharoLauncherMcpClient([
        {
          pid: 4002,
          imageName: "ProjectB-dev",
          commandLine: "PharoConsole.exe ProjectB-dev.image",
        },
      ]),
      healthClient: new FakeHealthClient(true),
      now: fixedNow,
      sleep: async () => {},
      poll: { intervalMs: 0 },
    });

    expect(resultA.state.images[0]).toMatchObject({
      assignedPort: 7200,
      status: "running",
    });
    expect(resultB.state.images[0]).toMatchObject({
      assignedPort: 7200,
      status: "running",
    });
  });

  it("fails fixed-port host-local conflicts before launching and names the owner", async () => {
    const claimsRoot = makeTempDir("plexus-port-claims-");
    const projectRoot = makeTempDir("plexus-project-");
    const stateRoot = makeTempDir("plexus-state-");
    writeProjectConfig(projectRoot, {
      runtime: hostLocalRuntime(claimsRoot, 7200, 7209),
    });
    await claimPort({
      claimsRoot,
      projectId: "other-project",
      projectName: "Other Project",
      workspaceId: "other-worktree",
      targetId: "other-project--other-worktree",
      purpose: "image-mcp",
      imageId: "dev",
      requestedPort: 7123,
      now: fixedNow,
    });
    const pharoLauncherMcpClient = new FakePharoLauncherMcpClient([
      {
        pid: 4444,
        imageName: "MyProject-dev",
        commandLine: "PharoConsole.exe MyProject-dev.image",
      },
    ]);

    let rejection: unknown;
    try {
      await openProject({
        projectRoot,
        stateRoot,
        workspaceId: "worktree-a",
        pharoLauncherMcpClient,
        healthClient: new FakeHealthClient(true),
        now: fixedNow,
      });
    } catch (error) {
      rejection = error;
    }

    expect(rejection).toBeInstanceOf(Error);
    expect((rejection as Error).message).toContain(
      "Project project-123 image dev cannot use image MCP port 7123",
    );
    expect((rejection as Error).message).toContain(
      "other-project--other-worktree",
    );
    expect(pharoLauncherMcpClient.calls).toEqual([]);
  });

  it("keeps a fixed port claimed by the same compatible target", async () => {
    const claimsRoot = makeTempDir("plexus-port-claims-");
    const projectRoot = makeTempDir("plexus-project-");
    const stateRoot = makeTempDir("plexus-state-");
    writeProjectConfig(projectRoot, {
      runtime: hostLocalRuntime(claimsRoot, 7200, 7209),
    });
    await claimPort({
      claimsRoot,
      projectId: "project-123",
      projectName: "my-project",
      workspaceId: "worktree-a",
      targetId: "project-123--worktree-a",
      purpose: "image-mcp",
      imageId: "dev",
      requestedPort: 7123,
      now: fixedNow,
    });

    const result = await openProject({
      projectRoot,
      stateRoot,
      workspaceId: "worktree-a",
      pharoLauncherMcpClient: new FakePharoLauncherMcpClient([
        {
          pid: 5555,
          imageName: "MyProject-dev",
          commandLine: "PharoConsole.exe MyProject-dev.image",
        },
      ]),
      healthClient: new FakeHealthClient(true),
      now: fixedNow,
      sleep: async () => {},
      poll: { intervalMs: 0 },
    });

    expect(result.state.images[0]).toMatchObject({
      id: "dev",
      assignedPort: 7123,
      status: "running",
    });
  });

  it("releases host-local claims created for images that fail to open", async () => {
    const claimsRoot = makeTempDir("plexus-port-claims-");
    const projectRoot = makeTempDir("plexus-project-");
    const stateRoot = makeTempDir("plexus-state-");
    writeProjectConfig(projectRoot, {
      runtime: hostLocalRuntime(claimsRoot, 7200, 7209),
      images: [dynamicImage()],
    });

    await expect(
      openProject({
        projectRoot,
        stateRoot,
        workspaceId: "worktree-a",
        pharoLauncherMcpClient: new FakePharoLauncherMcpClient(
          [],
          new Error("launch failed"),
        ),
        healthClient: new FakeHealthClient(true),
        now: fixedNow,
        sleep: async () => {},
      }),
    ).rejects.toThrow(ProjectOpenError);

    await expect(inspectPortClaim({ claimsRoot, port: 7200 })).resolves.toEqual({
      status: "available",
      port: 7200,
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
