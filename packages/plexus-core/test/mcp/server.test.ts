import http from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PlexusProjectLifecycle } from "../../src/lifecycle/projectLifecycle.js";
import {
  createProjectLifecycleServer,
  parseProjectLifecycleServerCliOptions,
  projectLifecycleTools,
  startProjectLifecycleHttpServer,
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

async function postProjectMcp(
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
                name: "plexus-core-test",
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

describe("project lifecycle server", () => {
  it("owns PLexus lifecycle MCP tools", () => {
    expect(projectLifecycleTools.map((tool) => tool.name)).toEqual([
      "plexus_project_open",
      "plexus_project_close",
      "plexus_project_cleanup",
      "plexus_project_status",
      "plexus_home_image_cache_status",
      "plexus_home_image_cache_flush",
      "plexus_rescue_image",
    ]);
  });

  it("does not expose gateway-owned routing tools", () => {
    expect(projectLifecycleTools.map((tool) => tool.name)).not.toContain(
      "plexus_route_to_image",
    );
    expect(projectLifecycleTools.map((tool) => tool.name)).not.toContain(
      "plexus_gateway_status",
    );
  });

  it("requires an explicit status diagnostics opt-in", () => {
    expect(
      projectLifecycleTools.find((tool) => tool.name === "plexus_project_status"),
    ).toMatchObject({
      inputSchema: {
        properties: {
          includeDiagnostics: { type: "boolean" },
        },
      },
    });
  });

  it("requires an explicit cleanup confirmation before mutation", () => {
    expect(
      projectLifecycleTools.find((tool) => tool.name === "plexus_project_cleanup"),
    ).toMatchObject({
      inputSchema: {
        properties: {
          confirm: { type: "boolean" },
          deleteStateFile: { type: "boolean" },
        },
      },
    });
  });

  it("accepts workspace source paths on lifecycle tools", () => {
    expect(
      projectLifecycleTools.find((tool) => tool.name === "plexus_project_open"),
    ).toMatchObject({
      inputSchema: {
        properties: {
          sourcePath: { type: "string", minLength: 1 },
        },
      },
    });
    expect(
      projectLifecycleTools.find((tool) => tool.name === "plexus_project_status"),
    ).toMatchObject({
      inputSchema: {
        properties: {
          sourcePath: { type: "string", minLength: 1 },
        },
      },
    });
  });

  it("returns lifecycle tool results over MCP", async () => {
    const lifecycle = new PlexusProjectLifecycle();
    const server = createProjectLifecycleServer(lifecycle);
    const client = new Client(
      {
        name: "plexus-core-test",
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
          expect.objectContaining({ name: "plexus_project_status" }),
        ]),
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("parses stdio project MCP transport as the default", () => {
    expect(parseProjectLifecycleServerCliOptions([], {})).toEqual({
      transport: "stdio",
      host: "127.0.0.1",
      port: 7332,
      mcpPath: "/mcp",
    });
  });

  it("parses HTTP project MCP transport options", () => {
    expect(
      parseProjectLifecycleServerCliOptions(
        [
          "--http",
          "--host",
          "0.0.0.0",
          "--port",
          "7444",
          "--mcp-path",
          "/project-mcp",
        ],
        {},
      ),
    ).toEqual({
      transport: "http",
      host: "0.0.0.0",
      port: 7444,
      mcpPath: "/project-mcp",
    });
  });

  it("reads project MCP HTTP defaults from the environment", () => {
    expect(
      parseProjectLifecycleServerCliOptions(["http"], {
        PLEXUS_HOST: "0.0.0.0",
        PLEXUS_PROJECT_MCP_PORT: "7445",
        PLEXUS_PROJECT_MCP_PATH: "/remote-project-mcp",
      }),
    ).toEqual({
      transport: "http",
      host: "0.0.0.0",
      port: 7445,
      mcpPath: "/remote-project-mcp",
    });
  });

  it("uses PORT only when the project MCP port is not explicit", () => {
    expect(
      parseProjectLifecycleServerCliOptions(["http"], {
        PORT: "7446",
      }),
    ).toMatchObject({
      port: 7446,
    });
    expect(
      parseProjectLifecycleServerCliOptions(["http"], {
        PORT: "7446",
        PLEXUS_PROJECT_MCP_PORT: "7447",
      }),
    ).toMatchObject({
      port: 7447,
    });
  });

  it("serves HTTP health in service mode", async () => {
    const port = await freePort();
    const server = await startProjectLifecycleHttpServer({
      host: "127.0.0.1",
      port,
      lifecycle: new PlexusProjectLifecycle(),
    });
    servers.push(server);

    const response = await fetch(`http://127.0.0.1:${port}/health`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      service: "plexus-core",
      mcpPath: "/mcp",
    });
  });

  it("serves lifecycle tools over HTTP MCP", async () => {
    const lifecycle = {
      handleTool: vi.fn(async (name: string, input: unknown) => ({
        ok: true,
        data: {
          name,
          input,
        },
      })),
    } as unknown as PlexusProjectLifecycle;
    const port = await freePort();
    const server = await startProjectLifecycleHttpServer({
      host: "127.0.0.1",
      port,
      lifecycle,
    });
    servers.push(server);

    await expect(
      postProjectMcp(port, "/mcp", "tools/list"),
    ).resolves.toMatchObject({
      result: {
        tools: expect.arrayContaining([
          expect.objectContaining({ name: "plexus_project_status" }),
        ]),
      },
    });

    const result = await postProjectMcp(port, "/mcp", "tools/call", {
      name: "plexus_project_status",
      arguments: {
        projectPath: "/tmp/project",
        includeDiagnostics: true,
      },
    });

    expect(result).toMatchObject({
      result: {
        content: [
          {
            type: "text",
          },
        ],
      },
    });
    expect(lifecycle.handleTool).toHaveBeenCalledWith("plexus_project_status", {
      projectPath: "/tmp/project",
      includeDiagnostics: true,
    });
  });

  it("rejects unknown HTTP paths", async () => {
    const port = await freePort();
    const server = await startProjectLifecycleHttpServer({
      host: "127.0.0.1",
      port,
      lifecycle: new PlexusProjectLifecycle(),
    });
    servers.push(server);

    const response = await fetch(`http://127.0.0.1:${port}/missing`);

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: "Not found",
    });
  });
});
