import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { PlexusProjectLifecycle } from "./projectLifecycle.js";
import {
  createProjectLifecycleServer,
  projectLifecycleTools,
} from "./server.js";

describe("project lifecycle server", () => {
  it("owns PLexus lifecycle MCP tools", () => {
    expect(projectLifecycleTools.map((tool) => tool.name)).toEqual([
      "plexus_project_open",
      "plexus_project_close",
      "plexus_project_status",
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
});
