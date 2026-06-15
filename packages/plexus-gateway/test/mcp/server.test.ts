import http from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import { PlexusGateway, type GatewayToolResult } from "../../src/routing/gateway.js";
import type {
  ImageMcpRoute,
  ImageMcpToolRouter,
} from "../../src/routing/imageMcpRouter.js";
import {
  createGatewayServerWithOptions,
  createGatewayFromEnvironment,
  gatewayTools,
  parseGatewayEnvironmentOptions,
  parseGatewayServerCliOptions,
  startGatewayHttpServer,
} from "../../src/mcp/server.js";

const servers: http.Server[] = [];

function freePort(): Promise<number> {
  const server = http.createServer();
  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        if (!address || typeof address === "string") {
          reject(new Error("Expected TCP server address"));
          return;
        }

        resolve(address.port);
      });
    });
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

class DirectRouteGateway extends PlexusGateway {
  override async handleTool(
    name: string,
    _inputValue: unknown,
  ): Promise<GatewayToolResult> {
    if (name !== "plexus_route_to_image") {
      return {
        ok: false,
        error: `Unexpected tool: ${name}`,
      };
    }

    return {
      ok: true,
      data: {
        content: [{ type: "text" as const, text: "routed output" }],
      },
      route: {
        projectId: "project-123",
        workspaceId: "worktree-a",
        targetId: "project-123--worktree-a",
        imageId: "dev",
        imageName: "MyProject-dev",
        port: 7123,
      },
    };
  }
}

class MutableToolListImageRouter implements ImageMcpToolRouter {
  readonly listCalls: ImageMcpRoute[] = [];

  constructor(public tools: Tool[]) {}

  async listTools(route: ImageMcpRoute): Promise<Tool[]> {
    this.listCalls.push(route);
    return this.tools;
  }

  async callTool(): Promise<unknown> {
    return {
      content: [{ type: "text" as const, text: "routed output" }],
    };
  }
}

class ImageSpecificToolListRouter extends MutableToolListImageRouter {
  constructor(private readonly toolsByImageId: Record<string, Tool[]>) {
    super([]);
  }

  override async listTools(route: ImageMcpRoute): Promise<Tool[]> {
    this.listCalls.push(route);
    const tools = this.toolsByImageId[route.imageId];
    if (!tools) {
      throw new Error(`No tools for image ${route.imageId}`);
    }

    return tools;
  }
}

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

async function postMcp(port: number, method: string): Promise<unknown> {
  const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      ...(method === "initialize"
        ? {
            params: {
              protocolVersion: "2024-11-05",
              capabilities: {},
              clientInfo: {
                name: "plexus-gateway-test",
                version: "0.0.0",
              },
            },
          }
        : {}),
    }),
  });

  expect(response.status).toBe(200);
  return response.json();
}

async function postMcpPath(
  port: number,
  path: string,
  method: string,
  params?: Record<string, unknown>,
): Promise<unknown> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      ...(params ? { params } : {}),
      ...(method === "initialize"
        ? {
            params: {
              protocolVersion: "2024-11-05",
              capabilities: {},
              clientInfo: {
                name: "plexus-gateway-test",
                version: "0.0.0",
              },
            },
          }
        : {}),
    }),
  });

  expect(response.status).toBe(200);
  return response.json();
}

const runningState = {
  projectId: "project-123",
  projectName: "Project 123",
  workspaceId: "worktree-a",
  targetId: "project-123--worktree-a",
  updatedAt: "2026-05-17T00:00:00.000Z",
  images: [
    {
      id: "dev",
      imageName: "Project123-dev",
      assignedPort: 7123,
      status: "running",
    },
  ],
};

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await closeServer(server);
  }
});

