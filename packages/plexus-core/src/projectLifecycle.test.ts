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
import type { ProjectOpenOptions, ProjectOpenResult } from "./projectOpen.js";
import { saveProjectState, type ProjectState } from "./projectState.js";

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

  it("preserves an explicit gateway MCP URL for compatibility", async () => {
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

  it("keeps legacy gateway MCP URL environment compatibility", async () => {
    const requests: CapturedGatewayRequest[] = [];
    vi.stubGlobal("fetch", makeGatewayFetch(requests));
    const lifecycle = createProjectLifecycleFromEnvironment({
      PLEXUS_GATEWAY_MCP_URL: "http://gateway.local:8133/mcp",
    } as NodeJS.ProcessEnv);

    await lifecycle.handleTool("plexus_project_status", {
      targetId: runningState.targetId,
    });

    expect(requests[0]?.url).toBe("http://gateway.local:8133/mcp");
  });
});
