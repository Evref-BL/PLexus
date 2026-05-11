import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import {
  saveProjectState,
  type ImageRescueOptions,
  type ImageRescueResult,
  type PharoMcpHealthClient,
  type ProjectCloseOptions,
  type ProjectCloseResult,
  type ProjectOpenOptions,
  type ProjectOpenResult,
  type ProjectState,
} from "@plexus/core";
import { PlexusGateway, type GatewayToolResult } from "./gateway.js";
import type {
  ImageMcpRoute,
  ImageMcpToolRouter,
} from "./imageMcpRouter.js";

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
    {
      id: "baseline",
      imageName: "MyProject-baseline",
      assignedPort: 7124,
      status: "stopped",
    },
  ],
};

const pharoEvalTool: Tool = {
  name: "pharo_eval",
  description: "Evaluate Smalltalk code in a Pharo image.",
  inputSchema: {
    type: "object",
    properties: {
      code: {
        type: "string",
      },
    },
    required: ["code"],
    additionalProperties: false,
  },
};

class FakeImageRouter implements ImageMcpToolRouter {
  readonly calls: Array<{
    route: ImageMcpRoute;
    toolName: string;
    argumentsValue: Record<string, unknown>;
  }> = [];

  async callTool(
    route: ImageMcpRoute,
    toolName: string,
    argumentsValue: Record<string, unknown>,
  ): Promise<unknown> {
    this.calls.push({ route, toolName, argumentsValue });
    return {
      content: [{ type: "text", text: "routed" }],
    };
  }
}

class FakeHealthClient implements PharoMcpHealthClient {
  readonly ports: number[] = [];

