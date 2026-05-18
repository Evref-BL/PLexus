import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createProjectLifecycleFromEnvironment,
  HttpGatewayRouteRegistry,
  PlexusProjectLifecycle,
  type ProjectLifecycleRouteReference,
  type ProjectLifecycleRouteRegistration,
  type ProjectLifecycleRouteRegistry,
} from "./projectLifecycle.js";
import type { ProjectCloseOptions, ProjectCloseResult } from "./projectClose.js";
import type {
  ProjectGatewayProcessManager,
  ProjectGatewayProcessStartOptions,
  ProjectGatewayProcessStopOptions,
} from "./projectGateway.js";
import { claimPort, inspectPortClaim } from "./portClaims.js";
import type { ProjectOpenOptions, ProjectOpenResult } from "./projectOpen.js";
import {
  loadProjectState,
  saveProjectState,
  type ProjectState,
} from "./projectState.js";

const tempDirs: string[] = [];

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
    return {
      ok: true,
      data: {
        projectId: input.projectId ?? runningState.projectId,
        workspaceId: input.workspaceId ?? runningState.workspaceId,
        targetId: input.targetId ?? runningState.targetId,
        projectRoot: "project-root",
        statePath: "state.json",
      },
    };
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

function makeTempDir(prefix: string): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(tempDir);
  return tempDir;
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
        name: "my-project",
        kanban: {
          provider: "vibe-kanban",
          projectId: "project-123",
        },
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
  return path.join(
    stateRoot,
    "projects",
    "project-123",
    "workspaces",
    "worktree-a",
    "state.json",
  );
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

  it("reports lifecycle status from project runtime state without starting images", async () => {
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

  it("reports zero-image projects as operational-but-idle with runtime scope diagnostics", async () => {
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
            status: "operational-but-idle",
          },
          project: {
            declaredImageCount: 0,
            activeImageCount: 0,
            runtimeImageCount: 0,
          },
          scope: {
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
            profileName:
              "plexus-project-123-worktree-a-project-123--worktree-a",
            stateRoot: path.join(
              stateRoot,
              "profiles",
              "pharo-launcher-mcp",
              "project-123",
              "worktree-a",
              "project-123--worktree-a",
            ),
          },
          agentAccess: {
            expectedSurface: "gateway",
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
