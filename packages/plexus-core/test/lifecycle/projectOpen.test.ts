import fs from "node:fs";
import { execFileSync } from "node:child_process";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  PharoLauncherMcpToolError,
  type PharoLauncherMcpToolClient,
} from "../../src/launcher/pharoLauncherMcpClient.js";
import type { PharoMcpHealthClient } from "../../src/mcp/pharoMcpHealth.js";
import {
  openProject,
  ProjectOpenError,
  type LauncherCommandResult,
  type LauncherProcess,
} from "../../src/lifecycle/projectOpen.js";
import {
  loadProjectState,
  saveProjectState,
  type ProjectState,
} from "../../src/workspace/projectState.js";
import { ScopedPharoLauncher } from "../../src/launcher/scopedPharoLauncherServer.js";
import { writeImageEndpointHandoffForScript } from "../support/imageEndpointHandoff.js";
import { defaultPharoMcpMetacelloRepositoryLocation } from "../../src/workspace/projectStartupScript.js";

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
  private processListCallCount = 0;

  constructor(
    private readonly processes: LauncherProcess[] | LauncherProcess[][] = [],
    private readonly launchError?: Error,
    private readonly onLaunch?: (argumentsValue: Record<string, unknown>) => void,
    private readonly imagesDir?: string,
    private readonly launchResult?:
      | LauncherCommandResult
      | Promise<LauncherCommandResult>,
    private readonly imageInfoMode: "paths" | "metadata-only" = "paths",
  ) {}

  private nextProcesses(): LauncherProcess[] {
    if (this.processes.length === 0) {
      this.processListCallCount += 1;
      return [];
    }

    if (Array.isArray(this.processes[0])) {
      const snapshots = this.processes as LauncherProcess[][];
      const index = Math.min(this.processListCallCount, snapshots.length - 1);
      this.processListCallCount += 1;
      return snapshots[index] ?? [];
    }

    this.processListCallCount += 1;
    return this.processes as LauncherProcess[];
  }

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
      writeImageEndpointHandoffForScript(argumentsValue.script);
      return (this.launchResult ?? { ok: true }) as T;
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
        data: this.nextProcesses(),
      } satisfies LauncherCommandResult<LauncherProcess[]>;

      return result as T;
    }

    if (name === "pharo_launcher_image_info") {
      const imageName = argumentsValue.imageName as string;
      return {
        ok: true,
        data: {
          name: imageName,
          ...(this.imageInfoMode === "paths"
            ? { imagePath: path.join(imageName, `${imageName}.image`) }
            : {}),
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

type FakeImageMcpFailure = Error | { result: unknown };

// Answers the way an image's MCP server does: prose content, failures flagged
// with isError, and no structured content, which it only returns when asked to.
class FakeImageMcpClient {
  readonly calls: ToolCall[] = [];
  private readonly registeredRepositoryNames: Set<string>;

  constructor(
    registeredRepositoryNames: string[] = [],
    private readonly failure?: FakeImageMcpFailure,
    private readonly failureTool?: string,
  ) {
    this.registeredRepositoryNames = new Set(registeredRepositoryNames);
  }

  async callTool(
    _image: { id: string },
    name: string,
    argumentsValue: Record<string, unknown> = {},
  ): Promise<unknown> {
    this.calls.push({ name, argumentsValue });
    const targetToolName =
      typeof argumentsValue.name === "string" ? argumentsValue.name : undefined;
    if (
      this.failure &&
      (!this.failureTool ||
        this.failureTool === name ||
        this.failureTool === targetToolName)
    ) {
      if (this.failure instanceof Error) {
        throw this.failure;
      }
      return this.failure.result;
    }

    const targetArguments =
      typeof argumentsValue.arguments === "object" &&
      argumentsValue.arguments !== null
        ? (argumentsValue.arguments as Record<string, unknown>)
        : {};
    const repositoryName =
      typeof targetArguments.name === "string" ? targetArguments.name : "";

    if (
      targetToolName === "repository_attach" ||
      targetToolName === "repository_update"
    ) {
      this.registeredRepositoryNames.add(repositoryName);
      return textResult(`Attached repository ${repositoryName}.`);
    }

    if (
      targetToolName === "repository_identity_verify" &&
      !this.registeredRepositoryNames.has(repositoryName)
    ) {
      return textResult(
        "No registered Iceberg repository matches the requested repository reference.",
        true,
      );
    }

    return textResult("ok");
  }
}

function textResult(text: string, isError = false): unknown {
  return isError
    ? { isError: true, content: [{ type: "text", text }] }
    : { content: [{ type: "text", text }] };
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

function initRepository(sourceRoot: string, packageNames: string[] = []): string {
  git(sourceRoot, ["init", "--initial-branch=main"]);
  fs.mkdirSync(path.join(sourceRoot, "src"), { recursive: true });
  fs.writeFileSync(
    path.join(sourceRoot, "src", "BaselineOfMyProject.class.st"),
    "baseline",
    "utf8",
  );
  for (const packageName of packageNames) {
    fs.mkdirSync(path.join(sourceRoot, "src", packageName), { recursive: true });
    fs.writeFileSync(
      path.join(sourceRoot, "src", packageName, "package.st"),
      `Package { #name : #'${packageName}' }\n`,
      "utf8",
    );
  }
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
        mcp: {
          port: 7123,
          loadScript: "pharo/load-mcp.st",
        },
      },
      {
        id: "baseline",
        imageName: "MyProject-baseline",
        mcp: {
          loadScript: "pharo/load-mcp.st",
        },
      },
    ],
    ...overrides,
  };

  fs.writeFileSync(
    path.join(projectRoot, "plexus.json"),
    JSON.stringify(config, null, 2),
    "utf8",
  );
}

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});


