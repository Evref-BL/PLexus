import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";

import { PlexusGateway } from "../../src/gateway/server/routing/gateway.js";
import type {
  ImageMcpRoute,
  ImageMcpToolRouter,
} from "../../src/gateway/server/routing/imageMcpRouter.js";
import {
  createPlexusAgentServer,
  type PlexusAgentServerOptions,
} from "../../src/mcp/agentServer.js";
import { launcherHostRunning } from "../support/launcherHost.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

function makeTempDir(prefix: string): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(tempDir);
  return tempDir;
}

const pharoEval: Tool = {
  name: "pharo_eval",
  description: "Evaluate Pharo code in the routed image.",
  inputSchema: { type: "object", properties: {}, required: [] },
};

class FakeImageRouter implements ImageMcpToolRouter {
  readonly calls: Array<{ route: ImageMcpRoute; toolName: string }> = [];

  constructor(private readonly tools: Tool[]) {}

  async listTools(): Promise<Tool[]> {
    return this.tools;
  }

  async callTool(route: ImageMcpRoute, toolName: string): Promise<unknown> {
    this.calls.push({ route, toolName });
    return { content: [{ type: "text", text: "routed to the image" }] };
  }
}

/** A project laid out the way PLexus lays one out, with `dev` running. */
const workspaceId = "worktree-a";

function writeProject(options: { running: boolean }): {
  projectRoot: string;
  stateRoot: string;
} {
  const projectRoot = makeTempDir("plexus-agent-project-");
  const stateRoot = makeTempDir("plexus-agent-state-");
  fs.writeFileSync(
    path.join(projectRoot, "plexus.json"),
    JSON.stringify({
      id: "project-123",
      name: "my-project",
      images: [
        {
          id: "dev",
          imageName: "MyProject-dev",
          mcp: { loadScript: "pharo/load-mcp.st" },
          create: {
            kind: "template",
            templateName: "Pharo 13.0 - 64bit",
            templateCategory: "Official",
          },
        },
      ],
    }),
    "utf8",
  );

  const workspaceDir = path.join(
    stateRoot,
    "projects",
    "project-123",
    "workspaces",
    workspaceId,
  );
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.writeFileSync(
    path.join(workspaceDir, "state.json"),
    JSON.stringify({
      projectId: "project-123",
      projectName: "my-project",
      workspaceId: "project-123",
      updatedAt: "2026-04-25T10:00:00.000Z",
      images: [
        {
          id: "dev",
          imageName: "MyProject-dev",
          status: running() ? "running" : "stopped",
          ...(running() ? { pid: 1234 } : {}),
        },
      ],
    }),
    "utf8",
  );

  if (options.running) {
    const endpoints = path.join(workspaceDir, "mcp-endpoints");
    fs.mkdirSync(endpoints, { recursive: true });
    fs.writeFileSync(
      path.join(endpoints, "dev.properties"),
      "transport=http\nhost=127.0.0.1\nport=7123\npath=/\n",
      "utf8",
    );
  }

  function running(): boolean {
    return options.running;
  }

  return { projectRoot, stateRoot };
}

async function connect(server: ReturnType<typeof createPlexusAgentServer>) {
  const client = new Client(
    { name: "agent", version: "0.0.0" },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  return client;
}

/** The server an agent reaches, over a host that is running nothing. */
async function connectAgentServer(
  options: Omit<PlexusAgentServerOptions, "workspaceId">,
) {
  return await connect(
    createPlexusAgentServer({
      workspaceId,
      pharoLauncherMcpClient: launcherHostRunning(),
      ...options,
    }),
  );
}

describe("plexus agent server", () => {
  it("serves the launcher tools when no image is running", async () => {
    const { projectRoot, stateRoot } = writeProject({ running: false });
    const client = await connectAgentServer({
      projectRoot,
      stateRoot,
      gateway: new PlexusGateway({
        imageRouter: new FakeImageRouter([pharoEval]),
      }),
    });

    const names = (await client.listTools()).tools.map((tool) => tool.name);

    expect(names).toContain("pharo_launcher_image_start");
    // A stopped image has no tools to advertise, and that is not an error:
    // the launcher tools are how the caller gets one running.
    expect(names).not.toContain("pharo_eval");
  });

  it("adds the running image's own tools to the same list", async () => {
    const { projectRoot, stateRoot } = writeProject({ running: true });
    const client = await connectAgentServer({
      projectRoot,
      stateRoot,
      gateway: new PlexusGateway({
        imageRouter: new FakeImageRouter([pharoEval]),
      }),
    });

    const names = (await client.listTools()).tools.map((tool) => tool.name);

    expect(names).toContain("pharo_launcher_image_list");
    expect(names).toContain("pharo_eval");
  });

  it("routes a Pharo call to the image and a launcher call to the launcher", async () => {
    const { projectRoot, stateRoot } = writeProject({ running: true });
    const imageRouter = new FakeImageRouter([pharoEval]);
    const client = await connectAgentServer({
      projectRoot,
      stateRoot,
      gateway: new PlexusGateway({ imageRouter }),
    });
    await client.listTools();

    const routed = await client.callTool({
      name: "pharo_eval",
      arguments: { mcpServerId: "dev", source: "42" },
    });

    expect(imageRouter.calls.map((call) => call.toolName)).toEqual([
      "pharo_eval",
    ]);
    expect(routed.content).toEqual([
      { type: "text", text: "routed to the image" },
    ]);

    // The launcher half answers from the project, not from the image.
    const listed = await client.callTool({
      name: "pharo_launcher_image_list",
      arguments: {},
    });

    expect(JSON.stringify(listed.content)).toContain("project-123");
    expect(imageRouter.calls).toHaveLength(1);
  });
});