  async check(port: number): Promise<boolean> {
    this.ports.push(port);
    return port === 7123;
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

function statePath(stateRoot: string, workspaceId = "worktree-a"): string {
  return path.join(
    stateRoot,
    "projects",
    "project-123",
    "workspaces",
    workspaceId,
    "state.json",
  );
}

function data<T>(result: GatewayToolResult<T>): T {
  expect(result.ok).toBe(true);
  expect(result.data).toBeDefined();
  return result.data as T;
}

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("PlexusGateway", () => {
  it("opens a project and registers image routes", async () => {
    const projectRoot = makeTempDir("plexus-project-");
    const stateRoot = makeTempDir("plexus-state-");
    const stateFilePath = statePath(stateRoot);
    const gateway = new PlexusGateway({
      projectOpen: async (
        options: ProjectOpenOptions,
      ): Promise<ProjectOpenResult> => ({
        ok: true,
        projectRoot: path.resolve(options.projectRoot),
        statePath: stateFilePath,
        state: runningState,
        failures: [],
      }),
    });

    const openResult = await gateway.handleTool("plexus_project_open", {
      projectPath: projectRoot,
      stateRoot,
      workspaceId: "worktree-a",
    });
    expect(openResult.ok).toBe(true);

    const status = data(
      await gateway.handleTool("plexus_project_status", {
        projectId: "project-123",
      }),
    );

    expect(status).toMatchObject({
      projectId: "project-123",
      workspaceId: "worktree-a",
      projectRoot: path.resolve(projectRoot),
      statePath: stateFilePath,
      images: [
        {
          id: "dev",
          imageName: "MyProject-dev",
          port: 7123,
          pid: 1234,
          status: "running",
          health: "unknown",
        },
        {
          id: "baseline",
          imageName: "MyProject-baseline",
          port: 7124,
          status: "stopped",
          health: "unknown",
        },
      ],
    });
  });

  it("refreshes health for running image routes", async () => {
    const healthClient = new FakeHealthClient();
    const gateway = new PlexusGateway({
      healthClient,
      projectOpen: async (
        options: ProjectOpenOptions,
      ): Promise<ProjectOpenResult> => ({
        ok: true,
        projectRoot: path.resolve(options.projectRoot),
        statePath: "state.json",
        state: runningState,
        failures: [],
      }),
    });

    await gateway.handleTool("plexus_project_open", {
      projectPath: makeTempDir("plexus-project-"),
      workspaceId: "worktree-a",
    });
    const status = data(
      await gateway.handleTool("plexus_project_status", {
        projectId: "project-123",
        workspaceId: "worktree-a",
        refreshHealth: true,
      }),
    );

    expect(healthClient.ports).toEqual([7123]);
    expect(status).toMatchObject({
      images: [
        {
          id: "dev",
          health: "healthy",
        },
        {
          id: "baseline",
          health: "unknown",
        },
      ],
    });
  });

  it("routes Pharo MCP calls to the selected running image", async () => {
    const imageRouter = new FakeImageRouter();
    const gateway = new PlexusGateway({
      imageRouter,
      projectOpen: async (
        options: ProjectOpenOptions,
      ): Promise<ProjectOpenResult> => ({
        ok: true,
        projectRoot: path.resolve(options.projectRoot),
        statePath: "state.json",
        state: runningState,
        failures: [],
      }),
    });

    await gateway.handleTool("plexus_project_open", {
      projectPath: makeTempDir("plexus-project-"),
      workspaceId: "worktree-a",
    });
    const routeResult = await gateway.handleTool("plexus_route_to_image", {
      projectId: "project-123",
      workspaceId: "worktree-a",
      imageId: "dev",
      toolName: "pharo_eval",
      arguments: {
        code: "Smalltalk version",
      },
    });
    const routed = data(routeResult);

    expect(imageRouter.calls).toEqual([
      {
        route: {
          projectId: "project-123",
          workspaceId: "worktree-a",
          targetId: "project-123--worktree-a",
          imageId: "dev",
          imageName: "MyProject-dev",
          port: 7123,
        },
        toolName: "pharo_eval",
        argumentsValue: {
          code: "Smalltalk version",
        },
      },
    ]);
    expect(routeResult).toMatchObject({
      route: {
        projectId: "project-123",
        workspaceId: "worktree-a",
        targetId: "project-123--worktree-a",
        imageId: "dev",
        port: 7123,
      },
    });
    expect(routed).toEqual({
      content: [{ type: "text", text: "routed" }],
    });
  });

  it("exposes image rescue with routed Pharo MCP access", async () => {
    const projectRoot = makeTempDir("plexus-project-");
    const stateRoot = makeTempDir("plexus-state-");
    const imageRouter = new FakeImageRouter();
    const rescueCalls: ImageRescueOptions[] = [];
    writeProjectConfig(projectRoot);
    saveProjectState(statePath(stateRoot), runningState);

    const gateway = new PlexusGateway({
      imageRouter,
      imageRescue: async (
        options: ImageRescueOptions,
      ): Promise<ImageRescueResult> => {
        rescueCalls.push(options);
        await options.imageMcpClient?.callTool(
          runningState.images[0],
          "manage-change-history",
          {
            operation: "listFiles",
          },
        );

        return {
          ok: true,
          operation: options.operation,
          projectRoot: options.projectRoot,
          statePath: statePath(stateRoot),
          state: runningState,
          sourceImage: runningState.images[0],
          sourceSnapshot: {
            capturedAt: "2026-05-11T10:00:00.000Z",
            paths: {},
          },
          warnings: [],
        };
      },
    });

    const rescueResult = data(
      await gateway.handleTool("plexus_rescue_image", {
        projectPath: projectRoot,
        stateRoot,
        workspaceId: "worktree-a",
        operation: "applyPlan",
        sourceImageId: "dev",
        confirm: false,
      }),
    );

    expect(rescueCalls[0]).toMatchObject({
      operation: "applyPlan",
      projectRoot: path.resolve(projectRoot),
      sourceImageId: "dev",
      confirm: false,
    });
    expect(imageRouter.calls).toEqual([
      {
        route: {
          projectId: "project-123",
          workspaceId: "worktree-a",
          targetId: "project-123--worktree-a",
          imageId: "dev",
          imageName: "MyProject-dev",
          port: 7123,
        },
        toolName: "manage-change-history",
        argumentsValue: {
          operation: "listFiles",
        },
      },
    ]);
    expect(rescueResult.operation).toBe("applyPlan");
  });

  it("exposes stable Pharo facade tools with a required imageId route field", async () => {
    const stoppedState: ProjectState = {
      ...runningState,
      images: runningState.images.map((image) => ({
        ...image,
        status: "stopped" as const,
      })),
    };
    const gateway = new PlexusGateway({
      pharoTools: [pharoEvalTool],
      projectOpen: async (
        options: ProjectOpenOptions,
      ): Promise<ProjectOpenResult> => ({
        ok: true,
        projectRoot: path.resolve(options.projectRoot),
        statePath: "state.json",
        state: runningState,
        failures: [],
      }),
      projectClose: async (
        options: ProjectCloseOptions,
      ): Promise<ProjectCloseResult> => ({
        ok: true,
        projectRoot: path.resolve(options.projectRoot),
        statePath: "state.json",
        state: stoppedState,
        stoppedImages: stoppedState.images,
        failures: [],
      }),
    });
    const projectRoot = makeTempDir("plexus-project-");
    const initialTools = gateway.listPharoTools();

    expect(initialTools).toMatchObject([
      {
        name: "pharo_eval",
        inputSchema: {
          type: "object",
          properties: {
            imageId: {
              type: "string",
              minLength: 1,
            },
            code: {
              type: "string",
            },
          },
          required: ["imageId", "code"],
          additionalProperties: false,
        },
      },
    ]);

    await gateway.handleTool("plexus_project_open", {
      projectPath: projectRoot,
      workspaceId: "worktree-a",
    });
    await gateway.handleTool("plexus_project_close", {
      projectPath: projectRoot,
      workspaceId: "worktree-a",
    });

    expect(gateway.listPharoTools()).toEqual(initialTools);
  });

  it("routes Pharo facade calls to the selected image and strips imageId", async () => {
    const imageRouter = new FakeImageRouter();
    const twoImageState: ProjectState = {
      ...runningState,
      images: runningState.images.map((image, index) => ({
        ...image,
        pid: 1234 + index,
        status: "running" as const,
      })),
    };
    const gateway = new PlexusGateway({
      imageRouter,
      pharoTools: [pharoEvalTool],
      pharoScope: {
        projectId: "project-123",
        workspaceId: "worktree-a",
      },
      projectOpen: async (
        options: ProjectOpenOptions,
      ): Promise<ProjectOpenResult> => ({
        ok: true,
        projectRoot: path.resolve(options.projectRoot),
        statePath: "state.json",
        state: twoImageState,
        failures: [],
      }),
    });

    await gateway.handleTool("plexus_project_open", {
      projectPath: makeTempDir("plexus-project-"),
      workspaceId: "worktree-a",
    });

    expect(
      data(
        await gateway.callPharoTool("pharo_eval", {
          imageId: "dev",
          code: "1 + 1",
        }),
      ),
    ).toEqual({
      content: [{ type: "text", text: "routed" }],
    });
    expect(
      data(
        await gateway.callPharoTool("pharo_eval", {
          imageId: "baseline",
          code: "2 + 2",
        }),
      ),
    ).toEqual({
      content: [{ type: "text", text: "routed" }],
    });

    expect(imageRouter.calls).toEqual([
      {
        route: {
          projectId: "project-123",
          workspaceId: "worktree-a",
          targetId: "project-123--worktree-a",
          imageId: "dev",
          imageName: "MyProject-dev",
          port: 7123,
        },
        toolName: "pharo_eval",
        argumentsValue: {
          code: "1 + 1",
        },
      },
      {
        route: {
          projectId: "project-123",
          workspaceId: "worktree-a",
          targetId: "project-123--worktree-a",
          imageId: "baseline",
          imageName: "MyProject-baseline",
          port: 7124,
        },
        toolName: "pharo_eval",
        argumentsValue: {
          code: "2 + 2",
        },
      },
    ]);
  });

  it("returns focused Pharo facade errors before forwarding", async () => {
    const imageRouter = new FakeImageRouter();
    const gateway = new PlexusGateway({
      imageRouter,
      pharoTools: [pharoEvalTool],
      pharoScope: {
        projectId: "project-123",
        workspaceId: "worktree-a",
      },
      projectOpen: async (
        options: ProjectOpenOptions,
      ): Promise<ProjectOpenResult> => ({
        ok: true,
        projectRoot: path.resolve(options.projectRoot),
        statePath: "state.json",
        state: runningState,
        failures: [],
      }),
    });

    await gateway.handleTool("plexus_project_open", {
      projectPath: makeTempDir("plexus-project-"),
      workspaceId: "worktree-a",
    });

    await expect(
      gateway.callPharoTool("pharo_eval", {
        code: "1 + 1",
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: "imageId is required",
    });
    await expect(
      gateway.callPharoTool("pharo_eval", {
        imageId: "missing",
        code: "1 + 1",
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: "No route is registered for image missing in project project-123",
    });
    await expect(
      gateway.callPharoTool("pharo_eval", {
        imageId: "baseline",
        code: "1 + 1",
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: "Image baseline is not running; current status is stopped",
    });
    expect(imageRouter.calls).toEqual([]);
  });

  it("rejects Pharo facade calls for image ids outside the scoped workspace", async () => {
    const imageRouter = new FakeImageRouter();
    const stateA: ProjectState = {
      ...runningState,
      workspaceId: "worktree-a",
      targetId: "project-123--worktree-a",
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
      images: [
        {
          id: "review",
          imageName: "MyProject-worktree-b-review",
          assignedPort: 7125,
          pid: 5678,
          status: "running",
        },
      ],
    };
    const gateway = new PlexusGateway({
      imageRouter,
      pharoTools: [pharoEvalTool],
      pharoScope: {
        projectId: "project-123",
        workspaceId: "worktree-a",
      },
      projectOpen: async (
        options: ProjectOpenOptions,
      ): Promise<ProjectOpenResult> => {
        const workspaceId = options.workspaceId ?? "worktree-a";
        const state = workspaceId === "worktree-b" ? stateB : stateA;
        return {
          ok: true,
          projectRoot: path.resolve(options.projectRoot),
          statePath: statePath("state-root", workspaceId),
          state,
          failures: [],
        };
      },
    });

    await gateway.handleTool("plexus_project_open", {
      projectPath: makeTempDir("plexus-project-a-"),
      workspaceId: "worktree-a",
    });
    await gateway.handleTool("plexus_project_open", {
      projectPath: makeTempDir("plexus-project-b-"),
      workspaceId: "worktree-b",
    });

    await expect(
      gateway.callPharoTool("pharo_eval", {
        imageId: "review",
        code: "1 + 1",
      }),
    ).resolves.toMatchObject({
      ok: false,
      error:
        "Image review is registered outside workspace worktree-a; requested target project-123--worktree-a, found target project-123--worktree-b",
    });
    expect(imageRouter.calls).toEqual([]);
  });

  it("reports and rejects Pharo MCP contract mismatches before forwarding", async () => {
    const imageRouter = new FakeImageRouter();
    const contractState: ProjectState = {
      ...runningState,
      pharoMcpContract: {
        id: "project-contract",
        hash: "sha256:expected",
      },
      images: [
        {
          id: "dev",
          imageName: "MyProject-dev",
          assignedPort: 7123,
          pid: 1234,
          status: "running",
          pharoMcpContract: {
            id: "project-contract",
            hash: "sha256:expected",
            status: "matching",
          },
        },
        {
          id: "baseline",
          imageName: "MyProject-baseline",
          assignedPort: 7124,
          pid: 5678,
          status: "running",
          pharoMcpContract: {
            id: "other-contract",
            hash: "sha256:actual",
            status: "mismatched",
          },
        },
      ],
    };
    const gateway = new PlexusGateway({
      imageRouter,
      pharoTools: [pharoEvalTool],
      pharoScope: {
        projectId: "project-123",
        workspaceId: "worktree-a",
      },
      projectOpen: async (
        options: ProjectOpenOptions,
      ): Promise<ProjectOpenResult> => ({
        ok: true,
        projectRoot: path.resolve(options.projectRoot),
        statePath: "state.json",
        state: contractState,
        failures: [],
      }),
    });

    await gateway.handleTool("plexus_project_open", {
      projectPath: makeTempDir("plexus-project-"),
      workspaceId: "worktree-a",
    });

    const status = data(
      await gateway.handleTool("plexus_project_status", {
        projectId: "project-123",
        workspaceId: "worktree-a",
      }),
    );
    expect(status).toMatchObject({
      pharoMcpContract: {
        id: "project-contract",
        hash: "sha256:expected",
      },
      images: [
        {
          id: "dev",
          routable: {
            ok: true,
            code: "ready",
          },
        },
        {
          id: "baseline",
          routable: {
            ok: false,
            code: "contract_mismatch",
          },
        },
      ],
    });

    await expect(
      gateway.callPharoTool("pharo_eval", {
        imageId: "baseline",
        code: "1 + 1",
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: "Image baseline Pharo MCP contract is marked as mismatched",
    });
    expect(imageRouter.calls).toEqual([]);

    expect(
      data(
        await gateway.callPharoTool("pharo_eval", {
          imageId: "dev",
          code: "1 + 1",
        }),
      ),
    ).toEqual({
      content: [{ type: "text", text: "routed" }],
    });
    expect(imageRouter.calls).toHaveLength(1);
  });

  it("refuses to route to stopped images", async () => {
    const gateway = new PlexusGateway({
      projectOpen: async (
        options: ProjectOpenOptions,
      ): Promise<ProjectOpenResult> => ({
        ok: true,
        projectRoot: path.resolve(options.projectRoot),
        statePath: "state.json",
        state: runningState,
        failures: [],
      }),
    });

    await gateway.handleTool("plexus_project_open", {
      projectPath: makeTempDir("plexus-project-"),
      workspaceId: "worktree-a",
    });

    expect(
      await gateway.handleTool("plexus_route_to_image", {
        projectId: "project-123",
        workspaceId: "worktree-a",
        imageId: "baseline",
        toolName: "pharo_eval",
      }),
    ).toMatchObject({
      ok: false,
      error: "Image baseline is not running; current status is stopped",
    });
  });

  it("closes a project and unregisters the target route", async () => {
    const closedState: ProjectState = {
      ...runningState,
      updatedAt: "2026-04-25T11:00:00.000Z",
      images: runningState.images.map((image) => ({
        ...image,
        status: "stopped" as const,
      })),
    };
    const gateway = new PlexusGateway({
      projectOpen: async (
        options: ProjectOpenOptions,
      ): Promise<ProjectOpenResult> => ({
        ok: true,
        projectRoot: path.resolve(options.projectRoot),
        statePath: "state.json",
        state: runningState,
        failures: [],
      }),
      projectClose: async (
        options: ProjectCloseOptions,
      ): Promise<ProjectCloseResult> => ({
        ok: true,
        projectRoot: path.resolve(options.projectRoot),
        statePath: "state.json",
        state: closedState,
        stoppedImages: closedState.images,
        failures: [],
      }),
    });
    const projectRoot = makeTempDir("plexus-project-");

    await gateway.handleTool("plexus_project_open", {
      projectPath: projectRoot,
      workspaceId: "worktree-a",
    });
    await gateway.handleTool("plexus_project_close", {
      projectPath: projectRoot,
      workspaceId: "worktree-a",
    });

    await expect(
      gateway.handleTool("plexus_project_status", {
        projectId: "project-123",
        workspaceId: "worktree-a",
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: "No route is registered for: project-123/worktree-a",
    });

    expect(
      data(await gateway.handleTool("plexus_project_status", {})),
    ).toEqual([]);
  });

  it("unregisters a target explicitly without touching project images", async () => {
    const gateway = new PlexusGateway({
      projectOpen: async (
        options: ProjectOpenOptions,
      ): Promise<ProjectOpenResult> => ({
        ok: true,
        projectRoot: path.resolve(options.projectRoot),
        statePath: "state.json",
        state: runningState,
        failures: [],
      }),
    });
    const projectRoot = makeTempDir("plexus-project-");

    await gateway.handleTool("plexus_project_open", {
      projectPath: projectRoot,
      workspaceId: "worktree-a",
    });
    const unregisterResult = data(
      await gateway.handleTool("plexus_gateway_unregister_target", {
        targetId: "project-123--worktree-a",
      }),
    );

    expect(unregisterResult).toMatchObject({
      removed: true,
      route: {
        projectId: "project-123",
        workspaceId: "worktree-a",
        targetId: "project-123--worktree-a",
      },
    });
    await expect(
      gateway.handleTool("plexus_route_to_image", {
        targetId: "project-123--worktree-a",
        imageId: "dev",
        toolName: "pharo_eval",
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: "No route is registered for: project-123--worktree-a",
    });
  });

  it("prunes registered routes when their runtime state file disappears", async () => {
    const projectRoot = makeTempDir("plexus-project-");
    const stateRoot = makeTempDir("plexus-state-");
    const stateFilePath = statePath(stateRoot);
    saveProjectState(stateFilePath, runningState);
    const gateway = new PlexusGateway({
      projectOpen: async (
        options: ProjectOpenOptions,
      ): Promise<ProjectOpenResult> => ({
        ok: true,
        projectRoot: path.resolve(options.projectRoot),
        statePath: stateFilePath,
        state: runningState,
        failures: [],
      }),
    });

    await gateway.handleTool("plexus_project_open", {
      projectPath: projectRoot,
      stateRoot,
      workspaceId: "worktree-a",
    });
    fs.rmSync(stateFilePath);

    expect(
      data(
        await gateway.handleTool("plexus_project_status", {
          refreshHealth: true,
        }),
      ),
    ).toEqual([]);
  });

  it("hydrates status from runtime state when a project path is provided", async () => {
    const projectRoot = makeTempDir("plexus-project-");
    const stateRoot = makeTempDir("plexus-state-");
    writeProjectConfig(projectRoot);
    saveProjectState(statePath(stateRoot), runningState);
    const gateway = new PlexusGateway();

    const status = data(
      await gateway.handleTool("plexus_project_status", {
        projectPath: projectRoot,
        stateRoot,
        workspaceId: "worktree-a",
      }),
    );

    expect(status).toMatchObject({
      projectId: "project-123",
      statePath: statePath(stateRoot),
      workspaceId: "worktree-a",
      targetId: "project-123--worktree-a",
    });
    expect(status.images[0]).toMatchObject({
      id: "dev",
      port: 7123,
      status: "running",
    });
  });

  it("keeps parallel worktree routes separate for the same project", async () => {
    const projectRootA = makeTempDir("plexus-project-a-");
    const projectRootB = makeTempDir("plexus-project-b-");
    const stateRoot = makeTempDir("plexus-state-");
    const stateA: ProjectState = {
      ...runningState,
      workspaceId: "worktree-a",
      targetId: "project-123--worktree-a",
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
      images: [
        {
          id: "dev",
          imageName: "MyProject-worktree-b-dev",
          assignedPort: 7125,
          pid: 5678,
          status: "running",
        },
      ],
    };
    const imageRouter = new FakeImageRouter();
    const gateway = new PlexusGateway({
      imageRouter,
      projectOpen: async (
        options: ProjectOpenOptions,
      ): Promise<ProjectOpenResult> => {
        const workspaceId = options.workspaceId ?? "worktree-a";
        const state = workspaceId === "worktree-b" ? stateB : stateA;
        return {
          ok: true,
          projectRoot: path.resolve(options.projectRoot),
          statePath: statePath(stateRoot, workspaceId),
          state,
          failures: [],
        };
      },
    });

    await gateway.handleTool("plexus_project_open", {
      projectPath: projectRootA,
      stateRoot,
      workspaceId: "worktree-a",
    });
    await gateway.handleTool("plexus_project_open", {
      projectPath: projectRootB,
      stateRoot,
      workspaceId: "worktree-b",
    });

    const routes = data(
      await gateway.handleTool("plexus_project_status", {
        projectId: "project-123",
      }),
    );
    expect(Array.isArray(routes)).toBe(true);
    expect(routes).toMatchObject([
      {
        workspaceId: "worktree-a",
        targetId: "project-123--worktree-a",
        images: [{ imageName: "MyProject-worktree-a-dev", port: 7123 }],
      },
      {
        workspaceId: "worktree-b",
        targetId: "project-123--worktree-b",
        images: [{ imageName: "MyProject-worktree-b-dev", port: 7125 }],
      },
    ]);

    await expect(
      gateway.handleTool("plexus_route_to_image", {
        projectId: "project-123",
        imageId: "dev",
        toolName: "pharo_eval",
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: "Multiple routes match; provide targetId or workspaceId",
    });

    const routeResult = await gateway.handleTool("plexus_route_to_image", {
      projectId: "project-123",
      workspaceId: "worktree-b",
      imageId: "dev",
      toolName: "pharo_eval",
    });
    expect(routeResult).toMatchObject({
      route: {
        projectId: "project-123",
        workspaceId: "worktree-b",
        targetId: "project-123--worktree-b",
        imageName: "MyProject-worktree-b-dev",
        port: 7125,
      },
    });
    expect(data(routeResult)).toEqual({
      content: [{ type: "text", text: "routed" }],
    });
  });
});