let restorePlexusHome: (() => void) | undefined;

afterEach(() => {
  restorePlexusHome?.();
  restorePlexusHome = undefined;
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
      imageIds: ["dev"],
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
          displayMode: "headless",
          script: scriptPath,
        },
      },
      {
        name: "pharo_launcher_process_list",
        argumentsValue: {},
      },
    ]);
    expect(healthClient.endpoints).toEqual([
      { transport: "http", host: "127.0.0.1", port: 7123, path: "/" },
    ]);
    expect(fs.existsSync(scriptPath)).toBe(true);
    expect(loadProjectState(result.statePath)).toEqual({
      projectId: "project-123",
      projectName: "my-project",
      workspaceId: "worktree-a",
      runtimeStatus: "running",
      updatedAt: "2026-04-25T10:00:00.000Z",
      images: [
        {
          id: "dev",
          imageName: "MyProject-dev",
          mcpServers: [
            {
              id: "dev",
              endpoint: {
                transport: "http",
                host: "127.0.0.1",
                port: 7123,
                path: "/",
              },
            },
          ],
          pid: 1234,
          status: "running",
        },
      ],
    });
  });

  it("persists and uses the workspace source path for relative startup loads", async () => {
    const projectRoot = makeTempDir("plexus-project-");
    const sourcePath = makeTempDir("plexus-source-");
    const stateRoot = makeTempDir("plexus-state-");
    writeProjectConfig(projectRoot);
    const pharoLauncherMcpClient = new FakePharoLauncherMcpClient([
      {
        pid: 1234,
        imageName: "MyProject-dev",
        commandLine: "PharoConsole.exe MyProject-dev.image",
      },
    ]);

    const result = await openProject({
      projectRoot,
      sourcePath,
      stateRoot,
      workspaceId: "worktree-a",
      pharoLauncherMcpClient,
      healthClient: new FakeHealthClient(true),
      now: fixedNow,
      sleep: async () => {},
      poll: {
        intervalMs: 0,
      },
      imageIds: ["dev"],
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
    const startupScript = fs.readFileSync(scriptPath, "utf8");

    expect(result.state.sourcePath).toBe(sourcePath);
    expect(startupScript).toContain(
      `${sourcePath.replaceAll("\\", "/")}/pharo/load-mcp.st`,
    );
    expect(startupScript).not.toContain(
      `${projectRoot.replaceAll("\\", "/")}/pharo/load-mcp.st`,
    );
  });

  it("launches active images with the configured display mode", async () => {
    const projectRoot = makeTempDir("plexus-project-");
    const stateRoot = makeTempDir("plexus-state-");
    writeProjectConfig(projectRoot, {
      images: [
        {
          id: "dev",
          imageName: "MyProject-dev",
          displayMode: "interactive",
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
        imageName: "MyProject-dev",
        commandLine: "Pharo.exe MyProject-dev.image",
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
      imageIds: ["dev"],
    });

    expect(pharoLauncherMcpClient.calls[0]).toMatchObject({
      name: "pharo_launcher_image_launch",
      argumentsValue: {
        imageName: "MyProject-dev",
        displayMode: "interactive",
      },
    });
    expect(result.state.images[0]).toMatchObject({
      id: "dev",
      status: "running",
      displayMode: "interactive",
    });
  });

  it("allows project open callers to override image display mode", async () => {
    const projectRoot = makeTempDir("plexus-project-");
    const stateRoot = makeTempDir("plexus-state-");
    writeProjectConfig(projectRoot);
    const pharoLauncherMcpClient = new FakePharoLauncherMcpClient([
      {
        pid: 1234,
        imageName: "MyProject-dev",
        commandLine: "Pharo.exe MyProject-dev.image",
      },
    ]);

    const result = await openProject({
      projectRoot,
      stateRoot,
      workspaceId: "worktree-a",
      displayMode: "interactive",
      pharoLauncherMcpClient,
      healthClient: new FakeHealthClient(true),
      now: fixedNow,
      sleep: async () => {},
      poll: {
        intervalMs: 0,
      },
      imageIds: ["dev"],
    });

    expect(pharoLauncherMcpClient.calls[0]).toMatchObject({
      name: "pharo_launcher_image_launch",
      argumentsValue: {
        displayMode: "interactive",
      },
    });
    expect(result.state.images[0]?.displayMode).toBe("interactive");
  });






  it("records Pharo MCP load failures reported by the startup script before health timeout", async () => {
    const projectRoot = makeTempDir("plexus-project-");
    const stateRoot = makeTempDir("plexus-state-");
    writeProjectConfig(projectRoot);
    const statusMessage = "Metacello could not resolve BaselineOfMCP";
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
          path.join(path.dirname(scriptPath), "pharo-mcp-load-dev.properties"),
          [
            "status=failed",
            "imageId=dev",
            "source=metacello",
            `loadScript=${path.join(projectRoot, "pharo", "load-mcp.st")}`,
            `repository=${defaultPharoMcpMetacelloRepositoryLocation}`,
            "baseline=MCP",
            `message=${statusMessage}`,
            "",
          ].join("\r"),
          "utf8",
        );
      },
    );
    const healthClient = new FakeHealthClient(false);

    await expect(
      openProject({
        projectRoot,
        stateRoot,
        workspaceId: "worktree-a",
        pharoLauncherMcpClient,
        healthClient,
        now: fixedNow,
        sleep: async () => {},
        poll: {
          intervalMs: 0,
          healthTimeoutMs: 60_000,
        },
        imageIds: ["dev"],
      }),
    ).rejects.toMatchObject({
      result: {
        ok: false,
        failures: [
          {
            imageId: "dev",
            message: `Pharo MCP load failed for image dev: ${statusMessage}`,
          },
        ],
      },
    });
    expect(healthClient.ports).toEqual([]);
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
    expect(failedState?.images[0].pharoMcpLoad).toMatchObject({
      state: "failed",
      source: "metacello",
      repository: defaultPharoMcpMetacelloRepositoryLocation,
      baseline: "MCP",
      error: statusMessage,
    });
  });

  it("keeps optional Pharo MCP startup images running without a route after load failure", async () => {
    const projectRoot = makeTempDir("plexus-project-");
    const stateRoot = makeTempDir("plexus-state-");
    writeProjectConfig(projectRoot, {
      images: [
        {
          id: "dev",
          imageName: "MyProject-dev",
          mcp: {
            port: 7123,
            loadScript: "pharo/load-mcp.st",
            startupMode: "optional",
          },
        },
      ],
    });
    const statusMessage = "Metacello could not resolve BaselineOfMCP";

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
          path.join(path.dirname(scriptPath), "pharo-mcp-load-dev.properties"),
          [
            "status=failed",
            "imageId=dev",
            "source=metacello",
            `repository=${defaultPharoMcpMetacelloRepositoryLocation}`,
            "baseline=MCP",
            `message=${statusMessage}`,
            "",
          ].join("\n"),
          "utf8",
        );
      },
    );
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
      imageIds: ["dev"],
    });

    expect(result.ok).toBe(true);
    expect(healthClient.ports).toEqual([]);
    expect(result.state.images[0]).toMatchObject({
      id: "dev",
      pid: 1234,
      status: "running",
      pharoMcpLoad: {
        state: "failed",
        source: "metacello",
        error: statusMessage,
      },
    });
    expect(result.state.images[0]).not.toHaveProperty("assignedPort");
    expect(result.state.images[0]).not.toHaveProperty("mcpServers");
  });

  it("does not persist inferred repository metadata for script-provided Pharo MCP loads", async () => {
    const projectRoot = makeTempDir("plexus-project-");
    const stateRoot = makeTempDir("plexus-state-");
    writeProjectConfig(projectRoot);
    const loadScriptPath = path.join(projectRoot, "pharo", "load-mcp.st");
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
          path.join(path.dirname(scriptPath), "pharo-mcp-load-dev.properties"),
          [
            "status=loaded",
            "imageId=dev",
            "source=loadScript",
            `loadScript=${loadScriptPath}`,
            "loadPolicy=always",
            `configuredRepositoryHint=${defaultPharoMcpMetacelloRepositoryLocation}`,
            "baseline=MCP",
            "",
          ].join("\n"),
          "utf8",
        );
      },
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
      imageIds: ["dev"],
    });

    const pharoMcpLoad = result.state.images[0].pharoMcpLoad;
    expect(pharoMcpLoad).toMatchObject({
      state: "loaded",
      source: "loadScript",
      loadScript: loadScriptPath,
      loadPolicy: "always",
      configuredRepositoryHint: defaultPharoMcpMetacelloRepositoryLocation,
      baseline: "MCP",
    });
    expect(pharoMcpLoad).not.toHaveProperty("repository");
    const savedState = loadProjectState(
      path.join(
        stateRoot,
        "projects",
        "project-123",
        "workspaces",
        "worktree-a",
        "state.json",
      ),
    );
    expect(savedState?.images[0].pharoMcpLoad).toEqual(pharoMcpLoad);
  });

  it("records the MCP endpoint the image bound and handed off", async () => {
    const claimsRoot = makeTempDir("plexus-port-claims-");
    const projectRoot = makeTempDir("plexus-project-");
    const stateRoot = makeTempDir("plexus-state-");
    writeProjectConfig(projectRoot, {
      runtime: hostLocalRuntime(claimsRoot, 7200, 7200),
      images: [
        {
          id: "dev",
          imageName: "MyProject-dev",
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
      imageIds: ["dev"],
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
    expect(fs.readFileSync(scriptPath, "utf8")).toContain("mcp port: 0.");
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
      mcpServers: [
        {
          id: "dev",
          endpoint: {
            transport: "http",
            host: "127.0.0.1",
            port: 7432,
            path: "/mcp",
          },
        },
      ],
      pid: 1234,
      status: "running",
    });
  });


  it("fails when endpoint handoff content is invalid", async () => {
    const projectRoot = makeTempDir("plexus-project-");
    const stateRoot = makeTempDir("plexus-state-");
    writeProjectConfig(projectRoot, {
      images: [
        {
          id: "dev",
          imageName: "MyProject-dev",
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
        imageIds: ["dev"],
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
        imageIds: ["dev"],
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
        imageCache: { enabled: true, networkPolicy: "online" },
      },
      images: [
        {
          id: "dev",
          imageName: "MyProject-{workspaceId}-dev",
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
        approvalId: "isolated-approval-1",
      },
      now: fixedNow,
      sleep: async () => {},
      poll: {
        intervalMs: 0,
      },
      imageIds: ["dev"],
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
          displayMode: "headless",
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
            stateRoot: path.join(homePath, "profiles", "pharo-launcher-mcp"),
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
          displayMode: "headless",
          script: scriptPath,
        },
      },
      {
        name: "pharo_launcher_process_list",
        argumentsValue: {},
      },
    ]);
    expect(healthClient.endpoints).toEqual([
      { transport: "http", host: "127.0.0.1", port: 7123, path: "/" },
    ]);
  });

  it("materializes an image a stale state file claims but the launcher lacks", async () => {
    const projectRoot = makeTempDir("plexus-project-");
    const stateRoot = makeTempDir("plexus-state-");
    const homePath = makeTempDir("plexus-home-");
    writeProjectConfig(projectRoot, {
      home: {
        path: homePath,
        imageCache: { enabled: true, networkPolicy: "online" },
      },
      images: [
        {
          id: "dev",
          imageName: "MyProject-{workspaceId}-dev",
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
    // An earlier config left a record for image id "dev" naming an image the
    // launcher never held under the name this config renders.
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
        updatedAt: "2026-04-25T09:00:00.000Z",
        images: [
          {
            id: "dev",
            imageName: "MyProject-worktree-a-dev-old",
            status: "stopped",
          },
        ],
      },
    );
    const pharoLauncherMcpClient = new FakePharoLauncherMcpClient([
      {
        pid: 1234,
        imageName: "MyProject-worktree-a-dev",
        commandLine: "PharoConsole.exe MyProject-worktree-a-dev.image",
      },
    ]);

    const result = await openProject({
      projectRoot,
      stateRoot,
      workspaceId: "worktree-a",
      pharoLauncherMcpClient,
      healthClient: new FakeHealthClient(true),
      homeImageCacheApproval: {
        approved: true,
        approvalId: "isolated-approval-2",
      },
      now: fixedNow,
      sleep: async () => {},
      poll: {
        intervalMs: 0,
      },
      imageIds: ["dev"],
    });

    expect(result.ok).toBe(true);
    expect(
      pharoLauncherMcpClient.calls.map((call) => call.name),
    ).toContain("pharo_launcher_image_copy_between_profiles");
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
      imageIds: ["dev"],
    });

    expect(result).toMatchObject({
      ok: true,
      failures: [],
      state: {
        projectId: "project-123",
        projectName: "my-project",
        workspaceId: "worktree-a",
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
      imageIds: ["dev"],
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
          mcp: {
            loadScript: "pharo/load-mcp.st",
          },
        },
        {
          id: "baseline",
          imageName: "MyProject-baseline",
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
          displayMode: "headless",
          script: baselineScriptPath,
        },
      },
      {
        name: "pharo_launcher_process_list",
        argumentsValue: {},
      },
    ]);
    expect(healthClient.endpoints).toEqual([
      { transport: "http", host: "127.0.0.1", port: 7432, path: "/" },
    ]);
    expect(fs.existsSync(baselineScriptPath)).toBe(true);
    expect(result.state.images).toEqual([
      {
        id: "baseline",
        imageName: "MyProject-baseline",
        mcpServers: [
          {
            id: "baseline",
            endpoint: {
              transport: "http",
              host: "127.0.0.1",
              port: 7432,
              path: "/",
            },
          },
        ],
        pid: 5678,
        status: "running",
      },
    ]);
  });

  it("leaves an image it did not open out of the state until something creates it", async () => {
    const projectRoot = makeTempDir("plexus-project-");
    const stateRoot = makeTempDir("plexus-state-");
    writeProjectConfig(projectRoot, {
      images: [
        {
          id: "dev",
          imageName: "MyProject-dev",
          mcp: { loadScript: "pharo/load-mcp.st" },
        },
        {
          id: "baseline",
          imageName: "MyProject-baseline",
          mcp: { loadScript: "pharo/load-mcp.st" },
        },
      ],
    });

    const firstOpen = await openProject({
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
      poll: { intervalMs: 0 },
    });

    const launcher = new ScopedPharoLauncher({
      projectRoot,
      stateRoot,
      workspaceId: "worktree-a",
      isPidAlive: () => false,
      isPortListening: async () => false,
    });
    const summaries = (await launcher.listImages()).images;

    // The rows list what is declared; the state file is where "something
    // created it" shows up, and only baseline was opened.
    expect(summaries.map((image) => image.imageId)).toEqual(["dev", "baseline"]);
    expect(
      loadProjectState(firstOpen.statePath)?.images.map((image) => image.id),
    ).toEqual(["baseline"]);

    await openProject({
      projectRoot,
      stateRoot,
      workspaceId: "worktree-a",
      imageIds: ["dev"],
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
      poll: { intervalMs: 0 },
    });

    expect(
      loadProjectState(firstOpen.statePath)?.images.map((image) => image.id),
    ).toEqual(["dev", "baseline"]);
  });

  it("blocks prepared image cache copies without explicit approval", async () => {
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
        imageIds: ["dev"],
      }),
    ).rejects.toThrow(ProjectOpenError);
    expect(pharoLauncherMcpClient.calls).toEqual([]);
  });

  it("copies prepared cache images before launching when approval is explicit", async () => {
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
        approvalId: "isolated-approval-1",
      },
      now: fixedNow,
      sleep: async () => {},
      poll: {
        intervalMs: 0,
      },
      imageIds: ["pharo-13-mcp", "dev"],
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
          displayMode: "headless",
          script: scriptPath,
        },
      },
      {
        name: "pharo_launcher_process_list",
        argumentsValue: {},
      },
    ]);
    expect(healthClient.endpoints).toEqual([
      { transport: "http", host: "127.0.0.1", port: 7123, path: "/" },
    ]);
  });

  it("opens known unsupported Pharo versions without waiting for MCP health", async () => {
    const projectRoot = makeTempDir("plexus-project-");
    const stateRoot = makeTempDir("plexus-state-");
    writeProjectConfig(projectRoot, {
      images: [
        {
          id: "legacy",
          imageName: "MyProject-legacy",
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
      imageIds: ["legacy"],
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
          displayMode: "headless",
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
        supportedMajorVersions: [12, 13, 14, 15],
      },
    });
    expect(result.state.images[0]).not.toHaveProperty("assignedPort");
  });

  it("opens images with Pharo MCP startup disabled without waiting for health", async () => {
    const projectRoot = makeTempDir("plexus-project-");
    const stateRoot = makeTempDir("plexus-state-");
    writeProjectConfig(projectRoot, {
      images: [
        {
          id: "plain",
          imageName: "MyProject-plain",
          mcp: {
            port: 7123,
            loadScript: "pharo/load-mcp.st",
            startupMode: "disabled",
          },
        },
      ],
    });
    const pharoLauncherMcpClient = new FakePharoLauncherMcpClient([
      {
        pid: 1234,
        imageName: "MyProject-plain",
        commandLine: "PharoConsole.exe MyProject-plain.image",
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
      imageIds: ["plain"],
    });

    const scriptPath = path.join(
      stateRoot,
      "projects",
      "project-123",
      "workspaces",
      "worktree-a",
      "scripts",
      "start-plain.st",
    );

    expect(result.ok).toBe(true);
    expect(healthClient.ports).toEqual([]);
    expect(fs.readFileSync(scriptPath, "utf8")).toContain(
      "Project image mcp.startupMode is disabled.",
    );
    expect(result.state.images[0]).toMatchObject({
      id: "plain",
      imageName: "MyProject-plain",
      pid: 1234,
      status: "running",
    });
    expect(result.state.images[0]).not.toHaveProperty("assignedPort");
    expect(result.state.images[0]).not.toHaveProperty("mcpServers");
  });


  it("keeps unselected scoped images in their previous runtime state", async () => {
    const projectRoot = makeTempDir("plexus-project-");
    const stateRoot = makeTempDir("plexus-state-");
    writeProjectConfig(projectRoot, {
      images: [
        {
          id: "dev",
          imageName: "MyProject-dev",
          mcp: {
            loadScript: "pharo/load-mcp.st",
          },
        },
        {
          id: "baseline",
          imageName: "MyProject-baseline",
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
        updatedAt: "2026-04-25T09:00:00.000Z",
        images: [
          {
            id: "dev",
            imageName: "MyProject-dev",
            pid: 1234,
            status: "running",
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
        pid: 1234,
        status: "running",
      },
      {
        id: "baseline",
        imageName: "MyProject-baseline",
        mcpServers: [
          {
            id: "baseline",
            endpoint: {
              transport: "http",
              host: "127.0.0.1",
              port: 7432,
              path: "/",
            },
          },
        ],
        pid: 5678,
        status: "running",
      },
    ]);
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
        imageIds: ["dev"],
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
        status: "failed",
      },
    ]);
  });

  it("preserves launcher diagnostics when image launch fails", async () => {
    const projectRoot = makeTempDir("plexus-project-");
    const stateRoot = makeTempDir("plexus-state-");
    writeProjectConfig(projectRoot, {
      images: [dynamicImage()],
    });

    const launchError = new PharoLauncherMcpToolError(
      "pharo-launcher-mcp tool failed: pharo_launcher_image_launch",
      "pharo_launcher_image_launch",
      {
        ok: false,
        diagnostic:
          "Profile-scoped image launch was refused because Pharo Launcher can use the default VM store.",
        action:
          "Launch only after the launcher can prove VM artifacts remain in the configured profile VM directory.",
      },
    );

    await expect(
      openProject({
        projectRoot,
        stateRoot,
        workspaceId: "worktree-a",
        pharoLauncherMcpClient: new FakePharoLauncherMcpClient([], launchError),
        healthClient: new FakeHealthClient(true),
        now: fixedNow,
        sleep: async () => {},
        imageIds: ["dev"],
      }),
    ).rejects.toMatchObject({
      result: {
        failures: [
          {
            imageId: "dev",
            imageName: "MyProject-dev",
            message:
              "pharo-launcher-mcp tool failed: pharo_launcher_image_launch",
            launcherToolName: "pharo_launcher_image_launch",
            diagnostic:
              "Profile-scoped image launch was refused because Pharo Launcher can use the default VM store.",
            action:
              "Launch only after the launcher can prove VM artifacts remain in the configured profile VM directory.",
            launcherResult: {
              ok: false,
            },
          },
        ],
      },
    });
  });

  it("continues when the process is visible before launch returns", async () => {
    const projectRoot = makeTempDir("plexus-project-");
    const stateRoot = makeTempDir("plexus-state-");
    writeProjectConfig(projectRoot);

    const launchedProcess: LauncherProcess = {
      pid: 1234,
      imageName: "MyProject-dev",
      commandLine: "PharoConsole MyProject-dev.image",
    };
    const pharoLauncherMcpClient = new FakePharoLauncherMcpClient(
      [launchedProcess],
      undefined,
      undefined,
      undefined,
      new Promise<LauncherCommandResult>(() => undefined),
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
        processTimeoutMs: 60_000,
        healthTimeoutMs: 60_000,
      },
      imageIds: ["dev"],
    });

    expect(result.state.images[0]).toMatchObject({
      id: "dev",
      pid: launchedProcess.pid,
      status: "running",
    });
  });

  it("fails fast when launch returns a pid that already exited", async () => {
    const projectRoot = makeTempDir("plexus-project-");
    const stateRoot = makeTempDir("plexus-state-");
    writeProjectConfig(projectRoot);

    const launchResult = {
      ok: true,
      raw: {
        stdout: [
          "Detached profile-scoped Pharo image pid 987654321.",
          "stdout: /tmp/myproject-dev.out.log",
          "stderr: /tmp/myproject-dev.err.log",
        ].join("\n"),
        stderr: "",
      },
    };
    const pharoLauncherMcpClient = new FakePharoLauncherMcpClient(
      [],
      undefined,
      undefined,
      undefined,
      launchResult,
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
          processTimeoutMs: 60_000,
          healthTimeoutMs: 60_000,
        },
        imageIds: ["dev"],
      }),
    ).rejects.toMatchObject({
      result: {
        failures: [
          {
            imageId: "dev",
            imageName: "MyProject-dev",
            message:
              "Image MyProject-dev process 987654321 exited before PLexus observed the launcher process. Launcher logs: /tmp/myproject-dev.out.log, /tmp/myproject-dev.err.log",
            launcherToolName: "pharo_launcher_image_launch",
            launcherResult: launchResult,
            process: {
              pid: 987654321,
              imageName: "MyProject-dev",
              commandLine: "pharo_launcher_image_launch MyProject-dev",
            },
          },
        ],
      },
    });
  });

  it("accepts a profile-scoped direct image pid when process list does not report it", async () => {
    const projectRoot = makeTempDir("plexus-project-");
    const stateRoot = makeTempDir("plexus-state-");
    writeProjectConfig(projectRoot);

    const launchResult = {
      ok: true,
      raw: {
        stdout: [
          `Detached profile-scoped Pharo image pid ${process.pid}.`,
          "stdout: /tmp/myproject-dev.out.log",
          "stderr: /tmp/myproject-dev.err.log",
        ].join("\n"),
        stderr: "",
      },
    };
    const pharoLauncherMcpClient = new FakePharoLauncherMcpClient(
      [],
      undefined,
      undefined,
      undefined,
      launchResult,
    );
    let healthChecks = 0;
    const healthClient: PharoMcpHealthClient = {
      async check(): Promise<boolean> {
        healthChecks += 1;
        return healthChecks > 1;
      },
    };

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
        processTimeoutMs: 60_000,
        healthTimeoutMs: 60_000,
      },
      imageIds: ["dev"],
    });

    expect(result.state.images[0]).toMatchObject({
      id: "dev",
      pid: process.pid,
      status: "running",
    });
    expect(healthChecks).toBe(2);
    expect(
      pharoLauncherMcpClient.calls.filter(
        (call) => call.name === "pharo_launcher_process_list",
      ),
    ).toHaveLength(2);
  });

  it("fails fast when a launched image exits before MCP health", async () => {
    const projectRoot = makeTempDir("plexus-project-");
    const stateRoot = makeTempDir("plexus-state-");
    writeProjectConfig(projectRoot);

    const launchedProcess: LauncherProcess = {
      pid: 987654321,
      imageName: "MyProject-dev",
      commandLine: "PharoConsole MyProject-dev.image",
    };
    const launchResult = {
      ok: true,
      raw: {
        stdout: [
          `Detached profile-scoped Pharo image pid ${launchedProcess.pid}.`,
          "stdout: /tmp/myproject-dev.out.log",
          "stderr: /tmp/myproject-dev.err.log",
        ].join("\n"),
        stderr: "",
      },
    };
    const pharoLauncherMcpClient = new FakePharoLauncherMcpClient(
      [[launchedProcess], []],
      undefined,
      undefined,
      undefined,
      launchResult,
    );

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
          processTimeoutMs: 60_000,
          healthTimeoutMs: 60_000,
        },
        imageIds: ["dev"],
      }),
    ).rejects.toMatchObject({
      result: {
        failures: [
          {
            imageId: "dev",
            imageName: "MyProject-dev",
            message: expect.stringContaining(
              "Image MyProject-dev process 987654321 exited before Pharo MCP became healthy or wrote its endpoint to ",
            ),
            launcherToolName: "pharo_launcher_image_launch",
            launcherResult: launchResult,
            process: launchedProcess,
          },
        ],
      },
    });

    const statePath = path.join(
      stateRoot,
      "projects",
      "project-123",
      "workspaces",
      "worktree-a",
      "state.json",
    );
    expect(loadProjectState(statePath)?.images[0]).toMatchObject({
      id: "dev",
      imageName: "MyProject-dev",
      pid: 987654321,
      status: "failed",
    });
    expect(
      pharoLauncherMcpClient.calls.filter(
        (call) => call.name === "pharo_launcher_process_list",
      ),
    ).toHaveLength(2);
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
        imageIds: ["dev"],
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
      status: "failed",
    });
  });
});
