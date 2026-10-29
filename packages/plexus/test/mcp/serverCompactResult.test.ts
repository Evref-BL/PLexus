import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { PlexusProjectLifecycle } from "../../src/lifecycle/projectLifecycle.js";
import { createProjectLifecycleServer } from "../../src/mcp/server.js";

function textPayload(result: unknown): Record<string, unknown> {
  const content = (result as { content?: Array<{ type: string; text?: string }> })
    .content;
  const text = content?.find((item) => item.type === "text")?.text;
  if (!text) {
    throw new Error("Expected text MCP result content");
  }

  return JSON.parse(text) as Record<string, unknown>;
}

async function callStatus(payload: unknown, detail?: "summary" | "full") {
  class FakeLifecycle extends PlexusProjectLifecycle {
    override async handleTool(): Promise<unknown> {
      return payload;
    }
  }

  const server = createProjectLifecycleServer(new FakeLifecycle());
  const client = new Client({
    name: "plexus-core-compact-test",
    version: "0.0.0",
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);

  try {
    await client.connect(clientTransport);
    return textPayload(
      await client.callTool({
        name: "plexus_project_status",
        arguments: {
          projectPath: "/project",
          ...(detail ? { detail } : {}),
        },
      }),
    );
  } finally {
    await client.close();
  }
}

describe("project lifecycle server compact results", () => {
  it("compacts high-volume lifecycle responses by default and keeps full detail opt-in", async () => {
    const verboseLog = "startup ".repeat(260);
    const images = Array.from({ length: 12 }, (_, index) => ({
      id: `image-${index}`,
      status: "running",
    }));
    const payload = {
      ok: true,
      state: {
        projectId: "project-123",
        images,
      },
      launcher: {
        stdout: verboseLog,
      },
    };

    const compact = await callStatus(payload);
    expect(compact.state).toMatchObject({
      images: {
        count: 12,
        omittedCount: 2,
      },
    });
    expect(compact.launcher).toMatchObject({
      stdout: {
        kind: "truncated-text",
        length: verboseLog.length,
      },
    });

    const full = await callStatus(payload, "full");
    expect(full).toMatchObject({
      state: {
        images,
      },
      launcher: {
        stdout: verboseLog,
      },
    });
  });
});
