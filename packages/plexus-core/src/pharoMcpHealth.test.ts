import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { HttpPharoMcpHealthClient } from "./pharoMcpHealth.js";

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

describe("pharo MCP health", () => {
  it("treats a JSON-RPC capable MCP server as healthy when GET /health is unsupported", async () => {
    const port = await freePort();
    const server = http.createServer((request, response) => {
      if (request.method === "GET" && request.url === "/health") {
        response.writeHead(405, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "method_not_allowed" }));
        return;
      }

      if (request.method === "POST" && request.url === "/mcp") {
        const chunks: Buffer[] = [];
        request.on("data", (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        request.on("end", () => {
          const payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
            id?: string | number;
          };
          response.writeHead(200, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: payload.id ?? null,
              result: { ok: true },
            }),
          );
        });
        return;
      }

      response.writeHead(404);
      response.end();
    });

    await new Promise<void>((resolve) => {
      server.listen(port, "127.0.0.1", () => resolve());
    });
    servers.push(server);

    const client = new HttpPharoMcpHealthClient({
      host: "127.0.0.1",
      timeoutMs: 1_000,
    });

    await expect(client.check(port)).resolves.toBe(true);
  });
});
