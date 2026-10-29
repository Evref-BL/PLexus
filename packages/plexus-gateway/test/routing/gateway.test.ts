import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import {
  PlexusGateway,
  type GatewayImageHealthClient,
  type GatewayToolResult,
} from "../../src/routing/gateway.js";
import type {
  ImageMcpConnectionInfo,
  ImageMcpRoute,
  ImageMcpToolRouter,
} from "../../src/routing/imageMcpRouter.js";
import type { GatewayProjectState } from "../../src/routing/routingTable.js";

const tempDirs: string[] = [];

function mcpServers(id: string, port: number) {
  return [
    {
      id,
      endpoint: {
        transport: "http" as const,
        host: "127.0.0.1",
        port,
        path: "/",
      },
    },
  ];
}

const runningState: GatewayProjectState = {
  projectId: "project-123",
  projectName: "my-project",
  workspaceId: "worktree-a",
  updatedAt: "2026-04-25T10:00:00.000Z",
  images: [
    {
      id: "dev",
      imageName: "MyProject-dev",
      mcpServers: mcpServers("dev", 7123),
      pid: 1234,
      status: "running",
    },
    {
      id: "baseline",
      imageName: "MyProject-baseline",
      mcpServers: mcpServers("baseline", 7124),
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
      imageId: {
        type: "string",
      },
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

/**
 * Lay a project out on disk the way PLexus does — the state file, and one
 * endpoint handoff per MCP server the fixture gives an image — and point the
 * gateway at the directory. Nothing is registered; the files are the route.
 */
async function registerTarget(
  gateway: PlexusGateway,
  state: GatewayProjectState = runningState,
  stateFilePath?: string,
): Promise<void> {
  const projectRoot = makeTempDir("plexus-project-");
  const statePath = path.join(projectRoot, stateFilePath ?? "state.json");
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(state), "utf8");
  const endpoints = path.join(path.dirname(statePath), "mcp-endpoints");
  fs.mkdirSync(endpoints, { recursive: true });
  for (const image of state.images) {
    for (const server of image.mcpServers ?? []) {
      fs.writeFileSync(
        path.join(endpoints, `${server.id}.properties`),
        `transport=${server.endpoint.transport}\nhost=${server.endpoint.host}\n` +
          `port=${server.endpoint.port}\npath=${server.endpoint.path}\n`,
        "utf8",
      );
    }
  }

  gateway.addRouteSource({ projectRoot, statePath });
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
  it("registers a declared image that is not running yet", async () => {
    const gateway = new PlexusGateway();
    const declaredState: GatewayProjectState = {
      ...runningState,
      images: [
        runningState.images[0],
        {
          id: "p15",
          imageName: "MyProject-p15",
          status: "stopped",
        },
      ],
    };

    await registerTarget(gateway, declaredState);

    const status = data(
      await gateway.handleTool("plexus_gateway_status", {
        projectId: "project-123",
        workspaceId: "worktree-a",
      }),
    );
    expect(status.images.map((image) => image.mcpServerId)).toEqual(["dev"]);
  });

  it("leaves a running image with no endpoint handoff out of the routes", async () => {
    const gateway = new PlexusGateway();

    await registerTarget(gateway, {
      ...runningState,
      images: [{ id: "dev", imageName: "MyProject-dev", status: "running" }],
    });

    expect(
      data(
        await gateway.handleTool("plexus_gateway_status", {
          projectId: "project-123",
        }),
      ),
    ).toMatchObject({ images: [] });
  });

  it("resolves a route from the project's own files", async () => {
    const gateway = new PlexusGateway();

    await registerTarget(gateway);

    const status = data(
      await gateway.handleTool("plexus_gateway_status", {
        projectId: "project-123",
      }),
    );

    expect(status).toMatchObject({
      projectId: "project-123",
      workspaceId: "worktree-a",
      images: [
        {
          id: "dev",
          imageName: "MyProject-dev",
          port: 7123,
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

  it("includes route metadata explaining how callers provide mcpServerId", async () => {
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
              requiredArgument: "mcpServerId",
              mcpServerId: "dev",
              routeReference: {
                projectId: "project-123",
                workspaceId: "worktree-a",
              },
              mcpServerIdSource:
                "Read images[].mcpServers[].id from gateway status",
              recordHint:
                "Record the selected mcpServerId with the scoped project and workspace before calling pharo_gateway tools",
            },
          }),
        ]),
      }),
    );
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
          mcpServers: mcpServers("dev", 7125),
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
        mcpServerId: "dev",
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
      mcpServerId: "dev",
      toolName: "pharo_eval",
      arguments: {
        code: "Smalltalk version",
      },
    });
    const routed = data(routeResult);

    expect(imageRouter.calls).toMatchObject([
      {
        route: {
          projectId: "project-123",
          workspaceId: "worktree-a",
          imageId: "dev",
          mcpServerId: "dev",
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
        imageId: "dev",
        port: 7123,
      },
    });
    expect(routed).toEqual({
      content: [{ type: "text", text: "routed" }],
    });
  });

  it("routes Pharo MCP calls through an explicit MCP server endpoint", async () => {
    const imageRouter = new FakeImageRouter();
    const endpointState: GatewayProjectState = {
      ...runningState,
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
                port: 9123,
                path: "/mcp",
              },
            },
          ],
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
      mcpServerId: "dev",
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
          endpoint: {
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
        imageId: "dev",
        imageName: "MyProject-dev",
        port: 9123,
        endpoint: {
          transport: "http",
          host: "127.0.0.1",
          port: 9123,
          path: "/mcp",
        },
      },
    });
    expect(imageRouter.calls).toMatchObject([
      {
        route: {
          projectId: "project-123",
          workspaceId: "worktree-a",
          imageId: "dev",
          mcpServerId: "dev",
          imageName: "MyProject-dev",
          port: 9123,
          endpoint: {
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

  it("ignores an endpoint recorded in the state file", async () => {
    const gateway = new PlexusGateway();

    // Only the handoff file names an endpoint. A record that claims one is
    // the stale copy this design exists to stop trusting.
    await registerTarget(gateway, {
      ...runningState,
      images: [
        {
          id: "dev",
          imageName: "MyProject-dev",
          status: "running",
          mcpEndpoint: {
            transport: "http",
            host: "127.0.0.1",
            port: 7123,
            path: "/",
          },
        } as GatewayProjectState["images"][number],
      ],
    });

    expect(
      data(
        await gateway.handleTool("plexus_gateway_status", {
          projectId: "project-123",
        }),
      ),
    ).toMatchObject({ images: [] });
  });

  it("routes to each image by its own mcpServerId", async () => {
    const imageRouter = new FakeImageRouter();
    const gateway = new PlexusGateway({
      imageRouter,
      pharoTools: [pharoEvalTool],
    });

    await registerTarget(gateway, {
      ...runningState,
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
                port: 9123,
                path: "/mcp",
              },
            },
          ],
          status: "running",
        },
        {
          id: "tools",
          imageName: "MyProject-tools",
          mcpServers: [
            {
              id: "tools",
              endpoint: {
                transport: "http",
                host: "127.0.0.1",
                port: 9124,
                path: "/mcp",
              },
            },
          ],
          status: "running",
        },
      ],
    });
    await gateway.callPharoTool("pharo_eval", {
      mcpServerId: "dev",
      imageId: "tool-owned-image-id",
      code: "1 + 1",
    });
    await gateway.callPharoTool("pharo_eval", {
      mcpServerId: "tools",
      code: "2 + 2",
    });

    expect(imageRouter.calls).toMatchObject([
      {
        route: { imageId: "dev", port: 9123 },
        argumentsValue: { imageId: "tool-owned-image-id", code: "1 + 1" },
      },
      {
        route: { imageId: "tools", port: 9124 },
        argumentsValue: { code: "2 + 2" },
      },
    ]);
  });

  it("gives one image exactly one MCP server", async () => {
    const gateway = new PlexusGateway();

    // The handoff file is named after the image, so an image cannot offer two
    // endpoints and two images cannot offer the same one.
    await registerTarget(gateway);

    expect(
      data(
        await gateway.handleTool("plexus_gateway_status", {
          projectId: "project-123",
        }),
      ),
    ).toMatchObject({
      images: expect.arrayContaining([
        expect.objectContaining({ id: "dev", mcpServerId: "dev" }),
      ]),
    });
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
      },
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
      mcpServerId: "dev",
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
              mcpServerId: "dev",
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
          required: ["mcpServerId", "code"],
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

  it("exposes stable Pharo facade tools with a required mcpServerId route field", () => {
    const gateway = new PlexusGateway({
      pharoTools: [pharoEvalTool],
    });

    expect(gateway.listPharoTools()).toMatchObject([
      {
        name: "pharo_eval",
        inputSchema: {
          type: "object",
          properties: {
            mcpServerId: {
              type: "string",
              minLength: 1,
            },
            imageId: {
              type: "string",
            },
            code: {
              type: "string",
            },
          },
          required: ["mcpServerId", "code"],
          additionalProperties: false,
        },
      },
    ]);
  });

  it("routes Pharo facade calls by mcpServerId without consuming a tool imageId", async () => {
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
          mcpServerId: "dev",
          imageId: "tool-owned-image",
          code: "1 + 1",
        }),
      ),
    ).toEqual({
      content: [{ type: "text", text: "routed" }],
    });
    expect(
      data(
        await gateway.callPharoTool("pharo_eval", {
          mcpServerId: "baseline",
          code: "2 + 2",
        }),
      ),
    ).toEqual({
      content: [{ type: "text", text: "routed" }],
    });

    expect(imageRouter.calls).toMatchObject([
      {
        route: {
          projectId: "project-123",
          workspaceId: "worktree-a",
          imageId: "dev",
          mcpServerId: "dev",
          imageName: "MyProject-dev",
          port: 7123,
        },
        toolName: "pharo_eval",
        argumentsValue: {
          imageId: "tool-owned-image",
          code: "1 + 1",
        },
      },
      {
        route: {
          projectId: "project-123",
          workspaceId: "worktree-a",
          imageId: "baseline",
          mcpServerId: "baseline",
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
      error: "mcpServerId is required",
    });
    await expect(
      gateway.callPharoTool("pharo_eval", {
        mcpServerId: "missing",
        code: "1 + 1",
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: "No route is registered for MCP server missing in project project-123",
    });
    await expect(
      gateway.callPharoTool("pharo_eval", {
        mcpServerId: "baseline",
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
      images: [
        {
          id: "dev",
          imageName: "MyProject-worktree-a-dev",
          mcpServers: mcpServers("dev", 7123),
          pid: 1234,
          status: "running",
        },
      ],
    };
    const stateB: GatewayProjectState = {
      ...runningState,
      workspaceId: "worktree-b",
      images: [
        {
          id: "review",
          imageName: "MyProject-worktree-b-review",
          mcpServers: mcpServers("review", 7125),
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
          mcpServerId: "review",
        code: "1 + 1",
      }),
    ).resolves.toMatchObject({
      ok: false,
      error:
        "MCP server review is registered in workspace worktree-b, not worktree-a",
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
          mcpServers: mcpServers("dev", 7123),
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
          mcpServers: mcpServers("baseline", 7124),
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
        mcpServerId: "baseline",
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
          mcpServerId: "dev",
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
          mcpServers: mcpServers("dev", 7123),
          pid: 1234,
          status: "running",
        },
        {
          id: "baseline",
          imageName: "MyProject-baseline",
          mcpServers: mcpServers("baseline", 7124),
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
          imageId: "dev",
        },
        sourceCount: 2,
        sources: [
          {
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
        mcpServerId: "dev",
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
        mcpServerId: "baseline",
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

  it("can select the active Pharo tool schema source by MCP server", async () => {
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
          mcpServers: mcpServers("dev", 7123),
          pid: 1234,
          status: "running",
        },
        {
          id: "baseline",
          imageName: "MyProject-baseline",
          mcpServers: mcpServers("baseline", 7124),
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
        toolSchemaMcpServerId: "baseline",
      }),
    );
    expect(status).toMatchObject({
      pharoToolSchema: {
        state: "mismatched",
        activeVersion: {
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
        mcpServerId: "baseline",
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
        mcpServerId: "dev",
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

  it("rejects missing Pharo tool schema source selection", async () => {
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
          mcpServers: mcpServers("dev", 7123),
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
        toolSchemaMcpServerId: "missing",
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: "No routable MCP server missing provided an available Pharo MCP schema",
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
          mcpServers: mcpServers("legacy", 7123),
          pid: 1234,
          status: "running",
          pharoMcpContract: {
            status: "unsupported",
            actualMajorVersion: 11,
            supportedMajorVersions: [12, 13, 14, 15],
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
    expect(status.images[0]).toHaveProperty("endpoint");

    await expect(
      gateway.callPharoTool("pharo_eval", {
        mcpServerId: "legacy",
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
        mcpServerId: "baseline",
        toolName: "pharo_eval",
      }),
    ).toMatchObject({
      ok: false,
      error: "Image baseline is not running; current status is stopped",
    });
  });

  it("stops listing a project whose state file is gone", async () => {
    const gateway = new PlexusGateway();

    await registerTarget(gateway);
    const route = data(
      await gateway.handleTool("plexus_gateway_status", { projectId: "project-123" }),
    ) as { statePath: string };
    fs.rmSync(route.statePath);

    // Nothing to clean up: a route that is only ever read cannot go stale.
    expect(data(await gateway.handleTool("plexus_gateway_status", {}))).toEqual(
      [],
    );
  });

  it("keeps parallel worktree routes separate for the same project", async () => {
    const stateRoot = makeTempDir("plexus-state-");
    const stateA: GatewayProjectState = {
      ...runningState,
      workspaceId: "worktree-a",
      images: [
        {
          id: "dev",
          imageName: "MyProject-worktree-a-dev",
          mcpServers: mcpServers("dev", 7123),
          pid: 1234,
          status: "running",
        },
      ],
    };
    const stateB: GatewayProjectState = {
      ...runningState,
      workspaceId: "worktree-b",
      images: [
        {
          id: "dev",
          imageName: "MyProject-worktree-b-dev",
          mcpServers: mcpServers("dev", 7125),
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
        images: [{ imageName: "MyProject-worktree-a-dev", port: 7123 }],
      },
      {
        workspaceId: "worktree-b",
        images: [{ imageName: "MyProject-worktree-b-dev", port: 7125 }],
      },
    ]);

    await expect(
      gateway.handleTool("plexus_route_to_image", {
        projectId: "project-123",
        mcpServerId: "dev",
        toolName: "pharo_eval",
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: "Multiple routes match; provide projectId with workspaceId",
    });

    const routeResult = await gateway.handleTool("plexus_route_to_image", {
      projectId: "project-123",
      workspaceId: "worktree-b",
      mcpServerId: "dev",
      toolName: "pharo_eval",
    });
    expect(routeResult).toMatchObject({
      route: {
        projectId: "project-123",
        workspaceId: "worktree-b",
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
