import http from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import { StreamableHttpImageMcpToolRouter } from "./imageMcpRouter.js";

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

function createImageMcpServer(): Server {
  const server = new Server(
    {
      name: "pharo-image-test",
      version: "0.0.0",
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "pharo_eval",
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
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name !== "pharo_eval") {
      return {
        content: [{ type: "text", text: "unexpected tool" }],
        isError: true,
      };
    }

    return {
      content: [{ type: "text", text: "routed" }],
    };
  });

  return server;
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await closeServer(server);
  }
});

describe("StreamableHttpImageMcpToolRouter", () => {
  it("routes to the default image MCP HTTP endpoint at /", async () => {
    const port = await freePort();
    let rootRequests = 0;
    let mcpRequests = 0;

    const httpServer = http.createServer((request, response) => {
      void (async () => {
        const url = new URL(
          request.url ?? "/",
          `http://${request.headers.host ?? `127.0.0.1:${port}`}`,
        );

        if (url.pathname === "/") {
          rootRequests += 1;
          const mcpServer = createImageMcpServer();
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: undefined,
            enableJsonResponse: true,
          });

          await mcpServer.connect(transport);

          try {
            await transport.handleRequest(request, response);
          } finally {
            await transport.close();
            await mcpServer.close();
          }

          return;
        }

        if (url.pathname === "/mcp") {
          mcpRequests += 1;
        }

        response.writeHead(404, {
          "content-type": "application/json; charset=utf-8",
        });
        response.end('{"ok":false,"error":"not_found"}\n');
      })().catch((error: unknown) => {
        response.writeHead(500, {
          "content-type": "application/json; charset=utf-8",
        });
        response.end(
          `${JSON.stringify({
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          })}\n`,
        );
      });
    });

    await new Promise<void>((resolve) => {
      httpServer.listen(port, "127.0.0.1", () => resolve());
    });
    servers.push(httpServer);

    const router = new StreamableHttpImageMcpToolRouter({
      host: "127.0.0.1",
    });

    await expect(
      router.callTool(
        {
          projectId: "project-123",
          workspaceId: "worktree-a",
          targetId: "project-123--worktree-a",
          imageId: "dev",
          imageName: "MyProject-dev",
          port,
        },
        "pharo_eval",
        {
          code: "1 + 1",
        },
      ),
    ).resolves.toMatchObject({
      content: [{ type: "text", text: "routed" }],
    });

    expect(rootRequests).toBeGreaterThan(0);
    expect(mcpRequests).toBe(0);
  });
});
