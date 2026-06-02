import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import {
  PlexusGateway,
  type GatewayImageHealthClient,
  type GatewayToolResult,
} from "./gateway.js";
import type {
  ImageMcpConnectionInfo,
  ImageMcpRoute,
  ImageMcpToolRouter,
} from "./imageMcpRouter.js";
import type { GatewayProjectState } from "./routingTable.js";

const tempDirs: string[] = [];

const runningState: GatewayProjectState = {
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

function repositoryOperationTool(operations: string[]): Tool {
  return {
    name: "edit-repository",
    inputSchema: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          enum: operations,
        },
      },
      required: ["operation"],
      additionalProperties: false,
    },
  };
}

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

class FakeToolListImageRouter extends FakeImageRouter {
  readonly listCalls: ImageMcpRoute[] = [];

  constructor(
    private readonly toolsByImageId: Record<string, Tool[]>,
    private readonly connectionInfoByImageId: Record<
      string,
      ImageMcpConnectionInfo
    > = {},
  ) {
    super();
  }

  async listTools(route: ImageMcpRoute): Promise<Tool[]> {
    this.listCalls.push(route);
    const tools = this.toolsByImageId[route.imageId];
    if (!tools) {
      throw new Error(`No tools for image ${route.imageId}`);
    }

    return tools;
  }

  connectionInfo(route: ImageMcpRoute): ImageMcpConnectionInfo | undefined {
    return this.connectionInfoByImageId[route.imageId];
  }
}