describe("gateway server", () => {
  it("keeps raw image routing out of the default gateway tool set", () => {
    expect(gatewayTools.map((tool) => tool.name)).toEqual([
      "plexus_gateway_register_target",
      "plexus_gateway_unregister_target",
      "plexus_gateway_status",
      "plexus_gateway_cleanup_stale_routes",
    ]);
  });

  it("uses the gateway surface as the agent-facing Pharo proxy", async () => {
    const server = createGatewayServerWithOptions(
      new PlexusGateway({
        pharoTools: [
          {
            name: "pharo_eval",
            inputSchema: {
              type: "object",
              properties: {
                code: { type: "string" },
              },
              required: ["code"],
            },
          },
        ],
      }),
      {
        surface: "gateway",
      },
    );
    const client = new Client(
      {
        name: "plexus-gateway-test",
        version: "0.0.0",
      },
      {
        capabilities: {},
      },
    );
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      await expect(client.listTools()).resolves.toMatchObject({
        tools: [
          {
            name: "pharo_eval",
            inputSchema: {
              required: ["imageId", "code"],
            },
          },
        ],
      });
      const toolList = await client.listTools();
      expect(toolList.tools.map((tool) => tool.name)).not.toContain(
        "plexus_route_to_image",
      );
      expect(toolList.tools.map((tool) => tool.name)).not.toContain(
        "plexus_gateway_status",
      );
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("refreshes agent-facing Pharo tool schemas from registered image routes", async () => {
    const imageRouter = new MutableToolListImageRouter([
      repositoryOperationTool(["create"]),
    ]);
    const gateway = new PlexusGateway({
      imageRouter,
      pharoTools: [repositoryOperationTool(["create", "update", "pull"])],
      pharoScope: {
        targetId: runningState.targetId,
      },
    });
    const server = createGatewayServerWithOptions(gateway, {
      surface: "gateway",
    });
    const client = new Client(
      {
        name: "plexus-gateway-test",
        version: "0.0.0",
      },
      {
        capabilities: {},
      },
    );
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    await expect(
      gateway.handleTool("plexus_gateway_register_target", {
        projectRoot: "C:/dev/code/project-123",
        statePath: "state.json",
        state: runningState,
      }),
    ).resolves.toMatchObject({ ok: true });
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      await expect(client.listTools()).resolves.toMatchObject({
        tools: [
          expect.objectContaining({
            name: "edit-repository",
            inputSchema: expect.objectContaining({
              properties: expect.objectContaining({
                operation: expect.objectContaining({
                  enum: ["create"],
                }),
              }),
              required: ["imageId", "operation"],
            }),
          }),
        ],
      });

      imageRouter.tools = [repositoryOperationTool(["create", "fetch"])];

      await expect(client.listTools()).resolves.toMatchObject({
        tools: [
          expect.objectContaining({
            name: "edit-repository",
            inputSchema: expect.objectContaining({
              properties: expect.objectContaining({
                operation: expect.objectContaining({
                  enum: ["create", "fetch"],
                }),
              }),
              required: ["imageId", "operation"],
            }),
          }),
        ],
      });
      expect(imageRouter.listCalls).toEqual([
        expect.objectContaining({
          targetId: "project-123--worktree-a",
          imageId: "dev",
          port: 7123,
        }),
        expect.objectContaining({
          targetId: "project-123--worktree-a",
          imageId: "dev",
          port: 7123,
        }),
      ]);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("advertises only the active Pharo tool schema when registered images differ", async () => {
    const imageRouter = new ImageSpecificToolListRouter({
      dev: [repositoryOperationTool(["create"])],
      baseline: [repositoryOperationTool(["create", "fetch"])],
    });
    const gateway = new PlexusGateway({
      imageRouter,
      pharoScope: {
        targetId: runningState.targetId,
      },
    });
    const server = createGatewayServerWithOptions(gateway, {
      surface: "gateway",
    });
    const client = new Client(
      {
        name: "plexus-gateway-test",
        version: "0.0.0",
      },
      {
        capabilities: {},
      },
    );
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    await expect(
      gateway.handleTool("plexus_gateway_register_target", {
        projectRoot: "C:/dev/code/project-123",
        statePath: "state.json",
        state: {
          ...runningState,
          images: [
            runningState.images[0],
            {
              id: "baseline",
              imageName: "Project123-baseline",
              assignedPort: 7124,
              status: "running",
            },
          ],
        },
      }),
    ).resolves.toMatchObject({ ok: true });
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      await expect(client.listTools()).resolves.toMatchObject({
        tools: [
          expect.objectContaining({
            name: "edit-repository",
            inputSchema: expect.objectContaining({
              properties: expect.objectContaining({
                operation: expect.objectContaining({
                  enum: ["create"],
                }),
              }),
              required: ["imageId", "operation"],
            }),
          }),
        ],
      });
      expect(imageRouter.listCalls.map((route) => route.imageId)).toEqual([
        "dev",
        "baseline",
      ]);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("can advertise a requested Pharo tool schema image", async () => {
    const imageRouter = new ImageSpecificToolListRouter({
      dev: [repositoryOperationTool(["create"])],
      baseline: [repositoryOperationTool(["create", "fetch"])],
    });
    const gateway = new PlexusGateway({
      imageRouter,
      pharoScope: {
        targetId: runningState.targetId,
      },
      pharoToolSchemaImageId: "baseline",
    });
    const server = createGatewayServerWithOptions(gateway, {
      surface: "gateway",
    });
    const client = new Client(
      {
        name: "plexus-gateway-test",
        version: "0.0.0",
      },
      {
        capabilities: {},
      },
    );
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    await expect(
      gateway.handleTool("plexus_gateway_register_target", {
        projectRoot: "C:/dev/code/project-123",
        statePath: "state.json",
        state: {
          ...runningState,
          images: [
            runningState.images[0],
            {
              id: "baseline",
              imageName: "Project123-baseline",
              assignedPort: 7124,
              status: "running",
            },
          ],
        },
      }),
    ).resolves.toMatchObject({ ok: true });
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      await expect(client.listTools()).resolves.toMatchObject({
        tools: [
          expect.objectContaining({
            name: "edit-repository",
            inputSchema: expect.objectContaining({
              properties: expect.objectContaining({
                operation: expect.objectContaining({
                  enum: ["create", "fetch"],
                }),
              }),
              required: ["imageId", "operation"],
            }),
          }),
        ],
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("defaults direct server creation to the agent-facing gateway surface", async () => {
    const server = createGatewayServerWithOptions(
      new PlexusGateway({
        pharoTools: [
          {
            name: "pharo_eval",
            inputSchema: {
              type: "object",
              properties: {
                code: { type: "string" },
              },
              required: ["code"],
            },
          },
        ],
      }),
    );
    const client = new Client(
      {
        name: "plexus-gateway-test",
        version: "0.0.0",
      },
      {
        capabilities: {},
      },
    );
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      const toolList = await client.listTools();
      expect(toolList.tools.map((tool) => tool.name)).toEqual(["pharo_eval"]);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("hides raw routing over MCP unless explicitly opted in", async () => {
    const server = createGatewayServerWithOptions(new DirectRouteGateway(), {
      surface: "route-control",
    });
    const client = new Client(
      {
        name: "plexus-gateway-test",
        version: "0.0.0",
      },
      {
        capabilities: {},
      },
    );
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      const toolList = await client.listTools();
      expect(toolList.tools.map((tool) => tool.name)).not.toContain(
        "plexus_route_to_image",
      );
      await expect(
        client.callTool({
          name: "plexus_route_to_image",
          arguments: {
            imageId: "dev",
            toolName: "pharo_eval",
          },
        }),
      ).resolves.toMatchObject({
        isError: true,
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("returns raw routed image MCP results over the gateway surface when opted in", async () => {
    const server = createGatewayServerWithOptions(new DirectRouteGateway(), {
      surface: "gateway",
      exposeRawRoutingTool: true,
    });
    const client = new Client(
      {
        name: "plexus-gateway-test",
        version: "0.0.0",
      },
      {
        capabilities: {},
      },
    );
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      await expect(client.listTools()).resolves.toMatchObject({
        tools: expect.arrayContaining([
          expect.objectContaining({ name: "plexus_route_to_image" }),
        ]),
      });
      const toolList = await client.listTools();
      expect(toolList.tools.map((tool) => tool.name)).not.toContain(
        "plexus_gateway_status",
      );
      await expect(
        client.callTool({
          name: "plexus_route_to_image",
          arguments: {
            imageId: "dev",
            toolName: "pharo_eval",
          },
        }),
      ).resolves.toMatchObject({
        content: [{ type: "text", text: "routed output" }],
        _meta: {
          plexusRoute: {
            projectId: "project-123",
            workspaceId: "worktree-a",
            targetId: "project-123--worktree-a",
            imageId: "dev",
            imageName: "MyProject-dev",
            port: 7123,
          },
        },
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("defaults to stdio mode for MCP clients", () => {
    expect(parseGatewayServerCliOptions([], {})).toEqual({
      transport: "stdio",
      host: "127.0.0.1",
      port: 7331,
      mcpPath: "/mcp",
      routeControlMcpPath: "/control-mcp",
    });
  });

  it("parses explicit service mode from CLI and environment", () => {
    expect(
      parseGatewayServerCliOptions(
        [
          "serve",
          "--host",
          "0.0.0.0",
          "--mcp-path",
          "/agent-mcp",
          "--control-mcp-path",
          "/private-mcp",
        ],
        {
          PLEXUS_MCP_PORT: "8123",
        },
      ),
    ).toEqual({
      transport: "http",
      host: "0.0.0.0",
      port: 8123,
      mcpPath: "/agent-mcp",
      routeControlMcpPath: "/private-mcp",
    });
  });

  it("parses pharo facade scope and tools from environment", () => {
    const pharoTools = [
      {
        name: "pharo_eval",
        inputSchema: {
          type: "object",
          properties: {
            code: { type: "string" },
          },
          required: ["code"],
        },
      },
    ];

    expect(
      parseGatewayEnvironmentOptions({
        PLEXUS_GATEWAY_SURFACE: "gateway",
        PLEXUS_PROJECT_ID: "project-123",
        PLEXUS_WORKSPACE_ID: "task-123",
        PLEXUS_TARGET_ID: "project-123--task-123",
        PLEXUS_PHARO_TOOLS_JSON: JSON.stringify(pharoTools),
        PLEXUS_PHARO_TOOL_SCHEMA_IMAGE_ID: "baseline",
      }),
    ).toEqual({
      surface: "gateway",
      exposeRawRoutingTool: false,
      pharoTools,
      pharoToolSchemaImageId: "baseline",
      pharoScope: {
        projectId: "project-123",
        workspaceId: "task-123",
        targetId: "project-123--task-123",
      },
    });
  });

  it("defaults environment-created servers to the agent-facing gateway surface", () => {
    expect(parseGatewayEnvironmentOptions({})).toMatchObject({
      surface: "gateway",
      exposeRawRoutingTool: false,
      pharoTools: [],
    });
  });

  it("rejects removed gateway surface names", () => {
    for (const surface of ["pharo", "combined", "admin"]) {
      expect(() =>
        parseGatewayEnvironmentOptions({
          PLEXUS_GATEWAY_SURFACE: surface,
        }),
      ).toThrow(/Unsupported PLexus gateway surface/);
    }
  });

  it("creates an agent-facing Pharo proxy gateway from environment", () => {
    const { gateway, serverOptions } = createGatewayFromEnvironment({
      PLEXUS_GATEWAY_SURFACE: "gateway",
      PLEXUS_PROJECT_ID: "project-123",
      PLEXUS_WORKSPACE_ID: "task-123",
      PLEXUS_PHARO_TOOLS_JSON: JSON.stringify([
        {
          name: "pharo_eval",
          inputSchema: {
            type: "object",
            properties: {
              code: { type: "string" },
            },
            required: ["code"],
          },
        },
      ]),
    });

    expect(serverOptions).toEqual({
      surface: "gateway",
      exposeRawRoutingTool: false,
    });
    expect(gateway.listPharoTools()).toMatchObject([
      {
        name: "pharo_eval",
        inputSchema: {
          required: ["imageId", "code"],
        },
      },
    ]);
  });

  it("serves HTTP health in service mode", async () => {
    const port = await freePort();
    const server = await startGatewayHttpServer({
      host: "127.0.0.1",
      port,
    });
    servers.push(server);

    const response = await fetch(`http://127.0.0.1:${port}/health`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      service: "plexus-gateway",
      mcpPath: "/mcp",
      routeControlMcpPath: "/control-mcp",
    });
  });

  it("keeps the default HTTP /mcp path agent-facing", async () => {
    const port = await freePort();
    const server = await startGatewayHttpServer({
      host: "127.0.0.1",
      port,
    });
    servers.push(server);

    await expect(postMcp(port, "initialize")).resolves.toMatchObject({
      result: {
        serverInfo: {
          name: "plexus-gateway",
        },
      },
    });
    await expect(postMcp(port, "tools/list")).resolves.toMatchObject({
      result: {
        tools: [],
      },
    });
    await expect(postMcp(port, "initialize")).resolves.toMatchObject({
      result: {
        serverInfo: {
          name: "plexus-gateway",
        },
      },
    });
  });

  it("serves route-control tools on a separate HTTP MCP path with shared routes", async () => {
    const port = await freePort();
    const server = await startGatewayHttpServer({
      host: "127.0.0.1",
      port,
      gateway: new PlexusGateway({
        pharoTools: [
          {
            name: "pharo_eval",
            inputSchema: {
              type: "object",
              properties: {
                code: { type: "string" },
              },
              required: ["code"],
            },
          },
        ],
      }),
    });
    servers.push(server);

    await expect(postMcpPath(port, "/mcp", "tools/list")).resolves.toMatchObject({
      result: {
        tools: [
          expect.objectContaining({ name: "pharo_eval" }),
        ],
      },
    });
    await expect(
      postMcpPath(port, "/control-mcp", "tools/list"),
    ).resolves.toMatchObject({
      result: {
        tools: expect.arrayContaining([
          expect.objectContaining({ name: "plexus_gateway_register_target" }),
          expect.objectContaining({ name: "plexus_gateway_status" }),
        ]),
      },
    });

    const registerResult = await postMcpPath(port, "/control-mcp", "tools/call", {
      name: "plexus_gateway_register_target",
      arguments: {
        projectRoot: "C:/dev/code/project-123",
        statePath: "state.json",
        state: runningState,
      },
    });
    expect(registerResult).toMatchObject({
      result: {
        content: [
          {
            type: "text",
            text: expect.stringContaining("\"targetId\": \"project-123--worktree-a\""),
          },
        ],
      },
    });

    await expect(
      postMcpPath(port, "/control-mcp", "tools/call", {
        name: "plexus_gateway_status",
        arguments: { targetId: "project-123--worktree-a" },
      }),
    ).resolves.toMatchObject({
      result: {
        content: [
          {
            type: "text",
            text: expect.stringContaining("\"imageName\": \"Project123-dev\""),
          },
        ],
      },
    });

    await expect(postMcpPath(port, "/mcp", "tools/list")).resolves.toMatchObject({
      result: {
        tools: [
          expect.objectContaining({ name: "pharo_eval" }),
        ],
      },
    });
  });
});
