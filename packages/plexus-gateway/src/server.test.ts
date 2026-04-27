import http from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { PlexusGateway, type GatewayToolResult } from "./gateway.js";
import {
  createGatewayServerWithOptions,
  createGatewayFromEnvironment,
  gatewayTools,
  parseGatewayServerCliOptions,
  parseGatewayEnvironmentOptions,
  startGatewayHttpServer,
} from "./server.js";

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

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await closeServer(server);
  }
});

describe("gateway server", () => {
  it("exposes the PLexus gateway tools", () => {
    expect(gatewayTools.map((tool) => tool.name)).toEqual([
      "plexus_project_open",
      "plexus_project_close",
      "plexus_project_status",
      "plexus_route_to_image",
    ]);
  });

  it("returns routed image MCP results directly over MCP", async () => {
    const server = createGatewayServerWithOptions(new DirectRouteGateway(), {
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

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
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
    });
  });

  it("parses explicit service mode from CLI and environment", () => {
    expect(
      parseGatewayServerCliOptions(["serve", "--host", "0.0.0.0"], {
        PLEXUS_MCP_PORT: "8123",
      }),
    ).toEqual({
      transport: "http",
      host: "0.0.0.0",
      port: 8123,
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
        PLEXUS_GATEWAY_SURFACE: "pharo",
        PLEXUS_PROJECT_ROOT: "C:\\dev\\code\\git\\Project-worktree",
        PLEXUS_PROJECT_ID: "project-123",
        PLEXUS_WORKSPACE_ID: "task-123",
        PLEXUS_TARGET_ID: "project-123--task-123",
        PLEXUS_STATE_ROOT: "C:\\dev\\code\\git\\.plexus-state",
        PLEXUS_PHARO_TOOLS_JSON: JSON.stringify(pharoTools),
      }),
    ).toEqual({
      surface: "pharo",
      pharoTools,
      pharoScope: {
        projectPath: "C:\\dev\\code\\git\\Project-worktree",
        projectId: "project-123",
        workspaceId: "task-123",
        targetId: "project-123--task-123",
        stateRoot: "C:\\dev\\code\\git\\.plexus-state",
      },
    });
  });

  it("creates a pharo-only gateway from environment", () => {
    const { gateway, serverOptions } = createGatewayFromEnvironment({
      PLEXUS_GATEWAY_SURFACE: "pharo",
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

    expect(serverOptions).toEqual({ surface: "pharo" });
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
    });
  });

  it("handles repeated stateless HTTP MCP requests", async () => {
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
        tools: expect.arrayContaining([
          expect.objectContaining({ name: "plexus_project_status" }),
        ]),
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
});
