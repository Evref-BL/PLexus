import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  gatewayTools,
  parseGatewayServerCliOptions,
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
});
