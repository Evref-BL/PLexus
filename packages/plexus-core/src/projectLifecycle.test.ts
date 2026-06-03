import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createProjectLifecycleFromEnvironment,
  HttpGatewayRouteRegistry,
  HttpProjectLifecycleClient,
  PlexusProjectLifecycle,
  type ProjectLifecycleRemoteClient,
  type ProjectLifecycleRouteReference,
  type ProjectLifecycleRouteRegistration,
  type ProjectLifecycleRouteRegistry,
} from "./projectLifecycle.js";
import type { ProjectRemoteNodeConfig } from "./projectConfig.js";
import type { ProjectCloseOptions, ProjectCloseResult } from "./projectClose.js";
import type {
  ProjectGatewayProcessManager,
  ProjectGatewayProcessStartOptions,
  ProjectGatewayProcessStopOptions,
} from "./projectGateway.js";
import type { PharoLauncherMcpToolClient } from "./pharoLauncherMcpClient.js";
import { claimPort, inspectPortClaim } from "./portClaims.js";
import {
  ProjectOpenError,
  type ProjectOpenOptions,
  type ProjectOpenResult,
} from "./projectOpen.js";
import {
  defaultPlexusStateRoot,
  loadProjectState,
  saveProjectState,
  type ProjectState,
} from "./projectState.js";

const tempDirs: string[] = [];
const gitEnv = {
  GIT_AUTHOR_NAME: "PLexus Test",
  GIT_AUTHOR_EMAIL: "plexus-test@example.invalid",
  GIT_COMMITTER_NAME: "PLexus Test",
  GIT_COMMITTER_EMAIL: "plexus-test@example.invalid",
};

const runningState: ProjectState = {
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
};

const pharoEvalTool: Tool = {
  name: "pharo_eval",
  description: "Evaluate Smalltalk code in a routed Pharo image.",
  inputSchema: {
    type: "object",
    properties: {
      code: { type: "string" },
    },
    required: ["code"],
    additionalProperties: false,
  },
};

class FakeRouteRegistry implements ProjectLifecycleRouteRegistry {
  readonly registrations: ProjectLifecycleRouteRegistration[] = [];
  readonly unregisters: ProjectLifecycleRouteReference[] = [];

  async registerProjectRoute(
    input: ProjectLifecycleRouteRegistration,
  ): Promise<unknown> {
    this.registrations.push(input);
    return { ok: true, data: input };
  }

  async unregisterProjectRoute(
    input: ProjectLifecycleRouteReference,
  ): Promise<unknown> {
    this.unregisters.push(input);
    return { ok: true, data: { removed: true } };
  }

  async getRouteStatus(
    input: ProjectLifecycleRouteReference,
  ): Promise<unknown> {
    const registration = this.registrations.at(-1);
    return {
      ok: true,
      data: {
        projectId: input.projectId ?? runningState.projectId,
        workspaceId: input.workspaceId ?? runningState.workspaceId,
        targetId: input.targetId ?? runningState.targetId,
        projectRoot: registration?.projectRoot ?? "project-root",
        statePath: registration?.statePath ?? "state.json",
      },
    };
  }
}

class UnreachableRouteRegistry extends FakeRouteRegistry {
  async unregisterProjectRoute(
    input: ProjectLifecycleRouteReference,
  ): Promise<unknown> {
    this.unregisters.push(input);
    throw new Error("fetch failed");
  }
}

class MissingRouteRegistry implements ProjectLifecycleRouteRegistry {
  registerProjectRoute(): Promise<unknown> {
    return Promise.resolve({ ok: true, data: {} });
  }

  unregisterProjectRoute(): Promise<unknown> {
    return Promise.resolve({ ok: true, data: { removed: false } });
  }

  getRouteStatus(input: ProjectLifecycleRouteReference): Promise<unknown> {
    return Promise.resolve({
      ok: false,
      error: `No route is registered for: ${input.targetId ?? "unknown"}`,
    });
  }
}

class FakeRemoteLifecycleClient implements ProjectLifecycleRemoteClient {
  readonly calls: Array<{
    toolName: string;
    argumentsValue: Record<string, unknown>;
  }> = [];

  async callTool<T>(
    toolName: string,
    argumentsValue: Record<string, unknown>,
  ) {
    this.calls.push({ toolName, argumentsValue });
    return {
      ok: true,
      data: {
        forwarded: toolName,
        argumentsValue,
      } as T,
    };
  }
}

class FakeGatewayProcessManager implements ProjectGatewayProcessManager {
  readonly starts: ProjectGatewayProcessStartOptions[] = [];
  readonly stops: ProjectGatewayProcessStopOptions[] = [];

  constructor(
    private readonly pid = 9010,
    private readonly events: string[] = [],
  ) {}

  start(
    options: ProjectGatewayProcessStartOptions,
  ): { pid: number } {
    this.events.push(`start:${options.port}`);
    this.starts.push(options);
    return { pid: this.pid };
  }

  stop(options: ProjectGatewayProcessStopOptions): void {
    this.stops.push(options);
  }
}

class FakeHomeImageCacheClient implements PharoLauncherMcpToolClient {
  readonly calls: Array<{ name: string; argumentsValue: Record<string, unknown> }> =
    [];

  async callTool<T = unknown>(
    name: string,
    argumentsValue: Record<string, unknown> = {},
  ): Promise<T> {
    this.calls.push({ name, argumentsValue });
    return { ok: true } as T;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
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

function runtimeWithProjectStateImagePorts(
  runtime: unknown,
): Record<string, unknown> {
  const defaults = projectStateRuntime();
  if (!isRecord(runtime)) {
    return defaults;
  }

  return {
    ...defaults,
    ...runtime,
    imagePorts: isRecord(runtime.imagePorts)
      ? {
          ...defaults.imagePorts,
          ...runtime.imagePorts,
        }
      : defaults.imagePorts,
  };
}

function writeProjectConfig(
  projectRoot: string,
  overrides: Record<string, unknown> = {},
): void {
  const runtime = runtimeWithProjectStateImagePorts(overrides.runtime);
  fs.writeFileSync(
    path.join(projectRoot, "plexus.project.json"),
    JSON.stringify(
      {
        id: "project-123",
        name: "my-project",
        runtime,
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
        ],
        ...Object.fromEntries(
          Object.entries(overrides).filter(([key]) => key !== "runtime"),
        ),
      },
      null,
      2,
    ),
    "utf8",
  );
}

function statePath(stateRoot: string): string {
  return statePathForWorkspace(stateRoot, "worktree-a");
}

function statePathForWorkspace(stateRoot: string, workspaceId: string): string {
  return path.join(
    stateRoot,
    "projects",
    "project-123",
    "workspaces",
    workspaceId,
    "state.json",
  );
}

function writeHomeImageCacheManifest(homePath: string, key: string): string {
  const entryDirectory = path.join(homePath, "image-cache", "entries", key);
  const manifestPath = path.join(entryDirectory, "manifest.json");
  fs.mkdirSync(entryDirectory, { recursive: true });
  fs.writeFileSync(
    manifestPath,
    JSON.stringify(
      {
        schemaVersion: 1,
        key,
        createdAt: "2026-05-19T10:00:00.000Z",
        updatedAt: "2026-05-19T10:00:00.000Z",
        cacheImageName: "PlexusHomeCache-test",
        source: {
          kind: "template",
          templateName: "Pharo 13.0 - 64bit",
        },
        pharoMcp: {
          support: {
            status: "supported",
            actualMajorVersion: 13,
            supportedMajorVersions: [12, 13, 14],
            metadataKey: "io.github.evref-bl/pharo",
            reason: "Pharo 13 is supported for Pharo MCP preparation.",
          },
          preparationStatus: "prepared",
        },
        paths: {
          entryDirectory,
          manifestPath,
          lockPath: path.join(homePath, "image-cache", "locks", key),
          preparationScriptPath: path.join(entryDirectory, "prepare.st"),
          profileStateRoot: path.join(
            homePath,
            "profiles",
            "pharo-launcher-mcp",
            "image-cache",
          ),
        },
      },
      null,
      2,
    ),
    "utf8",
  );

  return manifestPath;
}

interface CapturedGatewayRequest {
  url: string;
  body: Record<string, unknown>;
}

function makeGatewayFetch(
  requests: CapturedGatewayRequest[],
): typeof fetch {
  return (async (input, init) => {
    requests.push({
      url: String(input),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });

    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "test",
        result: {
          ok: true,
          data: {
            projectId: runningState.projectId,
            workspaceId: runningState.workspaceId,
            targetId: runningState.targetId,
          },
        },
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  }) as typeof fetch;
}

function makeGatewayAndImageFetch(
  requests: CapturedGatewayRequest[],
  tools: Tool[],
): typeof fetch {
  return (async (input, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    requests.push({
      url: String(input),
      body,
    });

    if (body.method === "tools/list") {
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          result: { tools },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }

    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "test",
        result: {
          ok: true,
          data: {
            projectId: runningState.projectId,
            workspaceId: runningState.workspaceId,
            targetId: runningState.targetId,
          },
        },
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  }) as typeof fetch;
}

function clonedRunningState(): ProjectState {
  return {
    ...runningState,
    images: runningState.images.map((image) => ({ ...image })),
  };
}

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  vi.unstubAllGlobals();
});

