import http from "node:http";
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

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await closeServer(server);
  }
});

describe("StreamableHttpImageMcpToolRouter", () => {
  it("posts tools/call JSON-RPC to the default image MCP HTTP endpoint at /", async () => {
    const port = await freePort();
    let rootRequests = 0;
    let mcpRequests = 0;
    let requestPayload: unknown;

    const httpServer = http.createServer((request, response) => {
      void (async () => {
        const url = new URL(
          request.url ?? "/",
          `http://${request.headers.host ?? `127.0.0.1:${port}`}`,
        );

        if (url.pathname === "/") {
          rootRequests += 1;
          const chunks: Buffer[] = [];
          for await (const chunk of request) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          }
          requestPayload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          response.writeHead(200, {
            "content-type": "application/json; charset=utf-8",
          });
          response.end(
            `${JSON.stringify({
              jsonrpc: "2.0",
              id: "test-response",
              result: {
                content: [{ type: "text", text: "routed" }],
              },
            })}\n`,
          );

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
    expect(requestPayload).toMatchObject({
      jsonrpc: "2.0",
      method: "tools/call",
      params: {
        name: "pharo_eval",
        arguments: {
          code: "1 + 1",
        },
      },
    });
  });

  it("reports JSON-RPC errors from routed image MCP calls", async () => {
    const port = await freePort();
    const httpServer = http.createServer((_request, response) => {
      response.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
      });
      response.end(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: "test-response",
          error: {
            code: -32601,
            message: "Method not found",
          },
        })}\n`,
      );
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
        "missing",
        {},
      ),
    ).rejects.toThrow("MCP error -32601: Method not found");
  });
});