class FakeHealthClient implements GatewayImageHealthClient {
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

async function registerTarget(
  gateway: PlexusGateway,
  state: GatewayProjectState = runningState,
  stateFilePath = "state.json",
): Promise<void> {
  await expect(
    gateway.handleTool("plexus_gateway_register_target", {
      projectRoot: makeTempDir("plexus-project-"),
      statePath: stateFilePath,
      state,
    }),
  ).resolves.toMatchObject({ ok: true });
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
  it("registers a target route from PLexus runtime state", async () => {
    const gateway = new PlexusGateway();
    const projectRoot = makeTempDir("plexus-project-");
    const stateFilePath = statePath(makeTempDir("plexus-state-"));

    const registerResult = data(
      await gateway.handleTool("plexus_gateway_register_target", {
        projectRoot,
        statePath: stateFilePath,
        state: runningState,
      }),
    );
    const status = data(
      await gateway.handleTool("plexus_gateway_status", {
        projectId: "project-123",
      }),
    );

    expect(registerResult).toMatchObject({
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
    expect(status).toMatchObject(registerResult);
  });

  it("includes route metadata explaining how subagents should carry imageId", async () => {
    const gateway = new PlexusGateway();

    await registerTarget(gateway);

    const status = data(
      await gateway.handleTool("plexus_gateway_status", {
        projectId: "project-123",
        workspaceId: "worktree-a",
      }),
    );

    expect(status).toEqual(
      expect.objectContaining({
        images: expect.arrayContaining([
          expect.objectContaining({
            id: "dev",
            routeMetadata: {
              serverName: "pharo_gateway",
              requiredArgument: "imageId",
              imageId: "dev",
              routeReference: {
                projectId: "project-123",
                workspaceId: "worktree-a",
                targetId: "project-123--worktree-a",
              },
              imageIdSource:
                "Read images[].imageId from PLexus scoped context, pharo-launcher image list, or gateway status",
              recordHint:
                "Record the selected imageId with the scoped project/workspace/target before calling pharo_gateway tools",
            },
          }),
        ]),
      }),
    );
  });

  it("reports image creation role and source metadata from PLexus state", async () => {
    const gateway = new PlexusGateway();
    const createdState: GatewayProjectState = {
      ...runningState,
      images: [
        {
          ...runningState.images[0],
          creation: {
            role: "development",
            source: {
              kind: "template",
              profileId: "pharo-13-default",
              templateName: "Pharo 13.0 - 64bit",
              templateCategory: "Official",
            },
            cleanupPolicy: "workspace_cleanup_only",
          },
        },
      ],
    };

    await registerTarget(gateway, createdState);

    expect(
      data(
        await gateway.handleTool("plexus_gateway_status", {
          projectId: "project-123",
          workspaceId: "worktree-a",
        }),
      ),
    ).toMatchObject({
      images: [
        {
          id: "dev",
          creation: {
            role: "development",
            source: {
              kind: "template",
              profileId: "pharo-13-default",
              templateName: "Pharo 13.0 - 64bit",
              templateCategory: "Official",
            },
            cleanupPolicy: "workspace_cleanup_only",
          },
        },
      ],
    });
  });

  it("refreshes health for running image routes", async () => {
    const healthClient = new FakeHealthClient();
    const gateway = new PlexusGateway({ healthClient });

    await registerTarget(gateway);
    const status = data(
      await gateway.handleTool("plexus_gateway_status", {
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

  it("marks unhealthy refreshed routes as unroutable", async () => {
    const imageRouter = new FakeImageRouter();
    const gateway = new PlexusGateway({
      healthClient: new FakeHealthClient(),
      imageRouter,
    });
    const unhealthyState: GatewayProjectState = {
      ...runningState,
      images: [
        {
          id: "dev",
          imageName: "MyProject-dev",
          assignedPort: 7125,
          pid: 1234,
          status: "running",
        },
      ],
    };

    await registerTarget(gateway, unhealthyState);
    const status = data(
      await gateway.handleTool("plexus_gateway_status", {
        projectId: "project-123",
        workspaceId: "worktree-a",
        refreshHealth: true,
      }),
    );

    expect(status).toMatchObject({
      images: [
        {
          id: "dev",
          health: "unhealthy",
          routable: {
            ok: false,
            code: "image_unavailable",
            message: "Image dev health check failed",
          },
        },
      ],
    });
    await expect(
      gateway.handleTool("plexus_route_to_image", {
        projectId: "project-123",
        workspaceId: "worktree-a",
        imageId: "dev",
        toolName: "pharo_eval",
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: "Image dev health check failed",
    });
    expect(imageRouter.calls).toEqual([]);
  });

  it("routes Pharo MCP calls to the selected running image", async () => {
    const imageRouter = new FakeImageRouter();
    const gateway = new PlexusGateway({ imageRouter });

    await registerTarget(gateway);
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

  it("routes Pharo MCP calls through a registered endpoint without requiring an assigned port", async () => {
    const imageRouter = new FakeImageRouter();
    const endpointState: GatewayProjectState = {
      ...runningState,
      images: [
        {
          id: "dev",
          imageName: "MyProject-dev",
          mcpEndpoint: {
            transport: "http",
            host: "127.0.0.1",
            port: 9123,
            path: "/mcp",
          },
          pid: 1234,
          status: "running",
        },
      ],
    };
    const gateway = new PlexusGateway({ imageRouter });

    await registerTarget(gateway, endpointState);
    const status = data(
      await gateway.handleTool("plexus_gateway_status", {
        projectId: "project-123",
        workspaceId: "worktree-a",
      }),
    );
    const routeResult = await gateway.handleTool("plexus_route_to_image", {
      projectId: "project-123",
      workspaceId: "worktree-a",
      imageId: "dev",
      toolName: "pharo_eval",
      arguments: {
        code: "Smalltalk version",
      },
    });

    expect(status).toMatchObject({
      images: [
        {
          id: "dev",
          port: 9123,
          mcpEndpoint: {
            transport: "http",
            host: "127.0.0.1",
            port: 9123,
            path: "/mcp",
          },
        },
      ],
    });
    expect(routeResult).toMatchObject({
      route: {
        projectId: "project-123",
        workspaceId: "worktree-a",
        targetId: "project-123--worktree-a",
        imageId: "dev",
        imageName: "MyProject-dev",
        port: 9123,
        mcpEndpoint: {
          transport: "http",
          host: "127.0.0.1",
          port: 9123,
          path: "/mcp",
        },
      },
    });
    expect(imageRouter.calls).toEqual([
      {
        route: {
          projectId: "project-123",
          workspaceId: "worktree-a",
          targetId: "project-123--worktree-a",
          imageId: "dev",
          imageName: "MyProject-dev",
          port: 9123,
          mcpEndpoint: {
            transport: "http",
            host: "127.0.0.1",
            port: 9123,
            path: "/mcp",
          },
        },
        toolName: "pharo_eval",
        argumentsValue: {
          code: "Smalltalk version",
        },
      },
    ]);
  });

  it("routes Pharo MCP calls through a remote gateway upstream", async () => {
    const imageRouter = new FakeImageRouter();
    const requests: Array<{
      url: string;
      body: Record<string, unknown>;
    }> = [];
    const remoteState: GatewayProjectState = {
      ...runningState,
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
        targetId: "remote-target-a",
      },
      images: [
        {
          id: "dev",
          imageName: "MyProject-dev",
          status: "running",
        },
      ],
    };
    const gateway = new PlexusGateway({
      imageRouter,
      remoteGatewayFetch: (async (
        input: Parameters<typeof fetch>[0],
        init?: RequestInit,
      ) => {
        requests.push({
          url: String(input),
          body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        });
        return new Response(
          JSON.stringify({
            result: {
              content: [{ type: "text", text: "remote routed" }],
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

    await registerTarget(gateway, remoteState);
    const status = data(
      await gateway.handleTool("plexus_gateway_status", {
        projectId: "project-123",
        workspaceId: "worktree-a",
      }),
    );
    const routeResult = await gateway.handleTool("plexus_route_to_image", {
      projectId: "project-123",
      workspaceId: "worktree-a",
      imageId: "dev",
      toolName: "pharo_eval",
      arguments: {
        code: "Smalltalk version",
      },
    });

    expect(status).toMatchObject({
      remoteGateway: {
        remoteNodeId: "remote-a",
      },
      images: [
        {
          id: "dev",
          routable: {
            ok: true,
            code: "ready",
          },
        },
      ],
    });
    expect(routeResult).toMatchObject({
      ok: true,
      data: {
        content: [{ type: "text", text: "remote routed" }],
      },
      route: {
        projectId: "project-123",
        workspaceId: "worktree-a",
        targetId: "project-123--worktree-a",
        imageId: "dev",
        imageName: "MyProject-dev",
        remoteGateway: {
          remoteNodeId: "remote-a",
          endpoint: {
            host: "remote-a.local",
            port: 7331,
            path: "/mcp",
          },
        },
      },
    });
    expect(imageRouter.calls).toEqual([]);
    expect(requests).toMatchObject([
      {
        url: "http://remote-a.local:7331/mcp",
        body: {
          method: "tools/call",
          params: {
            name: "pharo_eval",
            arguments: {
              imageId: "dev",
              code: "Smalltalk version",
            },
          },
        },
      },
    ]);
  });

  it("refreshes Pharo tools from a remote gateway upstream", async () => {
    const requests: Array<{
      url: string;
      body: Record<string, unknown>;
    }> = [];
    const remoteState: GatewayProjectState = {
      ...runningState,
      remoteGateway: {
        remoteNodeId: "remote-a",
        endpoint: {
          transport: "http",
          host: "remote-a.local",
          port: 7331,
          path: "/mcp",
        },
      },
      images: [
        {
          id: "dev",
          imageName: "MyProject-dev",
          status: "running",
        },
      ],
    };
    const gateway = new PlexusGateway({
      remoteGatewayFetch: (async (
        input: Parameters<typeof fetch>[0],
        init?: RequestInit,
      ) => {
        requests.push({
          url: String(input),
          body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        });
        return new Response(
          JSON.stringify({
            result: {
              tools: [pharoEvalTool],
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

    await registerTarget(gateway, remoteState);

    await expect(gateway.refreshPharoTools()).resolves.toMatchObject([
      {
        name: "pharo_eval",
        inputSchema: {
          required: ["imageId", "code"],
        },
      },
    ]);
    expect(requests).toMatchObject([
      {
        url: "http://remote-a.local:7331/mcp",
        body: {
          method: "tools/list",
        },
      },
    ]);
  });

  it("exposes stable Pharo facade tools with a required imageId route field", () => {
    const gateway = new PlexusGateway({
      pharoTools: [pharoEvalTool],
    });

    expect(gateway.listPharoTools()).toMatchObject([
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
  });

  it("routes Pharo facade calls to the selected image and strips imageId", async () => {
    const imageRouter = new FakeImageRouter();
    const twoImageState: GatewayProjectState = {
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
    });

    await registerTarget(gateway, twoImageState);

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
    });

    await registerTarget(gateway);

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
    const stateA: GatewayProjectState = {
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
    const stateB: GatewayProjectState = {
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
    });

    await registerTarget(gateway, stateA);
    await registerTarget(gateway, stateB);

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
    const contractState: GatewayProjectState = {
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
    });

    await registerTarget(gateway, contractState);

    const status = data(
      await gateway.handleTool("plexus_gateway_status", {
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

  it("selects one active Pharo tool schema and excludes incompatible image routes", async () => {
    const imageRouter = new FakeToolListImageRouter(
      {
        dev: [repositoryOperationTool(["create"])],
        baseline: [repositoryOperationTool(["create", "fetch"])],
      },
      {
        dev: {
          lifecycle: {
            status: "initialized",
          },
          protocolVersion: "2025-06-18",
          serverInfo: {
            name: "pharo-mcp",
            version: "1.0.0",
          },
        },
        baseline: {
          lifecycle: {
            status: "initialized",
          },
          protocolVersion: "2025-06-18",
          serverInfo: {
            name: "pharo-mcp",
            version: "2.0.0",
          },
        },
      },
    );
    const gateway = new PlexusGateway({
      imageRouter,
      pharoTools: [pharoEvalTool],
      pharoScope: {
        projectId: "project-123",
        workspaceId: "worktree-a",
      },
    });
    const mixedSchemaState: GatewayProjectState = {
      ...runningState,
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
    };

    await registerTarget(gateway, mixedSchemaState);

    const status = data(
      await gateway.handleTool("plexus_gateway_status", {
        projectId: "project-123",
        workspaceId: "worktree-a",
        refreshTools: true,
      }),
    );
    expect(status).toMatchObject({
      pharoToolSchema: {
        state: "mismatched",
        activeVersion: {
          targetId: "project-123--worktree-a",
          imageId: "dev",
        },
        sourceCount: 2,
        sources: [
          {
            targetId: "project-123--worktree-a",
            imageId: "dev",
            compatibility: "active",
            toolCount: 1,
            lifecycle: {
              status: "initialized",
            },
            serverInfo: {
              name: "pharo-mcp",
              version: "1.0.0",
            },
          },
          {
            targetId: "project-123--worktree-a",
            imageId: "baseline",
            compatibility: "incompatible",
            toolCount: 1,
            lifecycle: {
              status: "initialized",
            },
            serverInfo: {
              name: "pharo-mcp",
              version: "2.0.0",
            },
          },
        ],
      },
      images: [
        {
          id: "dev",
          pharoToolSchema: {
            compatibility: "active",
            toolCount: 1,
            lifecycle: {
              status: "initialized",
            },
            serverInfo: {
              name: "pharo-mcp",
              version: "1.0.0",
            },
          },
        },
        {
          id: "baseline",
          pharoToolSchema: {
            compatibility: "incompatible",
            toolCount: 1,
            lifecycle: {
              status: "initialized",
            },
            serverInfo: {
              name: "pharo-mcp",
              version: "2.0.0",
            },
          },
        },
      ],
    });
    expect(imageRouter.listCalls).toHaveLength(2);

    await expect(gateway.refreshPharoTools()).resolves.toEqual([
      expect.objectContaining({
        name: "edit-repository",
        inputSchema: expect.objectContaining({
          properties: expect.objectContaining({
            operation: expect.objectContaining({
              enum: ["create"],
            }),
          }),
        }),
      }),
    ]);
    await expect(
      gateway.callPharoTool("edit-repository", {
        imageId: "dev",
        operation: "create",
      }),
    ).resolves.toMatchObject({
      ok: true,
      data: {
        content: [{ type: "text", text: "routed" }],
      },
    });
    await expect(
      gateway.callPharoTool("edit-repository", {
        imageId: "baseline",
        operation: "fetch",
      }),
    ).resolves.toMatchObject({
      ok: false,
      error:
        "Image baseline Pharo MCP schema is incompatible with active gateway schema",
    });
    expect(imageRouter.calls).toEqual([
      expect.objectContaining({
        route: expect.objectContaining({
          imageId: "dev",
        }),
        toolName: "edit-repository",
        argumentsValue: {
          operation: "create",
        },
      }),
    ]);
  });

  it("can select the active Pharo tool schema source by image", async () => {
    const imageRouter = new FakeToolListImageRouter({
      dev: [repositoryOperationTool(["create"])],
      baseline: [repositoryOperationTool(["create", "fetch"])],
    });
    const gateway = new PlexusGateway({
      imageRouter,
      pharoTools: [pharoEvalTool],
      pharoScope: {
        projectId: "project-123",
        workspaceId: "worktree-a",
      },
    });
    const mixedSchemaState: GatewayProjectState = {
      ...runningState,
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
    };

    await registerTarget(gateway, mixedSchemaState);

    const status = data(
      await gateway.handleTool("plexus_gateway_status", {
        projectId: "project-123",
        workspaceId: "worktree-a",
        refreshTools: true,
        toolSchemaImageId: "baseline",
      }),
    );
    expect(status).toMatchObject({
      pharoToolSchema: {
        state: "mismatched",
        activeVersion: {
          targetId: "project-123--worktree-a",
          imageId: "baseline",
        },
        sources: [
          {
            imageId: "dev",
            compatibility: "incompatible",
          },
          {
            imageId: "baseline",
            compatibility: "active",
          },
        ],
      },
    });

    await expect(gateway.refreshPharoTools()).resolves.toEqual([
      expect.objectContaining({
        name: "edit-repository",
        inputSchema: expect.objectContaining({
          properties: expect.objectContaining({
            operation: expect.objectContaining({
              enum: ["create", "fetch"],
            }),
          }),
        }),
      }),
    ]);
    await expect(
      gateway.callPharoTool("edit-repository", {
        imageId: "baseline",
        operation: "fetch",
      }),
    ).resolves.toMatchObject({
      ok: true,
      data: {
        content: [{ type: "text", text: "routed" }],
      },
    });
    await expect(
      gateway.callPharoTool("edit-repository", {
        imageId: "dev",
        operation: "create",
      }),
    ).resolves.toMatchObject({
      ok: false,
      error:
        "Image dev Pharo MCP schema is incompatible with active gateway schema",
    });
  });

  it("reports unavailable Pharo tool schema status for stopped image routes", async () => {
    const imageRouter = new FakeToolListImageRouter({
      dev: [repositoryOperationTool(["create"])],
    });
    const gateway = new PlexusGateway({
      imageRouter,
      pharoScope: {
        projectId: "project-123",
        workspaceId: "worktree-a",
      },
    });

    await registerTarget(gateway, runningState);

    const status = data(
      await gateway.handleTool("plexus_gateway_status", {
        projectId: "project-123",
        workspaceId: "worktree-a",
        refreshTools: true,
      }),
    );

    expect(status).toMatchObject({
      pharoToolSchema: {
        state: "matching",
        sourceCount: 1,
        sources: [
          {
            imageId: "dev",
            compatibility: "active",
          },
        ],
      },
      images: [
        {
          id: "dev",
          pharoToolSchema: {
            compatibility: "active",
            toolCount: 1,
          },
        },
        {
          id: "baseline",
          status: "stopped",
          pharoToolSchema: {
            compatibility: "unavailable",
            error: "Image baseline is not running; current status is stopped",
          },
        },
      ],
    });
    expect(imageRouter.listCalls).toHaveLength(1);
  });

  it("rejects missing Pharo tool schema source image selection", async () => {
    const imageRouter = new FakeToolListImageRouter({
      dev: [repositoryOperationTool(["create"])],
    });
    const gateway = new PlexusGateway({
      imageRouter,
      pharoScope: {
        projectId: "project-123",
        workspaceId: "worktree-a",
      },
    });

    await registerTarget(gateway, {
      ...runningState,
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
      gateway.handleTool("plexus_gateway_status", {
        projectId: "project-123",
        workspaceId: "worktree-a",
        refreshTools: true,
        toolSchemaImageId: "missing",
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: "No routable image missing provided an available Pharo MCP schema",
    });
  });

  it("reports and rejects unsupported Pharo MCP image versions before forwarding", async () => {
    const imageRouter = new FakeImageRouter();
    const gateway = new PlexusGateway({
      imageRouter,
      pharoTools: [pharoEvalTool],
      pharoScope: {
        projectId: "project-123",
        workspaceId: "worktree-a",
      },
    });

    await registerTarget(gateway, {
      ...runningState,
      images: [
        {
          id: "legacy",
          imageName: "MyProject-legacy",
          pid: 1234,
          status: "running",
          pharoMcpContract: {
            status: "unsupported",
            actualMajorVersion: 11,
            supportedMajorVersions: [12, 13, 14],
            reason: "Pharo 11 is outside the supported Pharo MCP range.",
          },
        },
      ],
    });

    const status = data(
      await gateway.handleTool("plexus_gateway_status", {
        projectId: "project-123",
        workspaceId: "worktree-a",
      }),
    );
    expect(status.images).toEqual([
      expect.objectContaining({
        id: "legacy",
        routable: {
          ok: false,
          code: "unsupported",
          message: "Pharo 11 is outside the supported Pharo MCP range.",
        },
      }),
    ]);
    expect(status.images[0]).not.toHaveProperty("port");

    await expect(
      gateway.callPharoTool("pharo_eval", {
        imageId: "legacy",
        code: "1 + 1",
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: "Pharo 11 is outside the supported Pharo MCP range.",
    });
    expect(imageRouter.calls).toEqual([]);
  });

  it("refuses to route to stopped images", async () => {
    const gateway = new PlexusGateway();

    await registerTarget(gateway);

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

  it("unregisters a target explicitly without touching project images", async () => {
    const gateway = new PlexusGateway();

    await registerTarget(gateway);
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
    const stateRoot = makeTempDir("plexus-state-");
    const stateFilePath = statePath(stateRoot);
    fs.mkdirSync(path.dirname(stateFilePath), { recursive: true });
    fs.writeFileSync(stateFilePath, JSON.stringify(runningState), "utf8");
    const gateway = new PlexusGateway();

    await registerTarget(gateway, runningState, stateFilePath);
    fs.rmSync(stateFilePath);

    expect(
      data(await gateway.handleTool("plexus_gateway_cleanup_stale_routes", {})),
    ).toMatchObject({
      removed: [
        {
          projectId: "project-123",
          targetId: "project-123--worktree-a",
        },
      ],
    });
    expect(data(await gateway.handleTool("plexus_gateway_status", {}))).toEqual(
      [],
    );
  });

  it("keeps parallel worktree routes separate for the same project", async () => {
    const stateRoot = makeTempDir("plexus-state-");
    const stateA: GatewayProjectState = {
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
    const stateB: GatewayProjectState = {
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
    const gateway = new PlexusGateway({ imageRouter });

    await registerTarget(gateway, stateA, statePath(stateRoot, "worktree-a"));
    await registerTarget(gateway, stateB, statePath(stateRoot, "worktree-b"));

    const routes = data(
      await gateway.handleTool("plexus_gateway_status", {
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

  it("does not own PLexus lifecycle tools", async () => {
    const gateway = new PlexusGateway();

    await expect(
      gateway.handleTool("plexus_project_open", {
        projectPath: makeTempDir("plexus-project-"),
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: "Unknown tool: plexus_project_open",
    });
  });
});