describe("project lifecycle tools", () => {
  it("opens a project through core and registers the gateway route", async () => {
    const projectRoot = makeTempDir("plexus-project-");
    const stateRoot = makeTempDir("plexus-state-");
    const routeRegistry = new FakeRouteRegistry();
    const lifecycle = new PlexusProjectLifecycle({
      routeRegistry,
      projectOpen: async (
        options: ProjectOpenOptions,
      ): Promise<ProjectOpenResult> => ({
        ok: true,
        projectRoot: path.resolve(options.projectRoot),
        statePath: statePath(stateRoot),
        state: runningState,
        failures: [],
      }),
    });

    const result = await lifecycle.handleTool("plexus_project_open", {
      projectPath: projectRoot,
      stateRoot,
      workspaceId: "worktree-a",
    });

    expect(result).toMatchObject({ ok: true });
    expect(routeRegistry.registrations).toEqual([
      {
        projectRoot: path.resolve(projectRoot),
        statePath: statePath(stateRoot),
        state: runningState,
      },
    ]);
  });

  it("closes a project through core and unregisters the gateway route", async () => {
    const projectRoot = makeTempDir("plexus-project-");
    const routeRegistry = new FakeRouteRegistry();
    const lifecycle = new PlexusProjectLifecycle({
      routeRegistry,
      projectClose: async (
        options: ProjectCloseOptions,
      ): Promise<ProjectCloseResult> => ({
        ok: true,
        projectRoot: path.resolve(options.projectRoot),
        statePath: "state.json",
        state: runningState,
        stoppedImages: runningState.images,
        repositoryWorkspaceCleanups: [],
        failures: [],
      }),
    });

    const result = await lifecycle.handleTool("plexus_project_close", {
      projectPath: projectRoot,
      workspaceId: "worktree-a",
    });

    expect(result).toMatchObject({ ok: true });
    expect(routeRegistry.unregisters).toEqual([
      { targetId: "project-123--worktree-a" },
    ]);
  });

  it("cleans a project scope and unregisters the gateway route when confirmed", async () => {
    const projectRoot = makeTempDir("plexus-project-");
    const stateRoot = makeTempDir("plexus-state-");
    writeProjectConfig(projectRoot);
    saveProjectState(statePath(stateRoot), {
      ...runningState,
      runtimeStatus: "idle",
      images: runningState.images.map((image) => ({
        ...image,
        status: "stopped",
        pid: undefined,
      })),
    });
    const routeRegistry = new FakeRouteRegistry();
    const lifecycle = new PlexusProjectLifecycle({
      routeRegistry,
      gateway: {
        checks: {
          isPortListening: () => false,
          isProcessAlive: () => false,
        },
      },
    });

    const result = await lifecycle.handleTool("plexus_project_cleanup", {
      projectPath: projectRoot,
      stateRoot,
      workspaceId: "worktree-a",
      confirm: true,
      deleteLauncherImages: false,
    });

    expect(result).toMatchObject({
      ok: true,
      data: {
        confirmed: true,
        resources: expect.arrayContaining([
          expect.objectContaining({
            kind: "route",
            id: "project-123--worktree-a",
            status: "cleaned",
          }),
        ]),
      },
    });
    expect(routeRegistry.unregisters).toEqual([
      { targetId: "project-123--worktree-a" },
    ]);
  });

  it("deletes stopped scoped images when route cleanup endpoint is gone", async () => {
    const projectRoot = makeTempDir("plexus-project-");
    const stateRoot = makeTempDir("plexus-state-");
    writeProjectConfig(projectRoot);
    saveProjectState(statePath(stateRoot), {
      ...runningState,
      runtimeStatus: "idle",
      images: runningState.images.map((image) => ({
        ...image,
        status: "stopped",
        pid: undefined,
        creation: {
          source: {
            kind: "template",
            templateName: "Pharo 13",
          },
          cleanupPolicy: "workspace_cleanup_only",
          route: {
            serverName: "pharo_gateway",
            targetKey: "targetId",
            imageArgument: "imageId",
            imageId: image.id,
          },
        },
      })),
    });
    const routeRegistry = new UnreachableRouteRegistry();
    const launcherClient = new FakeHomeImageCacheClient();
    const lifecycle = new PlexusProjectLifecycle({
      routeRegistry,
      pharoLauncherMcpClient: launcherClient,
      gateway: {
        checks: {
          isPortListening: () => false,
          isProcessAlive: () => false,
        },
      },
    });

    const result = await lifecycle.handleTool("plexus_project_cleanup", {
      projectPath: projectRoot,
      stateRoot,
      workspaceId: "worktree-a",
      confirm: true,
    });

    expect(result).toMatchObject({
      ok: true,
      data: {
        confirmed: true,
        failures: [],
        deletedLauncherImages: ["MyProject-dev"],
        resources: expect.arrayContaining([
          expect.objectContaining({
            kind: "launcher-image",
            imageId: "dev",
            status: "cleaned",
          }),
          expect.objectContaining({
            kind: "route",
            id: "project-123--worktree-a",
            status: "skipped",
            reason: expect.stringContaining("fetch failed"),
          }),
        ]),
      },
    });
    expect(routeRegistry.unregisters).toEqual([
      { targetId: "project-123--worktree-a" },
    ]);
    expect(launcherClient.calls).toEqual([
      {
        name: "pharo_launcher_image_delete",
        argumentsValue: {
          imageName: "MyProject-dev",
          force: true,
          confirm: true,
        },
      },
    ]);
    expect(loadProjectState(statePath(stateRoot))?.images).toEqual([]);
  });

  it("reports lifecycle status from project runtime state without starting images", async () => {
    const projectRoot = makeTempDir("plexus-project-");
    const stateRoot = makeTempDir("plexus-state-");
    writeProjectConfig(projectRoot);
    saveProjectState(statePath(stateRoot), runningState);
    const lifecycle = new PlexusProjectLifecycle({
      routeRegistry: new FakeRouteRegistry(),
    });

    const result = await lifecycle.handleTool("plexus_project_status", {
      projectPath: projectRoot,
      stateRoot,
      workspaceId: "worktree-a",
    });

    expect(result).toMatchObject({
      ok: true,
      data: {
        projectId: "project-123",
        workspaceId: "worktree-a",
        targetId: "project-123--worktree-a",
        context: {
          scope: {
            projectId: "project-123",
            workspaceId: "worktree-a",
            targetId: "project-123--worktree-a",
          },
          workspace: {
            projectRoot,
            source: {
              path: projectRoot,
              policy: "caller-managed",
              defaultLoadSource: true,
            },
            state: {
              root: stateRoot,
              path: statePath(stateRoot),
            },
            routes: {
              serverName: "pharo_gateway",
              imageArgument: "imageId",
            },
            cleanup: {
              policy: "workspace_cleanup_only",
            },
          },
          images: [
            {
              imageId: "dev",
              status: "running",
              route: {
                serverName: "pharo_gateway",
                requiredArgument: "imageId",
                imageId: "dev",
              },
            },
          ],
        },
      },
    });
    expect(result.data).not.toHaveProperty("state");
    expect(result.data).not.toHaveProperty("gateway");
    expect(result.data).not.toHaveProperty("route");
    expect(result.data).not.toHaveProperty("diagnostics");
    expect(JSON.stringify(result.data)).not.toContain("MyProject-dev");
    expect(JSON.stringify(result.data)).not.toContain("7123");
    expect(JSON.stringify(result.data)).not.toContain("1234");
  });

  it("reports configured remote PLexus topology in status diagnostics", async () => {
    const projectRoot = makeTempDir("plexus-project-");
    const stateRoot = makeTempDir("plexus-state-");
    writeProjectConfig(projectRoot, {
      runtime: {
        nodeId: "host-a",
        remoteNodes: [
          {
            id: "remote-a",
            parentNodeId: "host-a",
            projectMcpUrl: "http://remote-a.local:7332/mcp",
            gatewayMcpUrl: "http://remote-a.local:7331/mcp",
            workspaces: [
              {
                workspaceId: "worktree-a",
                remoteWorkspaceId: "remote-worktree-a",
              },
            ],
          },
        ],
      },
    });
    const lifecycle = new PlexusProjectLifecycle({
      routeRegistry: new FakeRouteRegistry(),
    });

    const result = await lifecycle.handleTool("plexus_project_status", {
      projectPath: projectRoot,
      stateRoot,
      workspaceId: "local-worktree",
      includeDiagnostics: true,
    });

    expect(result).toMatchObject({
      ok: true,
      data: {
        diagnostics: {
          remoteTopology: {
            nodeId: "host-a",
            policy: "flat-tree",
            status: "flat",
            remoteNodeIds: ["remote-a"],
            remoteNodes: [
              {
                id: "remote-a",
                parentNodeId: "host-a",
                mappedWorkspaceIds: ["worktree-a"],
              },
            ],
          },
        },
      },
    });
  });

  it("forwards lifecycle tools to mapped remote PLexus nodes", async () => {
    const projectRoot = makeTempDir("plexus-project-");
    const remoteClient = new FakeRemoteLifecycleClient();
    const selectedRemoteNodes: ProjectRemoteNodeConfig[] = [];
    writeProjectConfig(projectRoot, {
      runtime: {
        nodeId: "host-a",
        remoteNodes: [
          {
            id: "remote-a",
            parentNodeId: "host-a",
            projectMcpUrl: "http://remote-a.local:7332/mcp",
            gatewayMcpUrl: "http://remote-a.local:7331/mcp",
            workspaces: [
              {
                workspaceId: "worktree-a",
                remoteWorkspaceId: "remote-worktree-a",
                remoteProjectPath: "/remote/project-a",
                targets: [
                  {
                    targetId: "task-a-dev",
                    remoteTargetId: "remote-task-a-dev",
                  },
                ],
              },
            ],
          },
        ],
      },
    });
    const lifecycle = new PlexusProjectLifecycle({
      remoteClientFactory: (remoteNode) => {
        selectedRemoteNodes.push(remoteNode);
        return remoteClient;
      },
      projectOpen: vi.fn(async (_options: ProjectOpenOptions) => {
        throw new Error("local open should not run");
      }),
      projectClose: vi.fn(async (_options: ProjectCloseOptions) => {
        throw new Error("local close should not run");
      }),
    });

    await lifecycle.handleTool("plexus_project_open", {
      projectPath: projectRoot,
      sourcePath: "/host/source",
      stateRoot: "/host/state",
      workspaceId: "worktree-a",
      targetId: "task-a-dev",
      displayMode: "headless",
    });
    await lifecycle.handleTool("plexus_project_status", {
      projectPath: projectRoot,
      stateRoot: "/host/state",
      workspaceId: "worktree-a",
      targetId: "task-a-dev",
      includeDiagnostics: true,
    });
    await lifecycle.handleTool("plexus_project_close", {
      projectPath: projectRoot,
      stateRoot: "/host/state",
      workspaceId: "worktree-a",
      repositoryWorkspaceCleanupPolicy: "archive",
      repositoryWorkspaceArchiveRoot: "/host/archive",
    });
    await lifecycle.handleTool("plexus_project_cleanup", {
      projectPath: projectRoot,
      stateRoot: "/host/state",
      workspaceId: "worktree-a",
      confirm: true,
      deleteStateFile: true,
      deleteLauncherImages: false,
    });

    expect(selectedRemoteNodes.map((node) => node.id)).toEqual([
      "remote-a",
      "remote-a",
      "remote-a",
      "remote-a",
    ]);
    expect(remoteClient.calls).toEqual([
      {
        toolName: "plexus_project_open",
        argumentsValue: {
          projectPath: "/remote/project-a",
          sourcePath: "/host/source",
          workspaceId: "remote-worktree-a",
          targetId: "remote-task-a-dev",
          displayMode: "headless",
        },
      },
      {
        toolName: "plexus_project_status",
        argumentsValue: {
          projectPath: "/remote/project-a",
          workspaceId: "remote-worktree-a",
          targetId: "remote-task-a-dev",
          refreshHealth: false,
          includeDiagnostics: true,
        },
      },
      {
        toolName: "plexus_project_close",
        argumentsValue: {
          projectPath: "/remote/project-a",
          workspaceId: "remote-worktree-a",
          repositoryWorkspaceCleanupPolicy: "archive",
          repositoryWorkspaceArchiveRoot: "/host/archive",
        },
      },
      {
        toolName: "plexus_project_cleanup",
        argumentsValue: {
          projectPath: "/remote/project-a",
          workspaceId: "remote-worktree-a",
          confirm: true,
          deleteStateFile: true,
          deleteLauncherImages: false,
        },
      },
    ]);
  });

  it("registers host gateway routes for remote PLexus opens", async () => {
    const projectRoot = makeTempDir("plexus-project-");
    const stateRoot = makeTempDir("plexus-state-");
    const routeRegistry = new FakeRouteRegistry();
    const remoteOpenResult: ProjectOpenResult = {
      ok: true,
      projectRoot: "/remote/project-a",
      statePath: "/remote/state/project-a/worktree-a/state.json",
      failures: [],
      state: {
        projectId: "remote-project",
        projectName: "remote-project",
        workspaceId: "remote-worktree-a",
        targetId: "remote-task-a-dev",
        updatedAt: "2026-04-25T10:00:00.000Z",
        images: [
          {
            id: "dev",
            imageName: "RemoteProject-dev",
            status: "running",
          },
        ],
      },
    };
    const remoteClient: ProjectLifecycleRemoteClient = {
      async callTool<T>(toolName: string, argumentsValue: Record<string, unknown>) {
        expect(toolName).toBe("plexus_project_open");
        expect(argumentsValue).toMatchObject({
          projectPath: "/remote/project-a",
          workspaceId: "remote-worktree-a",
          targetId: "remote-task-a-dev",
        });
        return { ok: true, data: remoteOpenResult as T };
      },
    };
    writeProjectConfig(projectRoot, {
      runtime: {
        nodeId: "host-a",
        remoteNodes: [
          {
            id: "remote-a",
            parentNodeId: "host-a",
            projectMcpUrl: "http://remote-a.local:7332/mcp",
            gatewayMcpUrl: "http://remote-a.local:7331/mcp",
            workspaces: [
              {
                workspaceId: "worktree-a",
                remoteWorkspaceId: "remote-worktree-a",
                remoteProjectPath: "/remote/project-a",
                targets: [
                  {
                    targetId: "task-a-dev",
                    remoteTargetId: "remote-task-a-dev",
                  },
                ],
              },
            ],
          },
        ],
      },
    });
    const lifecycle = new PlexusProjectLifecycle({
      routeRegistry,
      remoteClientFactory: () => remoteClient,
    });

    const result = await lifecycle.handleTool("plexus_project_open", {
      projectPath: projectRoot,
      sourcePath: "/host/source",
      stateRoot,
      workspaceId: "worktree-a",
      targetId: "task-a-dev",
    });

    expect(result).toMatchObject({
      ok: true,
      data: {
        projectRoot,
        statePath: statePath(stateRoot),
        state: {
          projectId: "project-123",
          projectName: "my-project",
          workspaceId: "worktree-a",
          targetId: "task-a-dev",
          sourcePath: "/host/source",
          remoteGateway: {
            remoteNodeId: "remote-a",
            endpoint: {
              transport: "http",
              host: "remote-a.local",
              port: 7331,
              path: "/mcp",
            },
            projectId: "remote-project",
            workspaceId: "remote-worktree-a",
            targetId: "remote-task-a-dev",
          },
        },
      },
    });
    expect(routeRegistry.registrations).toHaveLength(1);
    expect(routeRegistry.registrations[0]).toMatchObject({
      projectRoot,
      statePath: statePath(stateRoot),
      state: {
        projectId: "project-123",
        workspaceId: "worktree-a",
        targetId: "task-a-dev",
        remoteGateway: {
          remoteNodeId: "remote-a",
        },
        images: [
          {
            id: "dev",
            status: "running",
          },
        ],
      },
    });
    expect(loadProjectState(statePath(stateRoot))).toMatchObject({
      projectId: "project-123",
      workspaceId: "worktree-a",
      targetId: "task-a-dev",
      remoteGateway: {
        remoteNodeId: "remote-a",
      },
    });
  });

  it("unregisters host gateway routes after remote close and confirmed cleanup", async () => {
    const projectRoot = makeTempDir("plexus-project-");
    const stateRoot = makeTempDir("plexus-state-");
    const routeRegistry = new FakeRouteRegistry();
    const remoteOpenResult: ProjectOpenResult = {
      ok: true,
      projectRoot: "/remote/project-a",
      statePath: "/remote/state/project-a/worktree-a/state.json",
      failures: [],
      state: {
        projectId: "remote-project",
        projectName: "remote-project",
        workspaceId: "remote-worktree-a",
        targetId: "remote-task-a-dev",
        updatedAt: "2026-04-25T10:00:00.000Z",
        images: [
          {
            id: "dev",
            imageName: "RemoteProject-dev",
            status: "running",
          },
        ],
      },
    };
    const remoteClient: ProjectLifecycleRemoteClient = {
      async callTool<T>(toolName: string) {
        if (toolName === "plexus_project_open") {
          return { ok: true, data: remoteOpenResult as T };
        }
        if (toolName === "plexus_project_close") {
          return {
            ok: true,
            data: {
              ok: true,
              projectRoot: "/remote/project-a",
              statePath: "/remote/state/project-a/worktree-a/state.json",
              stoppedImages: [],
              repositoryWorkspaceCleanups: [],
              failures: [],
            } as T,
          };
        }
        if (toolName === "plexus_project_cleanup") {
          return {
            ok: true,
            data: {
              ok: true,
              projectRoot: "/remote/project-a",
              stateRoot: "/remote/state",
              statePath: "/remote/state/project-a/worktree-a/state.json",
              confirmed: true,
              deleteStateFile: true,
              deleteLauncherImages: false,
              resources: [],
              failures: [],
              stoppedImages: [],
              repositoryWorkspaceCleanups: [],
              deletedLauncherImages: [],
              gatewayClosed: false,
            } as T,
          };
        }
        throw new Error(`Unexpected remote tool: ${toolName}`);
      },
    };
    writeProjectConfig(projectRoot, {
      runtime: {
        nodeId: "host-a",
        remoteNodes: [
          {
            id: "remote-a",
            parentNodeId: "host-a",
            projectMcpUrl: "http://remote-a.local:7332/mcp",
            gatewayMcpUrl: "http://remote-a.local:7331/mcp",
            workspaces: [
              {
                workspaceId: "worktree-a",
                remoteWorkspaceId: "remote-worktree-a",
                remoteProjectPath: "/remote/project-a",
                targets: [
                  {
                    targetId: "task-a-dev",
                    remoteTargetId: "remote-task-a-dev",
                  },
                ],
              },
            ],
          },
        ],
      },
    });
    const lifecycle = new PlexusProjectLifecycle({
      routeRegistry,
      remoteClientFactory: () => remoteClient,
    });

    await lifecycle.handleTool("plexus_project_open", {
      projectPath: projectRoot,
      stateRoot,
      workspaceId: "worktree-a",
      targetId: "task-a-dev",
    });
    await lifecycle.handleTool("plexus_project_close", {
      projectPath: projectRoot,
      stateRoot,
      workspaceId: "worktree-a",
    });
    await lifecycle.handleTool("plexus_project_open", {
      projectPath: projectRoot,
      stateRoot,
      workspaceId: "worktree-a",
      targetId: "task-a-dev",
    });
    await lifecycle.handleTool("plexus_project_cleanup", {
      projectPath: projectRoot,
      stateRoot,
      workspaceId: "worktree-a",
      confirm: true,
      deleteStateFile: true,
      deleteLauncherImages: false,
    });

    expect(routeRegistry.unregisters).toEqual([
      {
        projectId: "project-123",
        workspaceId: "worktree-a",
      },
      {
        projectId: "project-123",
        workspaceId: "worktree-a",
      },
    ]);
    expect(loadProjectState(statePath(stateRoot))).toBeUndefined();
  });

  it("decodes remote project lifecycle MCP responses over HTTP", async () => {
    const requests: Array<{
      url: string;
      body: Record<string, unknown>;
    }> = [];
    const client = new HttpProjectLifecycleClient({
      url: "http://remote-a.local:7332/mcp",
      fetch: (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        requests.push({
          url: String(input),
          body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        });

        return new Response(
          JSON.stringify({
            result: {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    ok: true,
                    data: {
                      projectId: "project-123",
                    },
                  }),
                },
              ],
            },
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
            },
          },
        );
      }) as typeof fetch,
    });

    await expect(
      client.callTool("plexus_project_status", {
        projectPath: "/remote/project",
      }),
    ).resolves.toEqual({
      ok: true,
      data: {
        projectId: "project-123",
      },
    });
    expect(requests).toMatchObject([
      {
        url: "http://remote-a.local:7332/mcp",
        body: {
          method: "tools/call",
          params: {
            name: "plexus_project_status",
            arguments: {
              projectPath: "/remote/project",
            },
          },
        },
      },
    ]);
  });

  it("reports load-script repository hints without treating them as actual repositories", async () => {
    const projectRoot = makeTempDir("plexus-project-");
    const stateRoot = makeTempDir("plexus-state-");
    const loadScriptPath = path.join(projectRoot, "pharo", "load-mcp.st");
    writeProjectConfig(projectRoot);
    saveProjectState(statePath(stateRoot), {
      ...runningState,
      images: [
        {
          ...runningState.images[0],
          pharoMcpLoad: {
            state: "loaded",
            statusPath: path.join(
              stateRoot,
              "projects",
              "project-123",
              "workspaces",
              "worktree-a",
              "scripts",
              "pharo-mcp-load-dev.properties",
            ),
            source: "loadScript",
            loadScript: loadScriptPath,
            configuredRepositoryHint: "github://Evref-BL/MCP:main/src",
            baseline: "MCP",
          },
        },
      ],
    });
    const lifecycle = new PlexusProjectLifecycle({
      routeRegistry: new FakeRouteRegistry(),
    });

    const result = await lifecycle.handleTool("plexus_project_status", {
      projectPath: projectRoot,
      stateRoot,
      workspaceId: "worktree-a",
      includeDiagnostics: true,
    });

    const pharoMcpLoad = result.data.state?.images[0].pharoMcpLoad;
    expect(pharoMcpLoad).toMatchObject({
      state: "loaded",
      source: "loadScript",
      loadScript: loadScriptPath,
      configuredRepositoryHint: "github://Evref-BL/MCP:main/src",
      baseline: "MCP",
    });
    expect(pharoMcpLoad).not.toHaveProperty("repository");
  });

  it("uses PLEXUS_STATE_ROOT as the lifecycle default state root", async () => {
    const projectRoot = makeTempDir("plexus-project-");
    const envStateRoot = makeTempDir("plexus-env-state-");
    const failedState: ProjectState = {
      ...runningState,
      images: [
        {
          ...runningState.images[0],
          status: "failed",
        },
      ],
    };
    writeProjectConfig(projectRoot);
    saveProjectState(statePath(defaultPlexusStateRoot(projectRoot)), runningState);
    saveProjectState(statePath(envStateRoot), failedState);
    const lifecycle = createProjectLifecycleFromEnvironment({
      PLEXUS_STATE_ROOT: envStateRoot,
    } as NodeJS.ProcessEnv);

    const result = await lifecycle.handleTool("plexus_project_status", {
      projectPath: projectRoot,
      workspaceId: "worktree-a",
      includeDiagnostics: true,
    });

    expect(result).toMatchObject({
      ok: true,
      data: {
        stateRoot: envStateRoot,
        statePath: statePath(envStateRoot),
        state: {
          images: [
            {
              id: "dev",
              status: "failed",
            },
          ],
        },
        diagnostics: {
          scope: {
            sourcePath: projectRoot,
            stateRoot: envStateRoot,
            statePath: statePath(envStateRoot),
          },
        },
      },
    });
  });

  it("reports failed workspace images with scoped rescue affordances", async () => {
    const projectRoot = makeTempDir("plexus-project-");
    const stateRoot = makeTempDir("plexus-state-");
    const failedState: ProjectState = {
      ...runningState,
      images: [
        {
          ...runningState.images[0],
          status: "failed",
          imagePath: "/profiles/project-123/images/MyProject-dev/MyProject-dev.image",
          ombuDirectoryPath:
            "/profiles/project-123/images/MyProject-dev/pharo-local/ombu-sessions",
        },
      ],
    };
    writeProjectConfig(projectRoot);
    saveProjectState(statePath(stateRoot), failedState);
    const lifecycle = new PlexusProjectLifecycle({
      routeRegistry: new FakeRouteRegistry(),
      gateway: {
        checks: {
          isPortListening: async () => false,
        },
      },
    });

    const result = await lifecycle.handleTool("plexus_project_status", {
      projectPath: projectRoot,
      stateRoot,
      workspaceId: "worktree-a",
      includeDiagnostics: true,
    });

    expect(result).toMatchObject({
      ok: true,
      data: {
        diagnostics: {
          imageRecovery: [
            {
              imageId: "dev",
              imageName: "MyProject-dev",
              status: "failed",
              message: "Image dev is failed; use scoped rescue before raw cleanup.",
              paths: {
                imagePath:
                  "/profiles/project-123/images/MyProject-dev/MyProject-dev.image",
                ombuDirectoryPath:
                  "/profiles/project-123/images/MyProject-dev/pharo-local/ombu-sessions",
              },
              actions: [
                {
                  operation: "plan",
                  toolName: "plexus_rescue_image",
                  arguments: {
                    projectPath: projectRoot,
                    stateRoot,
                    workspaceId: "worktree-a",
                    sourceImageId: "dev",
                    operation: "plan",
                  },
                },
                {
                  operation: "prepareTarget",
                  toolName: "plexus_rescue_image",
                  arguments: {
                    projectPath: projectRoot,
                    stateRoot,
                    workspaceId: "worktree-a",
                    sourceImageId: "dev",
                    operation: "prepareTarget",
                  },
                },
              ],
            },
          ],
        },
      },
    });
  });

  it("reports the persisted workspace source path in status context and diagnostics", async () => {
    const projectRoot = makeTempDir("plexus-project-");
    const sourcePath = makeTempDir("plexus-source-");
    const stateRoot = makeTempDir("plexus-state-");
    writeProjectConfig(projectRoot);
    saveProjectState(statePath(stateRoot), {
      ...runningState,
      sourcePath,
    });
    const lifecycle = new PlexusProjectLifecycle({
      routeRegistry: new FakeRouteRegistry(),
      gateway: {
        checks: {
          isPortListening: async () => false,
        },
      },
    });

    const result = await lifecycle.handleTool("plexus_project_status", {
      projectPath: projectRoot,
      stateRoot,
      workspaceId: "worktree-a",
      includeDiagnostics: true,
    });

    expect(result).toMatchObject({
      ok: true,
      data: {
        context: {
          workspace: {
            source: {
              path: path.resolve(sourcePath),
              policy: "caller-managed",
              defaultLoadSource: true,
            },
          },
        },
        diagnostics: {
          scope: {
            sourcePath: path.resolve(sourcePath),
          },
        },
      },
    });
  });

  it("keeps two project workspaces isolated by state, source, ports, and routes", async () => {
    const projectRoot = makeTempDir("plexus-project-");
    const stateRoot = makeTempDir("plexus-state-");
    const sourceA = makeTempDir("plexus-source-a-");
    const sourceB = makeTempDir("plexus-source-b-");
    const stateAPath = statePathForWorkspace(stateRoot, "worktree-a");
    const stateBPath = statePathForWorkspace(stateRoot, "worktree-b");
    const stateA: ProjectState = {
      ...runningState,
      workspaceId: "worktree-a",
      targetId: "project-123--worktree-a",
      sourcePath: sourceA,
      images: [
        {
          id: "dev",
          imageName: "MyProject-worktree-a-dev",
          assignedPort: 7123,
          pid: 1234,
          status: "running",
        },
      ],
    };
    const stateB: ProjectState = {
      ...runningState,
      workspaceId: "worktree-b",
      targetId: "project-123--worktree-b",
      sourcePath: sourceB,
      images: [
        {
          id: "dev",
          imageName: "MyProject-worktree-b-dev",
          assignedPort: 7124,
          pid: 5678,
          status: "running",
        },
      ],
    };
    const routesByTarget = new Map(
      [stateA, stateB].map((state) => [
        state.targetId,
        {
          projectId: state.projectId,
          workspaceId: state.workspaceId,
          targetId: state.targetId,
          projectRoot,
          statePath:
            state.workspaceId === "worktree-a" ? stateAPath : stateBPath,
          images: state.images.map((image) => ({
            id: image.id,
            imageName: image.imageName,
            port: image.assignedPort,
            status: image.status,
            routable: {
              ok: true,
              code: "ready",
              message: "Image is routable",
            },
          })),
        },
      ]),
    );
    writeProjectConfig(projectRoot, {
      images: [
        {
          id: "dev",
          imageName: "MyProject-{workspaceId}-dev",
          active: true,
          mcp: {
            loadScript: "pharo/load-mcp.st",
          },
        },
      ],
    });
    saveProjectState(stateAPath, stateA);
    saveProjectState(stateBPath, stateB);
    const lifecycle = new PlexusProjectLifecycle({
      routeRegistry: {
        async registerProjectRoute() {
          return { ok: true, data: {} };
        },
        async unregisterProjectRoute() {
          return { ok: true, data: {} };
        },
        async getRouteStatus(input) {
          return {
            ok: true,
            data: routesByTarget.get(input.targetId ?? ""),
          };
        },
      },
      gateway: {
        checks: {
          isPortListening: async () => false,
        },
      },
    });

    const statusA = await lifecycle.handleTool("plexus_project_status", {
      projectPath: projectRoot,
      stateRoot,
      workspaceId: "worktree-a",
      includeDiagnostics: true,
    });
    const statusB = await lifecycle.handleTool("plexus_project_status", {
      projectPath: projectRoot,
      stateRoot,
      workspaceId: "worktree-b",
      includeDiagnostics: true,
    });

    expect(statusA).toMatchObject({
      ok: true,
      data: {
        workspaceId: "worktree-a",
        targetId: "project-123--worktree-a",
        statePath: stateAPath,
        context: {
          workspace: {
            source: {
              path: sourceA,
            },
          },
          images: [
            {
              imageId: "dev",
              status: "running",
            },
          ],
        },
        route: {
          statePath: stateAPath,
          images: [
            {
              imageName: "MyProject-worktree-a-dev",
              port: 7123,
            },
          ],
        },
        diagnostics: {
          imageMcpPorts: [
            {
              imageId: "dev",
              imageName: "MyProject-worktree-a-dev",
              port: 7123,
            },
          ],
          routeTable: {
            statePath: stateAPath,
            routableImages: [
              {
                imageId: "dev",
                port: 7123,
              },
            ],
          },
        },
      },
    });
    expect(statusB).toMatchObject({
      ok: true,
      data: {
        workspaceId: "worktree-b",
        targetId: "project-123--worktree-b",
        statePath: stateBPath,
        context: {
          workspace: {
            source: {
              path: sourceB,
            },
          },
        },
        route: {
          statePath: stateBPath,
          images: [
            {
              imageName: "MyProject-worktree-b-dev",
              port: 7124,
            },
          ],
        },
        diagnostics: {
          imageMcpPorts: [
            {
              imageId: "dev",
              imageName: "MyProject-worktree-b-dev",
              port: 7124,
            },
          ],
          routeTable: {
            statePath: stateBPath,
            routableImages: [
              {
                imageId: "dev",
                port: 7124,
              },
            ],
          },
        },
      },
    });
    expect(statusA.data?.statePath).not.toBe(statusB.data?.statePath);
    expect(statusA.data?.route).not.toMatchObject(statusB.data?.route ?? {});
  });

  it("reports PLexus home image cache entries", async () => {
    const projectRoot = makeTempDir("plexus-project-");
    const homePath = makeTempDir("plexus-home-");
    const key = "a".repeat(64);
    writeProjectConfig(projectRoot, {
      home: {
        path: homePath,
        imageCache: { enabled: true, networkPolicy: "online" },
      },
    });
    writeHomeImageCacheManifest(homePath, key);
    const lifecycle = new PlexusProjectLifecycle();

    const result = await lifecycle.handleTool("plexus_home_image_cache_status", {
      projectPath: projectRoot,
    });

    expect(result).toMatchObject({
      ok: true,
      data: {
        projectRoot: path.resolve(projectRoot),
        homePath,
        cacheRoot: path.join(homePath, "image-cache"),
        entries: [
          {
            key,
            status: "ok",
            cacheImageName: "PlexusHomeCache-test",
            preparationStatus: "prepared",
            supportStatus: "supported",
          },
        ],
      },
    });
  });

  it("flushes PLexus home image cache entries and deletes home-profile launcher images", async () => {
    const projectRoot = makeTempDir("plexus-project-");
    const homePath = makeTempDir("plexus-home-");
    const key = "b".repeat(64);
    const homeImageCacheClient = new FakeHomeImageCacheClient();
    writeProjectConfig(projectRoot, {
      home: {
        path: homePath,
        imageCache: { enabled: true, networkPolicy: "online" },
      },
    });
    writeHomeImageCacheManifest(homePath, key);
    const lifecycle = new PlexusProjectLifecycle({
      homeImageCacheClient,
    });

    const result = await lifecycle.handleTool("plexus_home_image_cache_flush", {
      projectPath: projectRoot,
      key,
      confirm: true,
    });

    expect(result).toMatchObject({
      ok: true,
      data: {
        projectRoot: path.resolve(projectRoot),
        homePath,
        deletedImages: ["PlexusHomeCache-test"],
        entries: [],
        flushedEntries: [
          expect.objectContaining({
            key,
            exists: true,
          }),
        ],
      },
    });
    expect(homeImageCacheClient.calls).toEqual([
      {
        name: "pharo_launcher_image_delete",
        argumentsValue: {
          imageName: "PlexusHomeCache-test",
          force: true,
          confirm: true,
        },
      },
    ]);
    expect(
      fs.existsSync(path.join(homePath, "image-cache", "entries", key)),
    ).toBe(false);
  });

  it("returns raw lifecycle state only when diagnostics are requested", async () => {
    const projectRoot = makeTempDir("plexus-project-");
    const stateRoot = makeTempDir("plexus-state-");
    const stateFilePath = statePath(stateRoot);
    writeProjectConfig(projectRoot);
    saveProjectState(stateFilePath, runningState);
    const lifecycle = new PlexusProjectLifecycle({
      routeRegistry: new FakeRouteRegistry(),
    });

    const result = await lifecycle.handleTool("plexus_project_status", {
      projectPath: projectRoot,
      stateRoot,
      workspaceId: "worktree-a",
      includeDiagnostics: true,
    });

    expect(result).toMatchObject({
      ok: true,
      data: {
        projectRoot: path.resolve(projectRoot),
        statePath: stateFilePath,
        state: runningState,
        route: {
          projectId: "project-123",
          workspaceId: "worktree-a",
          targetId: "project-123--worktree-a",
        },
          diagnostics: {
          toolRuntime: {
            packageName: "@evref-bl/plexus-core",
            packageVersion: expect.any(String),
            modulePath: expect.any(String),
            entrypointPath: expect.any(String),
            projectConfigSchema: {
              identityField: "id",
              legacyIdentityField: "kanban.projectId",
            },
          },
          imageMcpPorts: [
            {
              imageId: "dev",
              port: 7123,
              pid: 1234,
            },
          ],
        },
      },
    });
  });

  it("reports endpoint-based image routing diagnostics", async () => {
    const projectRoot = makeTempDir("plexus-project-");
    const stateRoot = makeTempDir("plexus-state-");
    const endpoint = {
      transport: "http" as const,
      host: "127.0.0.1",
      port: 7432,
      path: "/mcp",
    };
    const stateFilePath = statePath(stateRoot);
    const endpointState: ProjectState = {
      ...runningState,
      images: [
        {
          id: "dev",
          imageName: "MyProject-dev",
          mcpEndpoint: endpoint,
          pid: 1234,
          status: "running",
        },
      ],
    };
    writeProjectConfig(projectRoot);
    saveProjectState(stateFilePath, endpointState);
    const lifecycle = new PlexusProjectLifecycle({
      routeRegistry: {
        async registerProjectRoute() {
          return { ok: true, data: {} };
        },
        async unregisterProjectRoute() {
          return { ok: true, data: {} };
        },
        async getRouteStatus() {
          return {
            ok: true,
            data: {
              projectId: endpointState.projectId,
              workspaceId: endpointState.workspaceId,
              targetId: endpointState.targetId,
              projectRoot,
              statePath: stateFilePath,
              images: [
                {
                  id: "dev",
                  imageName: "MyProject-dev",
                  mcpEndpoint: endpoint,
                  status: "running",
                  routable: {
                    ok: true,
                    code: "ready",
                    message: "Image is routable",
                  },
                },
              ],
            },
          };
        },
      },
    });

    const result = await lifecycle.handleTool("plexus_project_status", {
      projectPath: projectRoot,
      stateRoot,
      workspaceId: "worktree-a",
      includeDiagnostics: true,
    });

    expect(result).toMatchObject({
      ok: true,
      data: {
        diagnostics: {
          imageMcpPorts: [
            {
              imageId: "dev",
              mcpEndpoint: endpoint,
              routingMode: "endpoint",
              status: "running",
            },
          ],
          routeTable: {
            status: "registered",
            routableImages: [
              {
                imageId: "dev",
                mcpEndpoint: endpoint,
                routingMode: "endpoint",
                status: "running",
              },
            ],
          },
        },
      },
    });
    expect(result.data?.diagnostics.imageMcpPorts[0]).not.toHaveProperty("port");
    expect(result.data?.diagnostics.routeTable.routableImages[0]).not.toHaveProperty(
      "port",
    );
  });

  it("reconciles dead project-local gateway state during health refresh", async () => {
    const projectRoot = makeTempDir("plexus-project-");
    const stateRoot = makeTempDir("plexus-state-");
    const claimsRoot = makeTempDir("plexus-claims-");
    const stateFilePath = statePath(stateRoot);
    const gatewayClaim = await claimPort({
      claimsRoot,
      projectId: "project-123",
      projectName: "my-project",
      workspaceId: "worktree-a",
      targetId: "project-123--worktree-a",
      purpose: "gateway",
      requestedPort: 8133,
      pid: 987654321,
      claimId: "gateway-claim",
    });
    const staleGateway = {
      mode: "project-local" as const,
      endpoint: "http://127.0.0.1:8133/mcp",
      controlEndpoint: "http://127.0.0.1:8133/control-mcp",
      host: "127.0.0.1",
      port: 8133,
      portRange: {
        start: 8133,
        end: 8133,
      },
      routePath: "/mcp",
      controlPath: "/control-mcp",
      owningProjectId: "project-123",
      managedByProject: true,
      pid: 987654321,
      claim: {
        claimsRoot,
        claimId: gatewayClaim.claimId,
        assignedPort: gatewayClaim.assignedPort,
      },
    };
    writeProjectConfig(projectRoot, {
      runtime: {
        gateway: {
          mode: "project-local",
          host: "127.0.0.1",
          portRange: {
            start: 8133,
            end: 8133,
          },
          agentMcpPath: "/mcp",
          routeControlMcpPath: "/control-mcp",
        },
      },
    });
    saveProjectState(stateFilePath, {
      ...runningState,
      gateway: staleGateway,
    });
    const lifecycle = new PlexusProjectLifecycle({
      gateway: {
        now: () => new Date("2026-05-24T11:50:00.000Z"),
        checks: {
          isProcessAlive: async () => false,
          isPortListening: async () => false,
        },
      },
    });

    const result = await lifecycle.handleTool("plexus_project_status", {
      projectPath: projectRoot,
      stateRoot,
      workspaceId: "worktree-a",
      refreshHealth: true,
      includeDiagnostics: true,
    });

    expect(result).toMatchObject({
      ok: true,
      data: {
        gateway: {
          mode: "project-local",
          host: "127.0.0.1",
          portRange: {
            start: 8133,
            end: 8133,
          },
          managedByProject: true,
        },
        diagnostics: {
          runtime: {
            status: "degraded",
            health: "degraded",
            reason: expect.stringContaining("gateway is dead"),
          },
          gateway: {
            mode: "project-local",
            status: "dead",
            health: "degraded",
            reason: expect.stringContaining("gateway state is dead"),
            managedByProject: true,
            stale: {
              endpoint: "http://127.0.0.1:8133/mcp",
              controlEndpoint: "http://127.0.0.1:8133/control-mcp",
              port: 8133,
              pid: 987654321,
              claim: {
                claimsRoot,
                claimId: gatewayClaim.claimId,
                assignedPort: gatewayClaim.assignedPort,
              },
            },
            repair: {
              allowed: true,
              toolName: "plexus_project_open",
              arguments: {
                projectPath: projectRoot,
                stateRoot,
                workspaceId: "worktree-a",
                targetId: "project-123--worktree-a",
              },
            },
          },
          routeTable: {
            status: "gateway-dead",
            targetId: "project-123--worktree-a",
            routableImages: [],
            error: expect.stringContaining("gateway state is dead"),
          },
          agentAccess: {
            expectedSurface: "pharo_gateway",
            gatewayRouted: false,
            portsHiddenFromAgents: true,
            reason: expect.stringContaining("Reopen the project"),
          },
        },
      },
    });
    expect(result.data?.gateway).not.toHaveProperty("endpoint");
    expect(result.data?.gateway).not.toHaveProperty("controlEndpoint");
    expect(result.data?.gateway).not.toHaveProperty("pid");
    expect(result.data?.state.gateway).toBeUndefined();
    expect(loadProjectState(stateFilePath)?.gateway).toBeUndefined();
    await expect(
      inspectPortClaim({
        claimsRoot,
        port: 8133,
        checks: {
          isProcessAlive: async () => false,
          isPortListening: async () => false,
        },
      }),
    ).resolves.toMatchObject({
      status: "available",
      port: 8133,
    });
  });

  it("reports running project state with missing project-local gateway state as repairable", async () => {
    const projectRoot = makeTempDir("plexus-project-");
    const stateRoot = makeTempDir("plexus-state-");
    const stateFilePath = statePath(stateRoot);
    writeProjectConfig(projectRoot, {
      runtime: {
        gateway: {
          mode: "project-local",
          host: "127.0.0.1",
          port: 8133,
          agentMcpPath: "/mcp",
          routeControlMcpPath: "/control-mcp",
        },
      },
    });
    saveProjectState(stateFilePath, runningState);
    const lifecycle = new PlexusProjectLifecycle({
      gateway: {
        now: () => new Date("2026-05-24T11:50:00.000Z"),
        checks: {
          isPortListening: async () => false,
        },
        fetch: async () => {
          throw new Error("gateway fetch should not be attempted");
        },
      },
    });

    const result = await lifecycle.handleTool("plexus_project_status", {
      projectPath: projectRoot,
      stateRoot,
      workspaceId: "worktree-a",
      refreshHealth: true,
      includeDiagnostics: true,
    });

    expect(result).toMatchObject({
      ok: true,
      data: {
        diagnostics: {
          runtime: {
            status: "degraded",
            health: "degraded",
            reason: expect.stringContaining("gateway is dead"),
          },
          gateway: {
            mode: "project-local",
            status: "dead",
            health: "degraded",
            reason: expect.stringContaining("gateway state is dead"),
            managedByProject: true,
            stale: {
              endpoint: "http://127.0.0.1:8133/mcp",
              controlEndpoint: "http://127.0.0.1:8133/control-mcp",
              port: 8133,
            },
            repair: {
              allowed: true,
              toolName: "plexus_project_open",
              arguments: {
                projectPath: projectRoot,
                stateRoot,
                workspaceId: "worktree-a",
                targetId: "project-123--worktree-a",
              },
            },
          },
          routeTable: {
            status: "gateway-dead",
            targetId: "project-123--worktree-a",
            routableImages: [],
            error: expect.stringContaining("gateway state is dead"),
          },
        },
      },
    });
    expect(result.data?.gateway).not.toHaveProperty("endpoint");
    expect(result.data?.gateway).not.toHaveProperty("controlEndpoint");
    expect(loadProjectState(stateFilePath)?.gateway).toBeUndefined();
  });

  it("reports partially failed project state with running images and missing project-local gateway state as repairable", async () => {
    const projectRoot = makeTempDir("plexus-project-");
    const stateRoot = makeTempDir("plexus-state-");
    const stateFilePath = statePath(stateRoot);
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
        },
        {
          id: "stale-feature",
          imageName: "MyProject-stale-feature",
          active: true,
          mcp: {
            port: 7124,
            loadScript: "pharo/load-mcp.st",
          },
        },
      ],
      runtime: {
        gateway: {
          mode: "project-local",
          host: "127.0.0.1",
          port: 8133,
          agentMcpPath: "/mcp",
          routeControlMcpPath: "/control-mcp",
        },
      },
    });
    saveProjectState(stateFilePath, {
      ...runningState,
      runtimeStatus: "failed",
      images: [
        ...clonedRunningState().images,
        {
          id: "stale-feature",
          imageName: "MyProject-stale-feature",
          status: "failed",
        },
      ],
    });
    const lifecycle = new PlexusProjectLifecycle({
      gateway: {
        now: () => new Date("2026-05-24T11:50:00.000Z"),
        checks: {
          isPortListening: async () => false,
        },
        fetch: async () => {
          throw new Error("gateway fetch should not be attempted");
        },
      },
    });

    const result = await lifecycle.handleTool("plexus_project_status", {
      projectPath: projectRoot,
      stateRoot,
      workspaceId: "worktree-a",
      refreshHealth: true,
      includeDiagnostics: true,
    });

    expect(result).toMatchObject({
      ok: true,
      data: {
        diagnostics: {
          runtime: {
            status: "degraded",
            health: "degraded",
            reason: expect.stringContaining("gateway is dead"),
          },
          gateway: {
            status: "dead",
            health: "degraded",
            repair: {
              allowed: true,
              toolName: "plexus_project_open",
            },
          },
          routeTable: {
            status: "gateway-dead",
            targetId: "project-123--worktree-a",
          },
          agentAccess: {
            expectedSurface: "pharo_gateway",
            gatewayRouted: false,
          },
        },
      },
    });
    expect(result.data?.gateway).not.toHaveProperty("endpoint");
    expect(result.data?.gateway).not.toHaveProperty("controlEndpoint");
    expect(loadProjectState(stateFilePath)?.gateway).toBeUndefined();
  });

  it("re-registers stale gateway routes that point at a different state path", async () => {
    const projectRoot = makeTempDir("plexus-project-");
    const stateRoot = makeTempDir("plexus-state-");
    const stateFilePath = statePath(stateRoot);
    const staleStatePath = path.join(makeTempDir("plexus-stale-state-"), "state.json");
    const registrations: ProjectLifecycleRouteRegistration[] = [];
    let route = {
      projectId: runningState.projectId,
      workspaceId: runningState.workspaceId,
      targetId: runningState.targetId,
      projectRoot,
      statePath: staleStatePath,
      images: [
        {
          id: "dev",
          imageName: "MyProject-dev",
          port: 7123,
          status: "running",
          routable: {
            ok: true,
            code: "ready",
            message: "Image is routable",
          },
        },
      ],
    };
    const lifecycle = new PlexusProjectLifecycle({
      routeRegistry: {
        async registerProjectRoute(input) {
          registrations.push(input);
          route = {
            ...route,
            projectRoot: input.projectRoot,
            statePath: input.statePath,
          };
          return { ok: true, data: route };
        },
        async unregisterProjectRoute() {
          return { ok: true, data: {} };
        },
        async getRouteStatus() {
          return { ok: true, data: route };
        },
      },
    });
    writeProjectConfig(projectRoot);
    saveProjectState(stateFilePath, runningState);

    const result = await lifecycle.handleTool("plexus_project_status", {
      projectPath: projectRoot,
      stateRoot,
      workspaceId: "worktree-a",
      includeDiagnostics: true,
    });

    expect(registrations).toHaveLength(1);
    expect(registrations[0]).toMatchObject({
      projectRoot: path.resolve(projectRoot),
      statePath: stateFilePath,
      state: runningState,
    });
    expect(result).toMatchObject({
      ok: true,
      data: {
        route: {
          statePath: stateFilePath,
        },
        diagnostics: {
          routeTable: {
            status: "registered",
            statePath: stateFilePath,
          },
        },
      },
    });
  });

  it("includes config schema and runtime identity diagnostics on config failures", async () => {
    const projectRoot = makeTempDir("plexus-project-");
    fs.writeFileSync(
      path.join(projectRoot, "plexus.project.json"),
      JSON.stringify(
        {
          name: "my-project",
          images: [],
        },
        null,
        2,
      ),
      "utf8",
    );
    const lifecycle = new PlexusProjectLifecycle({
      routeRegistry: new FakeRouteRegistry(),
    });

    const result = await lifecycle.handleTool("plexus_project_status", {
      projectPath: projectRoot,
      includeDiagnostics: true,
    });

    expect(result).toMatchObject({
      ok: false,
      error: "Invalid Plexus project config",
      diagnostics: {
        toolRuntime: {
          packageName: "@evref-bl/plexus-core",
          packageVersion: expect.any(String),
          modulePath: expect.any(String),
          entrypointPath: expect.any(String),
          projectConfigSchema: {
            identityField: "id",
            legacyIdentityField: "kanban.projectId",
          },
        },
        projectConfig: {
          issues: ["config.id must be a non-empty string"],
        },
      },
    });
  });

  it("includes project open failures in tool diagnostics", async () => {
    const failureResult: ProjectOpenResult = {
      ok: false,
      projectRoot: "/tmp/project",
      statePath: "/tmp/state/project.json",
      state: {
        ...runningState,
        images: [
          {
            id: "dev",
            imageName: "MyProject-dev",
            assignedPort: 7123,
            status: "failed",
          },
        ],
      },
      failures: [
        {
          imageId: "dev",
          imageName: "MyProject-dev",
          message: "Timed out waiting for Pharo MCP health on port 7123",
        },
      ],
    };
    const lifecycle = new PlexusProjectLifecycle({
      projectOpen: async () => {
        throw new ProjectOpenError(
          "One or more project images failed to open",
          failureResult,
        );
      },
    });

    const result = await lifecycle.handleTool("plexus_project_open", {
      projectPath: "/tmp/project",
      stateRoot: "/tmp/state",
      workspaceId: "worktree-a",
    });

    expect(result).toMatchObject({
      ok: false,
      error: "One or more project images failed to open",
      diagnostics: {
        projectOpen: {
          statePath: "/tmp/state/project.json",
          failures: failureResult.failures,
          images: failureResult.state.images,
        },
      },
    });
  });

  it("keeps gateway routes available for running images when another image fails to open", async () => {
    const projectRoot = makeTempDir("plexus-project-");
    const stateRoot = makeTempDir("plexus-state-");
    const claimsRoot = makeTempDir("plexus-claims-");
    const requests: CapturedGatewayRequest[] = [];
    const processManager = new FakeGatewayProcessManager(9030);
    const partialState: ProjectState = {
      ...runningState,
      runtimeStatus: "failed",
      images: [
        ...clonedRunningState().images,
        {
          id: "stale-feature",
          imageName: "MyProject-stale-feature",
          status: "failed",
        },
      ],
    };
    const failureResult: ProjectOpenResult = {
      ok: false,
      projectRoot: path.resolve(projectRoot),
      statePath: statePath(stateRoot),
      state: partialState,
      failures: [
        {
          imageId: "stale-feature",
          imageName: "MyProject-stale-feature",
          message: "Image exited before PLexus observed the launcher process",
        },
      ],
    };
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
        },
        {
          id: "stale-feature",
          imageName: "MyProject-stale-feature",
          active: true,
          mcp: {
            port: 7124,
            loadScript: "pharo/load-mcp.st",
          },
        },
      ],
      runtime: {
        gateway: {
          mode: "project-local",
          host: "127.0.0.1",
          port: 8137,
          agentMcpPath: "/mcp",
          routeControlMcpPath: "/control-mcp",
        },
      },
    });
    const lifecycle = new PlexusProjectLifecycle({
      projectOpen: async () => {
        throw new ProjectOpenError(
          "One or more project images failed to open",
          failureResult,
        );
      },
      gateway: {
        claimsRoot,
        processManager,
        pharoTools: [pharoEvalTool],
        fetch: makeGatewayFetch(requests),
        skipHealthCheck: true,
        checks: {
          isPortListening: async () => false,
        },
      },
    });

    const result = await lifecycle.handleTool("plexus_project_open", {
      projectPath: projectRoot,
      stateRoot,
      workspaceId: "worktree-a",
    });

    expect(result).toMatchObject({
      ok: false,
      error: "One or more project images failed to open",
      diagnostics: {
        projectOpen: {
          failures: failureResult.failures,
        },
      },
    });
    expect(processManager.starts).toHaveLength(1);
    expect(processManager.starts[0]).toMatchObject({
      port: 8137,
      pharoTools: [pharoEvalTool],
    });
    expect(requests.map((request) => request.url)).toEqual([
      "http://127.0.0.1:8137/control-mcp",
    ]);
    expect(loadProjectState(statePath(stateRoot))?.gateway).toMatchObject({
      mode: "project-local",
      endpoint: "http://127.0.0.1:8137/mcp",
      controlEndpoint: "http://127.0.0.1:8137/control-mcp",
      pid: 9030,
    });
  });

  it("hides route registry state unless diagnostics are requested", async () => {
    const lifecycle = new PlexusProjectLifecycle({
      routeRegistry: new FakeRouteRegistry(),
    });

    const result = await lifecycle.handleTool("plexus_project_status", {
      targetId: runningState.targetId,
    });
    const diagnosticResult = await lifecycle.handleTool("plexus_project_status", {
      targetId: runningState.targetId,
      includeDiagnostics: true,
    });

    expect(result).toMatchObject({
      ok: true,
      data: {
        projectId: "project-123",
        workspaceId: "worktree-a",
        targetId: "project-123--worktree-a",
      },
    });
    expect(result.data).not.toHaveProperty("projectRoot");
    expect(result.data).not.toHaveProperty("statePath");
    expect(result.data).not.toHaveProperty("route");
    expect(diagnosticResult).toMatchObject({
      ok: true,
      data: {
        projectRoot: "project-root",
        statePath: "state.json",
        route: {
          targetId: "project-123--worktree-a",
        },
      },
    });
  });

  it("reports host-local image port coordination diagnostics when no mode is configured", async () => {
    const projectRoot = makeTempDir("plexus-project-");
    const stateRoot = makeTempDir("plexus-state-");
    const claimsRoot = makeTempDir("plexus-claims-");
    writeProjectConfig(projectRoot, {
      runtime: {
        imagePorts: {
          coordination: {
            root: claimsRoot,
          },
        },
      },
    });
    saveProjectState(statePath(stateRoot), runningState);
    const lifecycle = new PlexusProjectLifecycle({
      routeRegistry: new FakeRouteRegistry(),
      gateway: {
        checks: {
          isPortListening: async () => false,
        },
      },
    });

    const result = await lifecycle.handleTool("plexus_project_status", {
      projectPath: projectRoot,
      stateRoot,
      workspaceId: "worktree-a",
      includeDiagnostics: true,
    });

    expect(result).toMatchObject({
      ok: true,
      data: {
        diagnostics: {
          imagePortCoordination: {
            mode: "host-local",
            basis: "host-local-claims",
            claimsRoot,
            message:
              "Image MCP ports are coordinated by host-local port claims across PLexus projects on this host.",
          },
          portClaims: {
            roots: [claimsRoot],
          },
        },
      },
    });
  });

  it("reports explicit project-state image port coordination diagnostics", async () => {
    const projectRoot = makeTempDir("plexus-project-");
    const stateRoot = makeTempDir("plexus-state-");
    writeProjectConfig(projectRoot);
    saveProjectState(statePath(stateRoot), runningState);
    const lifecycle = new PlexusProjectLifecycle({
      routeRegistry: new FakeRouteRegistry(),
      gateway: {
        checks: {
          isPortListening: async () => false,
        },
      },
    });

    const result = await lifecycle.handleTool("plexus_project_status", {
      projectPath: projectRoot,
      stateRoot,
      workspaceId: "worktree-a",
      includeDiagnostics: true,
    });

    expect(result).toMatchObject({
      ok: true,
      data: {
        diagnostics: {
          imagePortCoordination: {
            mode: "project-state",
            basis: "project-state-scanning",
            stateRoot,
            message:
              "Image MCP ports are coordinated by scanning PLexus project state; this only protects workspaces sharing this state root.",
          },
          portClaims: {
            roots: [],
          },
        },
      },
    });
  });

  it("reports zero-image projects as idle with operational runtime health diagnostics", async () => {
    const projectRoot = makeTempDir("plexus-project-");
    const stateRoot = makeTempDir("plexus-state-");
    const claimsRoot = makeTempDir("plexus-claims-");
    const stateFilePath = statePath(stateRoot);
    const gatewayClaim = await claimPort({
      claimsRoot,
      projectId: "project-123",
      projectName: "my-project",
      workspaceId: "worktree-a",
      targetId: "project-123--worktree-a",
      purpose: "gateway",
      requestedPort: 8133,
      claimId: "gateway-claim",
      now: () => new Date("2026-04-25T10:00:00.000Z"),
    });
    const idleState: ProjectState = {
      ...runningState,
      runtimeStatus: "idle",
      images: [],
      gateway: {
        mode: "project-local",
        endpoint: "http://127.0.0.1:8133/mcp",
        controlEndpoint: "http://127.0.0.1:8133/control-mcp",
        host: "127.0.0.1",
        port: 8133,
        routePath: "/mcp",
        controlPath: "/control-mcp",
        owningProjectId: "project-123",
        managedByProject: true,
        claim: {
          claimsRoot,
          claimId: gatewayClaim.claimId,
          assignedPort: gatewayClaim.assignedPort,
        },
      },
    };
    writeProjectConfig(projectRoot, {
      images: [],
      runtime: {
        gateway: {
          mode: "project-local",
          host: "127.0.0.1",
          port: 8133,
          agentMcpPath: "/mcp",
          routeControlMcpPath: "/control-mcp",
        },
      },
    });
    saveProjectState(stateFilePath, idleState);
    const lifecycle = new PlexusProjectLifecycle({
      routeRegistry: new FakeRouteRegistry(),
      gateway: {
        env: {
          PHARO_LAUNCHER_MCP_PROFILE: "isolated",
          PHARO_LAUNCHER_MCP_STATE_ROOT: "/profiles/isolated",
          PHARO_LAUNCHER_MCP_IMAGES_DIR: "/profiles/isolated/images",
          PHARO_LAUNCHER_MCP_VMS_DIR: "/profiles/isolated/vms",
          PHARO_LAUNCHER_MCP_TEMPLATE_SOURCES_DIR: "/profiles/isolated/templates",
          PHARO_LAUNCHER_MCP_INIT_SCRIPTS_DIR: "/profiles/isolated/init-scripts",
          PHARO_LAUNCHER_MCP_LOGS_DIR: "/profiles/isolated/logs",
        } as NodeJS.ProcessEnv,
        checks: {
          isPortListening: async () => false,
        },
      },
    });

    const result = await lifecycle.handleTool("plexus_project_status", {
      projectPath: projectRoot,
      stateRoot,
      workspaceId: "worktree-a",
      includeDiagnostics: true,
    });

    expect(result).toMatchObject({
      ok: true,
      data: {
        stateRoot,
        projectId: "project-123",
        workspaceId: "worktree-a",
        targetId: "project-123--worktree-a",
        gateway: {
          endpoint: "http://127.0.0.1:8133/mcp",
          controlEndpoint: "http://127.0.0.1:8133/control-mcp",
        },
        diagnostics: {
          runtime: {
            status: "idle",
            health: "operational",
          },
          project: {
            declaredImageCount: 0,
            activeImageCount: 0,
            runtimeImageCount: 0,
          },
          scope: {
            sourcePath: projectRoot,
            stateRoot,
            statePath: stateFilePath,
            targetId: "project-123--worktree-a",
          },
          runtimePolicy: {
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
          },
          imagePortPolicy: {
            allocation: "configured-or-dynamic",
            range: {
              start: 7100,
              end: 7199,
            },
            coordinationMode: "project-state",
            projectStateRoot: stateRoot,
            basis: "project-state",
          },
          launcherProfile: {
            ownership: "plexus-owned",
            mode: "project-owned",
            profileScope: "project",
            profileName: "plexus-project-123",
            stateRoot: path.join(
              stateRoot,
              "profiles",
              "pharo-launcher-mcp",
              "project-123",
            ),
          },
          agentAccess: {
            expectedSurface: "pharo_gateway",
            gatewayRouted: true,
            portsHiddenFromAgents: true,
          },
          imagePortCoordination: {
            mode: "project-state",
            basis: "project-state-scanning",
            stateRoot,
          },
          imageMcpPorts: [],
          portClaims: {
            roots: [claimsRoot],
            active: [
              expect.objectContaining({
                port: 8133,
                status: "claimed",
                ownedByCurrentScope: true,
              }),
            ],
            stale: [],
            conflicts: [],
            otherScopes: [],
          },
          routeTable: {
            status: "registered",
            targetId: "project-123--worktree-a",
          },
          conflictingListeners: [],
        },
      },
    });
  });

  it("reports planned repository workspaces from status diagnostics before open", async () => {
    const projectRoot = makeTempDir("plexus-project-");
    const stateRoot = makeTempDir("plexus-state-");
    writeProjectConfig(projectRoot, {
      images: [
        {
          id: "dev",
          imageName: "MyProject-{workspaceId}-dev",
          active: true,
          mcp: {
            port: 7123,
            loadScript: "pharo/load-mcp.st",
          },
          repositoryWorkspace: {
            repository: {
              id: "my-project",
              componentId: "my-project",
            },
            sourceDirectory: "src",
            baseline: "MyProject",
            branch: "task/image-workspace",
            baseBranch: "main",
            materialization: {
              strategy: "copy",
            },
          },
        },
      ],
    });
    const lifecycle = new PlexusProjectLifecycle({
      gateway: {
        checks: {
          isPortListening: async () => false,
        },
      },
    });

    const result = await lifecycle.handleTool("plexus_project_status", {
      projectPath: projectRoot,
      stateRoot,
      workspaceId: "worktree-a",
      includeDiagnostics: true,
    });

    expect(result).toMatchObject({
      ok: true,
      data: {
        context: {
          images: [
            {
              imageId: "dev",
              status: "declared",
              repositoryWorkspace: {
                path: "image-local://dev/pharo-local/iceberg/my-project",
                materializationStrategy: "copy",
                sourceDirectory: "src",
                baseline: "MyProject",
                branch: "task/image-workspace",
                baseBranch: "main",
                dirtyState: "unknown",
                loadState: "not-loaded",
              },
            },
          ],
        },
        diagnostics: {
          repositoryWorkspaces: [
            {
              imageId: "dev",
              imageName: "MyProject-worktree-a-dev",
              status: "declared",
              workspace: {
                path: "image-local://dev/pharo-local/iceberg/my-project",
                materializationStrategy: "copy",
                sourceDirectory: "src",
                baseline: "MyProject",
                branch: "task/image-workspace",
                baseBranch: "main",
                dirtyState: "unknown",
                loadState: "not-loaded",
              },
              cleanup: {
                defaultPolicy: "preserve",
                destructivePolicyRequired: true,
                reviewRequired: false,
                recommendedAction: "materialize",
              },
            },
          ],
        },
      },
    });
  });

  it("reports multiple planned repository workspaces from status diagnostics before open", async () => {
    const projectRoot = makeTempDir("plexus-project-");
    const stateRoot = makeTempDir("plexus-state-");
    writeProjectConfig(projectRoot, {
      images: [
        {
          id: "dev",
          imageName: "MyProject-{workspaceId}-dev",
          active: true,
          mcp: {
            port: 7123,
            loadScript: "pharo/load-mcp.st",
          },
          repositoryWorkspaces: [
            {
              repository: {
                id: "my-project",
                componentId: "my-project",
              },
              sourceDirectory: "src",
              baseline: "MyProject",
              materialization: {
                strategy: "copy",
              },
            },
            {
              repository: {
                id: "dependency",
                remoteUrl: "git@github.com:Example/Dependency.git",
              },
              sourceDirectory: "repository",
              baseline: "Dependency",
              materialization: {
                strategy: "clone",
              },
            },
          ],
        },
      ],
    });
    const lifecycle = new PlexusProjectLifecycle({
      gateway: {
        checks: {
          isPortListening: async () => false,
        },
      },
    });

    const result = await lifecycle.handleTool("plexus_project_status", {
      projectPath: projectRoot,
      stateRoot,
      workspaceId: "worktree-a",
      includeDiagnostics: true,
    });

    expect(result).toMatchObject({
      ok: true,
      data: {
        context: {
          images: [
            {
              imageId: "dev",
              repositoryWorkspaces: [
                {
                  path: "image-local://dev/pharo-local/iceberg/my-project",
                  baseline: "MyProject",
                },
                {
                  path: "image-local://dev/pharo-local/iceberg/dependency",
                  baseline: "Dependency",
                },
              ],
            },
          ],
        },
        diagnostics: {
          repositoryWorkspaces: [
            {
              imageId: "dev",
              workspace: {
                repository: {
                  id: "my-project",
                },
                baseline: "MyProject",
              },
            },
            {
              imageId: "dev",
              workspace: {
                repository: {
                  id: "dependency",
                },
                baseline: "Dependency",
              },
            },
          ],
        },
      },
    });
  });

  it("reports live dirty repository workspaces that need review from status diagnostics", async () => {
    const projectRoot = makeTempDir("plexus-project-");
    const stateRoot = makeTempDir("plexus-state-");
    const repositoryPath = path.join(makeTempDir("plexus-repo-"), "my-project");
    const commit = initRepository(repositoryPath);
    writeFile(path.join(repositoryPath, "src", "Dirty.class.st"), "dirty");
    writeProjectConfig(projectRoot);
    saveProjectState(statePath(stateRoot), {
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
          repositoryWorkspace: {
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
            dirtyState: "clean",
            loadState: "not-loaded",
            baseCommit: commit,
          },
        },
      ],
    });
    const lifecycle = new PlexusProjectLifecycle({
      gateway: {
        checks: {
          isPortListening: async () => false,
        },
      },
    });

    const result = await lifecycle.handleTool("plexus_project_status", {
      projectPath: projectRoot,
      stateRoot,
      workspaceId: "worktree-a",
      includeDiagnostics: true,
    });

    expect(result).toMatchObject({
      ok: true,
      data: {
        diagnostics: {
          repositoryWorkspaces: [
            {
              imageId: "dev",
              workspace: {
                path: repositoryPath,
                dirtyState: "dirty",
                currentCommit: commit,
              },
              cleanup: {
                defaultPolicy: "preserve",
                destructivePolicyRequired: true,
                reviewRequired: true,
                recommendedAction: "review",
                message: expect.stringContaining("uncommitted changes"),
              },
            },
          ],
        },
      },
    });
  });

  it("reports detached dependency repositories from status diagnostics", async () => {
    const projectRoot = makeTempDir("plexus-project-");
    const stateRoot = makeTempDir("plexus-state-");
    writeProjectConfig(projectRoot);
    saveProjectState(statePath(stateRoot), {
      projectId: "project-123",
      projectName: "my-project",
      workspaceId: "worktree-a",
      targetId: "project-123--worktree-a",
      updatedAt: "2026-04-25T10:00:00.000Z",
      images: [
        {
          id: "dev",
          imageName: "MyProject-dev",
          status: "running",
          dependencyRepositoryDetach: {
            state: "detached",
            statusPath: path.join(
              stateRoot,
              "projects",
              "project-123",
              "workspaces",
              "worktree-a",
              "scripts",
              "dependency-repository-detach-dev.properties",
            ),
            cachePath: "/plexus-home/repositories/iceberg",
            detachedCount: 1,
            repositories: [
              {
                name: "TinyLogger",
                location: "/plexus-home/repositories/iceberg/jecisc/TinyLogger",
              },
            ],
          },
        },
      ],
    });
    const lifecycle = new PlexusProjectLifecycle({
      gateway: {
        checks: {
          isPortListening: async () => false,
        },
      },
    });

    const result = await lifecycle.handleTool("plexus_project_status", {
      projectPath: projectRoot,
      stateRoot,
      workspaceId: "worktree-a",
      includeDiagnostics: true,
    });

    expect(result).toMatchObject({
      ok: true,
      data: {
        diagnostics: {
          dependencyRepositoryDetaches: [
            {
              imageId: "dev",
              imageName: "MyProject-dev",
              status: "running",
              detach: {
                state: "detached",
                cachePath: "/plexus-home/repositories/iceberg",
                detachedCount: 1,
                repositories: [
                  {
                    name: "TinyLogger",
                    location:
                      "/plexus-home/repositories/iceberg/jecisc/TinyLogger",
                  },
                ],
              },
            },
          ],
        },
      },
    });
  });

  it("reports unrelated other-scope claims without degrading this scope", async () => {
    const projectRoot = makeTempDir("plexus-project-");
    const stateRoot = makeTempDir("plexus-state-");
    const claimsRoot = makeTempDir("plexus-claims-");
    const stateFilePath = statePath(stateRoot);
    const gatewayClaim = await claimPort({
      claimsRoot,
      projectId: "project-123",
      projectName: "my-project",
      workspaceId: "worktree-a",
      targetId: "project-123--worktree-a",
      purpose: "gateway",
      requestedPort: 8133,
      claimId: "gateway-claim",
    });
    await claimPort({
      claimsRoot,
      projectId: "other-project",
      projectName: "other-project",
      workspaceId: "other-workspace",
      targetId: "other-target",
      purpose: "gateway",
      requestedPort: 8134,
      claimId: "other-gateway-claim",
    });
    await claimPort({
      claimsRoot,
      projectId: "stale-project",
      projectName: "stale-project",
      workspaceId: "stale-workspace",
      targetId: "stale-target",
      purpose: "image-mcp",
      imageId: "dev",
      requestedPort: 7124,
      pid: 2222,
      claimId: "other-stale-image-claim",
    });
    const idleState: ProjectState = {
      ...runningState,
      runtimeStatus: "idle",
      images: [],
      gateway: {
        mode: "project-local",
        endpoint: "http://127.0.0.1:8133/mcp",
        controlEndpoint: "http://127.0.0.1:8133/control-mcp",
        host: "127.0.0.1",
        port: 8133,
        routePath: "/mcp",
        controlPath: "/control-mcp",
        owningProjectId: "project-123",
        managedByProject: true,
        claim: {
          claimsRoot,
          claimId: gatewayClaim.claimId,
          assignedPort: gatewayClaim.assignedPort,
        },
      },
    };
    writeProjectConfig(projectRoot, {
      images: [],
      runtime: {
        gateway: {
          mode: "project-local",
          host: "127.0.0.1",
          port: 8133,
          agentMcpPath: "/mcp",
          routeControlMcpPath: "/control-mcp",
        },
        imagePorts: {
          coordination: {
            mode: "host-local",
            root: claimsRoot,
          },
        },
      },
    });
    saveProjectState(stateFilePath, idleState);
    const lifecycle = new PlexusProjectLifecycle({
      routeRegistry: new FakeRouteRegistry(),
      gateway: {
        checks: {
          isProcessAlive: async () => false,
          isPortListening: async (port) => port === 8133 || port === 8134,
        },
      },
    });

    const result = await lifecycle.handleTool("plexus_project_status", {
      projectPath: projectRoot,
      stateRoot,
      workspaceId: "worktree-a",
      includeDiagnostics: true,
    });

    expect(result).toMatchObject({
      ok: true,
      data: {
        diagnostics: {
          runtime: {
            status: "idle",
            health: "operational",
          },
          portClaims: {
            active: [
              expect.objectContaining({
                port: 8133,
                status: "claimed",
                ownedByCurrentScope: true,
              }),
            ],
            stale: [],
            conflicts: [],
            otherScopes: [
              expect.objectContaining({
                port: 7124,
                status: "stale",
                reason: "process-dead",
                ownedByCurrentScope: false,
              }),
              expect.objectContaining({
                port: 8134,
                status: "claimed",
                reason: "port-listening",
                ownedByCurrentScope: false,
              }),
            ],
          },
          staleClaims: [],
          conflictingListeners: [],
        },
      },
    });
  });

  it("degrades when another scope claims this scope's expected image port", async () => {
    const projectRoot = makeTempDir("plexus-project-");
    const stateRoot = makeTempDir("plexus-state-");
    const claimsRoot = makeTempDir("plexus-claims-");
    const stateFilePath = statePath(stateRoot);
    const gatewayClaim = await claimPort({
      claimsRoot,
      projectId: "project-123",
      projectName: "my-project",
      workspaceId: "worktree-a",
      targetId: "project-123--worktree-a",
      purpose: "gateway",
      requestedPort: 8133,
      claimId: "gateway-claim",
    });
    await claimPort({
      claimsRoot,
      projectId: "other-project",
      projectName: "other-project",
      workspaceId: "other-workspace",
      targetId: "other-target",
      purpose: "image-mcp",
      imageId: "dev",
      requestedPort: 7123,
      claimId: "other-image-claim",
    });
    writeProjectConfig(projectRoot, {
      runtime: {
        gateway: {
          mode: "project-local",
          host: "127.0.0.1",
          port: 8133,
          agentMcpPath: "/mcp",
          routeControlMcpPath: "/control-mcp",
        },
        imagePorts: {
          coordination: {
            mode: "host-local",
            root: claimsRoot,
          },
        },
      },
    });
    saveProjectState(stateFilePath, {
      ...runningState,
      gateway: {
        mode: "project-local",
        endpoint: "http://127.0.0.1:8133/mcp",
        controlEndpoint: "http://127.0.0.1:8133/control-mcp",
        host: "127.0.0.1",
        port: 8133,
        routePath: "/mcp",
        controlPath: "/control-mcp",
        owningProjectId: "project-123",
        managedByProject: true,
        claim: {
          claimsRoot,
          claimId: gatewayClaim.claimId,
          assignedPort: gatewayClaim.assignedPort,
        },
      },
    });
    const lifecycle = new PlexusProjectLifecycle({
      routeRegistry: new FakeRouteRegistry(),
      gateway: {
        checks: {
          isPortListening: async (port) => port === 7123 || port === 8133,
        },
      },
    });

    const result = await lifecycle.handleTool("plexus_project_status", {
      projectPath: projectRoot,
      stateRoot,
      workspaceId: "worktree-a",
      includeDiagnostics: true,
    });

    expect(result).toMatchObject({
      ok: true,
      data: {
        diagnostics: {
          runtime: {
            status: "degraded",
          },
          portClaims: {
            conflicts: [
              expect.objectContaining({
                port: 7123,
                status: "claimed",
                ownedByCurrentScope: false,
              }),
            ],
            otherScopes: [],
          },
        },
      },
    });
  });

  it("returns a helpful diagnostic when projectPath points at the config file", async () => {
    const projectRoot = makeTempDir("plexus-project-");
    writeProjectConfig(projectRoot);
    const lifecycle = new PlexusProjectLifecycle();

    const result = await lifecycle.handleTool("plexus_project_status", {
      projectPath: path.join(projectRoot, "plexus.project.json"),
    });

    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining(
        "projectPath must point to the PLexus project directory",
      ),
    });
    expect(result.error).toContain(projectRoot);
  });

  it("separates stale claims from host listener conflicts in status diagnostics", async () => {
    const projectRoot = makeTempDir("plexus-project-");
    const stateRoot = makeTempDir("plexus-state-");
    const claimsRoot = makeTempDir("plexus-claims-");
    const stateFilePath = statePath(stateRoot);
    const diagnosticState: ProjectState = {
      ...runningState,
      runtimeStatus: "idle",
      images: [
        {
          id: "dev",
          imageName: "MyProject-dev",
          assignedPort: 7123,
          status: "stopped",
        },
      ],
      gateway: {
        mode: "project-local",
        endpoint: "http://127.0.0.1:8133/mcp",
        controlEndpoint: "http://127.0.0.1:8133/control-mcp",
        host: "127.0.0.1",
        port: 8133,
        routePath: "/mcp",
        controlPath: "/control-mcp",
        owningProjectId: "project-123",
        managedByProject: true,
      },
    };
    writeProjectConfig(projectRoot, {
      runtime: {
        imagePorts: {
          coordination: {
            mode: "host-local",
            root: claimsRoot,
          },
        },
      },
    });
    saveProjectState(stateFilePath, diagnosticState);
    await claimPort({
      claimsRoot,
      projectId: "project-123",
      projectName: "my-project",
      workspaceId: "worktree-a",
      targetId: "project-123--worktree-a",
      purpose: "image-mcp",
      imageId: "dev",
      requestedPort: 7124,
      pid: 2222,
      claimId: "stale-image-claim",
    });
    const lifecycle = new PlexusProjectLifecycle({
      routeRegistry: new FakeRouteRegistry(),
      gateway: {
        checks: {
          isProcessAlive: async () => false,
          isPortListening: async (port) => port === 7123,
        },
      },
    });

    const result = await lifecycle.handleTool("plexus_project_status", {
      projectPath: projectRoot,
      stateRoot,
      workspaceId: "worktree-a",
      includeDiagnostics: true,
    });

    expect(result).toMatchObject({
      ok: true,
      data: {
        diagnostics: {
          runtime: {
            status: "degraded",
          },
          imagePortPolicy: {
            allocation: "configured-or-dynamic",
            coordinationMode: "host-local",
            configuredRoot: claimsRoot,
            effectiveClaimsRoot: claimsRoot,
            projectStateRoot: stateRoot,
            basis: "host-local-claims",
          },
          imageMcpPorts: [
            {
              imageId: "dev",
              port: 7123,
              status: "stopped",
            },
          ],
          staleClaims: [
            expect.objectContaining({
              port: 7124,
              status: "stale",
              reason: "process-dead",
              ownedByCurrentScope: true,
            }),
          ],
          conflictingListeners: [
            {
              port: 7123,
              purpose: "image-mcp",
              imageId: "dev",
              expectedOwner: "image dev",
              message:
                "Image MCP port 7123 has a listener but the project image dev is stopped and has no active owned claim.",
            },
          ],
        },
      },
    });
  });

  it("keeps project status available when the route table has no configured target", async () => {
    const projectRoot = makeTempDir("plexus-project-");
    const stateRoot = makeTempDir("plexus-state-");
    const stateFilePath = statePath(stateRoot);
    writeProjectConfig(projectRoot);
    saveProjectState(stateFilePath, {
      ...runningState,
      gateway: {
        mode: "project-local",
        endpoint: "http://127.0.0.1:8133/mcp",
        controlEndpoint: "http://127.0.0.1:8133/control-mcp",
        host: "127.0.0.1",
        port: 8133,
        routePath: "/mcp",
        controlPath: "/control-mcp",
        owningProjectId: "project-123",
        managedByProject: true,
      },
    });
    const lifecycle = new PlexusProjectLifecycle({
      routeRegistry: new MissingRouteRegistry(),
      gateway: {
        checks: {
          isPortListening: async () => false,
        },
      },
    });

    const result = await lifecycle.handleTool("plexus_project_status", {
      projectPath: projectRoot,
      stateRoot,
      workspaceId: "worktree-a",
      includeDiagnostics: true,
    });

    expect(result).toMatchObject({
      ok: true,
      data: {
        diagnostics: {
          runtime: {
            status: "degraded",
          },
          routeTable: {
            targetId: "project-123--worktree-a",
            status: "missing",
            error: "No route is registered for: project-123--worktree-a",
          },
        },
      },
    });
  });

  it("starts a project-local gateway after claiming and validating its port", async () => {
    const projectRoot = makeTempDir("plexus-project-");
    const stateRoot = makeTempDir("plexus-state-");
    const claimsRoot = makeTempDir("plexus-claims-");
    const requests: CapturedGatewayRequest[] = [];
    const events: string[] = [];
    const processManager = new FakeGatewayProcessManager(9020, events);
    writeProjectConfig(projectRoot, {
      images: [],
      runtime: {
        gateway: {
          mode: "project-local",
          host: "127.0.0.1",
          port: 8134,
          agentMcpPath: "/gateway-mcp",
          routeControlMcpPath: "/gateway-control",
        },
      },
    });
    const lifecycle = new PlexusProjectLifecycle({
      gateway: {
        claimsRoot,
        processManager,
        pharoTools: [pharoEvalTool],
        pharoMcpContract: {
          id: "mcp-pharo",
          hash: "sha256:expected",
        },
        fetch: makeGatewayFetch(requests),
        skipHealthCheck: true,
        checks: {
          isPortListening: async (port) => {
            events.push(`check:${port}`);
            return false;
          },
        },
      },
    });

    const openResult = await lifecycle.handleTool("plexus_project_open", {
      projectPath: projectRoot,
      stateRoot,
      workspaceId: "worktree-a",
    });
    const statusResult = await lifecycle.handleTool("plexus_project_status", {
      projectPath: projectRoot,
      stateRoot,
      workspaceId: "worktree-a",
      includeDiagnostics: true,
    });

    expect(openResult).toMatchObject({
      ok: true,
      data: {
        state: {
          gateway: {
            mode: "project-local",
            endpoint: "http://127.0.0.1:8134/gateway-mcp",
            controlEndpoint: "http://127.0.0.1:8134/gateway-control",
            owningProjectId: "project-123",
            managedByProject: true,
            pid: 9020,
          },
        },
      },
    });
    expect(statusResult).toMatchObject({
      ok: true,
      data: {
        gateway: {
          mode: "project-local",
          endpoint: "http://127.0.0.1:8134/gateway-mcp",
          controlEndpoint: "http://127.0.0.1:8134/gateway-control",
          owningProjectId: "project-123",
          managedByProject: true,
        },
      },
    });
    expect(events).toEqual([
      "check:8134",
      "start:8134",
      "check:8134",
      "check:8134",
    ]);
    expect(processManager.starts).toHaveLength(1);
    expect(processManager.starts[0]).toMatchObject({
      host: "127.0.0.1",
      port: 8134,
      routePath: "/gateway-mcp",
      controlPath: "/gateway-control",
      pharoTools: [pharoEvalTool],
      pharoMcpContract: {
        id: "mcp-pharo",
        hash: "sha256:expected",
      },
    });
    expect(requests.map((request) => request.url)).toEqual([
      "http://127.0.0.1:8134/gateway-control",
      "http://127.0.0.1:8134/gateway-control",
    ]);
    await expect(inspectPortClaim({ claimsRoot, port: 8134 })).resolves.toMatchObject({
      status: "claimed",
      record: {
        purpose: "gateway",
        projectId: "project-123",
        workspaceId: "worktree-a",
        targetId: "project-123--worktree-a",
        assignedPort: 8134,
      },
    });
  });

  it("starts a project-local gateway with Pharo tools discovered from the running image", async () => {
    const projectRoot = makeTempDir("plexus-project-");
    const stateRoot = makeTempDir("plexus-state-");
    const claimsRoot = makeTempDir("plexus-claims-");
    const requests: CapturedGatewayRequest[] = [];
    const processManager = new FakeGatewayProcessManager(9022);
    writeProjectConfig(projectRoot, {
      runtime: {
        gateway: {
          mode: "project-local",
          host: "127.0.0.1",
          port: 8136,
          agentMcpPath: "/mcp",
          routeControlMcpPath: "/control-mcp",
        },
      },
    });
    const lifecycle = new PlexusProjectLifecycle({
      projectOpen: async (
        options: ProjectOpenOptions,
      ): Promise<ProjectOpenResult> => ({
        ok: true,
        projectRoot: path.resolve(options.projectRoot),
        statePath: statePath(stateRoot),
        state: clonedRunningState(),
        failures: [],
      }),
      gateway: {
        claimsRoot,
        processManager,
        fetch: makeGatewayAndImageFetch(requests, [pharoEvalTool]),
        skipHealthCheck: true,
        checks: {
          isPortListening: async () => false,
        },
      },
    });

    const openResult = await lifecycle.handleTool("plexus_project_open", {
      projectPath: projectRoot,
      stateRoot,
      workspaceId: "worktree-a",
    });

    expect(openResult).toMatchObject({ ok: true });
    expect(processManager.starts).toHaveLength(1);
    expect(processManager.starts[0]).toMatchObject({
      port: 8136,
      pharoTools: [pharoEvalTool],
    });
    expect(requests.map((request) => request.url)).toEqual([
      "http://127.0.0.1:7123/",
      "http://127.0.0.1:8136/control-mcp",
    ]);
    expect(requests[0]?.body).toMatchObject({
      method: "tools/list",
    });
    expect(requests[1]?.body).toMatchObject({
      method: "tools/call",
      params: {
        name: "plexus_gateway_register_target",
      },
    });
  });

  it("registers routes with a configured shared gateway without starting a process", async () => {
    const projectRoot = makeTempDir("plexus-project-");
    const stateRoot = makeTempDir("plexus-state-");
    const requests: CapturedGatewayRequest[] = [];
    const processManager = new FakeGatewayProcessManager();
    writeProjectConfig(projectRoot, {
      images: [],
      runtime: {
        gateway: {
          mode: "shared",
          agentMcpUrl: "http://shared.gateway:8133/mcp",
          routeControlMcpUrl: "http://shared.gateway:8133/control-mcp",
        },
      },
    });
    const lifecycle = new PlexusProjectLifecycle({
      gateway: {
        processManager,
        fetch: makeGatewayFetch(requests),
      },
    });

    const result = await lifecycle.handleTool("plexus_project_open", {
      projectPath: projectRoot,
      stateRoot,
      workspaceId: "worktree-a",
    });

    expect(result).toMatchObject({
      ok: true,
      data: {
        state: {
          gateway: {
            mode: "shared",
            endpoint: "http://shared.gateway:8133/mcp",
            controlEndpoint: "http://shared.gateway:8133/control-mcp",
            owningProjectId: "project-123",
            managedByProject: false,
          },
        },
      },
    });
    expect(processManager.starts).toEqual([]);
    expect(requests.map((request) => request.url)).toEqual([
      "http://shared.gateway:8133/control-mcp",
    ]);
  });

  it("reports an occupied project-local gateway port before launching", async () => {
    const projectRoot = makeTempDir("plexus-project-");
    const stateRoot = makeTempDir("plexus-state-");
    const claimsRoot = makeTempDir("plexus-claims-");
    const processManager = new FakeGatewayProcessManager();
    writeProjectConfig(projectRoot, {
      images: [],
      runtime: {
        gateway: {
          mode: "project-local",
          host: "127.0.0.1",
          port: 8135,
          agentMcpPath: "/mcp",
          routeControlMcpPath: "/control-mcp",
        },
      },
    });
    const lifecycle = new PlexusProjectLifecycle({
      gateway: {
        claimsRoot,
        processManager,
        checks: {
          isPortListening: async () => true,
        },
      },
    });

    const result = await lifecycle.handleTool("plexus_project_open", {
      projectPath: projectRoot,
      stateRoot,
      workspaceId: "worktree-a",
    });

    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining(
        "Project-local gateway port 8135 is already claimed or unavailable",
      ),
    });
    expect(processManager.starts).toEqual([]);
  });

  it("unregisters routes, stops the project-local gateway, and releases the port claim on close", async () => {
    const projectRoot = makeTempDir("plexus-project-");
    const stateRoot = makeTempDir("plexus-state-");
    const claimsRoot = makeTempDir("plexus-claims-");
    const requests: CapturedGatewayRequest[] = [];
    const processManager = new FakeGatewayProcessManager(9030);
    writeProjectConfig(projectRoot, {
      images: [],
      runtime: {
        gateway: {
          mode: "project-local",
          host: "127.0.0.1",
          port: 8136,
          agentMcpPath: "/mcp",
          routeControlMcpPath: "/control-mcp",
        },
      },
    });
    const lifecycle = new PlexusProjectLifecycle({
      gateway: {
        claimsRoot,
        processManager,
        fetch: makeGatewayFetch(requests),
        now: () => new Date("2026-04-25T11:00:00.000Z"),
        skipHealthCheck: true,
        checks: {
          isPortListening: async () => false,
        },
      },
    });

    await lifecycle.handleTool("plexus_project_open", {
      projectPath: projectRoot,
      stateRoot,
      workspaceId: "worktree-a",
    });
    const closeResult = await lifecycle.handleTool("plexus_project_close", {
      projectPath: projectRoot,
      stateRoot,
      workspaceId: "worktree-a",
    });

    expect(closeResult).toMatchObject({
      ok: true,
      data: {
        state: {
          updatedAt: "2026-04-25T11:00:00.000Z",
        },
      },
    });
    expect((closeResult.data as ProjectCloseResult).state).not.toHaveProperty(
      "gateway",
    );
    expect(processManager.stops).toHaveLength(1);
    expect(processManager.stops[0]).toMatchObject({
      pid: 9030,
      gateway: {
        mode: "project-local",
        port: 8136,
        managedByProject: true,
      },
    });
    expect(requests.map((request) => request.url)).toEqual([
      "http://127.0.0.1:8136/control-mcp",
      "http://127.0.0.1:8136/control-mcp",
    ]);
    await expect(inspectPortClaim({ claimsRoot, port: 8136 })).resolves.toEqual({
      status: "available",
      port: 8136,
    });
    expect(loadProjectState(statePath(stateRoot))?.gateway).toBeUndefined();
  });

  it("posts route registry calls to the route-control MCP path by default", async () => {
    const requests: CapturedGatewayRequest[] = [];
    const registry = new HttpGatewayRouteRegistry({
      host: "gateway.local",
      port: 8133,
      fetch: makeGatewayFetch(requests),
    });

    await registry.registerProjectRoute({
      projectRoot: "project-root",
      statePath: "state.json",
      state: runningState,
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("http://gateway.local:8133/control-mcp");
    expect(requests[0]?.body).toMatchObject({
      method: "tools/call",
      params: {
        name: "plexus_gateway_register_target",
      },
    });
  });

  it("preserves an explicit route registry URL", async () => {
    const requests: CapturedGatewayRequest[] = [];
    const registry = new HttpGatewayRouteRegistry({
      url: "http://gateway.local:8133/mcp",
      host: "ignored.local",
      port: 9000,
      path: "/control-mcp",
      fetch: makeGatewayFetch(requests),
    });

    await registry.getRouteStatus?.({ targetId: runningState.targetId });

    expect(requests[0]?.url).toBe("http://gateway.local:8133/mcp");
  });

  it("wires environment host and port route registry calls to route-control MCP", async () => {
    const requests: CapturedGatewayRequest[] = [];
    vi.stubGlobal("fetch", makeGatewayFetch(requests));
    const lifecycle = createProjectLifecycleFromEnvironment({
      PLEXUS_GATEWAY_HOST: "gateway.local",
      PLEXUS_GATEWAY_PORT: "8133",
    } as NodeJS.ProcessEnv);

    const result = await lifecycle.handleTool("plexus_project_status", {
      targetId: runningState.targetId,
    });

    expect(result).toMatchObject({ ok: true });
    expect(requests[0]?.url).toBe("http://gateway.local:8133/control-mcp");
  });

  it("supports explicit route-control MCP URL and path environment settings", async () => {
    const urlRequests: CapturedGatewayRequest[] = [];
    vi.stubGlobal("fetch", makeGatewayFetch(urlRequests));
    const urlLifecycle = createProjectLifecycleFromEnvironment({
      PLEXUS_GATEWAY_CONTROL_MCP_URL: "http://gateway.local:8133/private-mcp",
      PLEXUS_GATEWAY_HOST: "ignored.local",
      PLEXUS_GATEWAY_PORT: "9000",
    } as NodeJS.ProcessEnv);

    await urlLifecycle.handleTool("plexus_project_status", {
      targetId: runningState.targetId,
    });

    vi.unstubAllGlobals();
    const pathRequests: CapturedGatewayRequest[] = [];
    vi.stubGlobal("fetch", makeGatewayFetch(pathRequests));
    const pathLifecycle = createProjectLifecycleFromEnvironment({
      PLEXUS_GATEWAY_HOST: "gateway.local",
      PLEXUS_GATEWAY_PORT: "8133",
      PLEXUS_GATEWAY_CONTROL_MCP_PATH: "/private-control",
    } as NodeJS.ProcessEnv);

    await pathLifecycle.handleTool("plexus_project_status", {
      targetId: runningState.targetId,
    });

    expect(urlRequests[0]?.url).toBe("http://gateway.local:8133/private-mcp");
    expect(pathRequests[0]?.url).toBe("http://gateway.local:8133/private-control");
  });

});
