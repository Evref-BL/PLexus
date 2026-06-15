import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { PlexusGateway, type GatewayToolResult } from "../../src/routing/gateway.js";
import { createGatewayServerWithOptions } from "../../src/mcp/server.js";

function textPayload(result: unknown): Record<string, unknown> {
  const content = (result as { content?: Array<{ type: string; text?: string }> })
    .content;
  const text = content?.find((item) => item.type === "text")?.text;
  if (!text) {
    throw new Error("Expected text MCP result content");
  }

  return JSON.parse(text) as Record<string, unknown>;
}

async function callGatewayStatus(
  result: GatewayToolResult,
  detail?: "summary" | "full",
) {
  class FakeGateway extends PlexusGateway {
    override async handleTool(): Promise<GatewayToolResult> {
      return result;
    }
  }

  const server = createGatewayServerWithOptions(new FakeGateway(), {
    surface: "route-control",
  });
  const client = new Client({
    name: "plexus-gateway-compact-test",
    version: "0.0.0",
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);

  try {
    await client.connect(clientTransport);
    return textPayload(
      await client.callTool({
        name: "plexus_gateway_status",
        arguments: {
          targetId: "target-123",
          ...(detail ? { detail } : {}),
        },
      }),
    );
  } finally {
    await client.close();
  }
}

describe("gateway server compact results", () => {
  it("compacts route-control responses by default and keeps full detail opt-in", async () => {
    const stderr = "gateway route probe ".repeat(150);
    const routes = Array.from({ length: 13 }, (_, index) => ({
      targetId: `target-${index}`,
      imageId: `image-${index}`,
    }));
    const result: GatewayToolResult = {
      ok: true,
      data: {
        routes,
        probe: {
          stderr,
        },
      },
    };

    const compact = await callGatewayStatus(result);
    expect(compact.data).toMatchObject({
      routes: {
        count: 13,
        omittedCount: 3,
      },
      probe: {
        stderr: {
          kind: "truncated-text",
          length: stderr.length,
        },
      },
    });

    const full = await callGatewayStatus(result, "full");
    expect(full).toMatchObject({
      data: {
        routes,
        probe: {
          stderr,
        },
      },
    });
  });
});
