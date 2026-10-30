import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";

import { loadProjectConfig } from "../config/projectConfig.js";
import { PlexusGateway } from "../gateway/server/routing/gateway.js";
import {
  callScopedPharoLauncherTool,
  ScopedPharoLauncher,
  scopedPharoLauncherTools,
  type ScopedPharoLauncherOptions,
} from "../launcher/scopedPharoLauncherServer.js";
import { projectStatePathForConfig } from "../workspace/projectState.js";

export interface PlexusAgentServerOptions extends ScopedPharoLauncherOptions {
  gateway?: PlexusGateway;
}

const launcherToolNames = new Set<string>(
  scopedPharoLauncherTools.map((tool) => tool.name),
);

function jsonResult(value: unknown, isError: boolean): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    ...(isError ? { isError: true } : {}),
  };
}

/**
 * The one server an agent connects to: the project's images, and the live tools
 * of whichever image is running. Routes are discovered from the project's own
 * files when a call arrives, so this process holds no registry and nothing to
 * lose when the agent restarts it.
 */
export function createPlexusAgentServer(
  options: PlexusAgentServerOptions,
): Server {
  const facade = new ScopedPharoLauncher(options);
  const gateway = options.gateway ?? new PlexusGateway();
  const config = loadProjectConfig(options.projectRoot);
  gateway.addRouteSource({
    projectRoot: options.projectRoot,
    statePath: projectStatePathForConfig({
      projectRoot: options.projectRoot,
      config,
      ...(options.workspaceId === undefined
        ? {}
        : { workspaceId: options.workspaceId }),
      ...(options.stateRoot === undefined
        ? {}
        : { stateRoot: options.stateRoot }),
    }),
  });

  const server = new Server(
    { name: "plexus", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    // A stopped image advertises no tools rather than failing the listing:
    // the launcher tools are how a caller gets one running.
    let pharoTools: Tool[] = [];
    try {
      pharoTools = await gateway.refreshPharoTools();
    } catch {
      pharoTools = [];
    }

    return { tools: [...scopedPharoLauncherTools, ...pharoTools] };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name } = request.params;
    if (launcherToolNames.has(name)) {
      return await callScopedPharoLauncherTool(
        facade,
        name,
        request.params.arguments,
      );
    }

    if (gateway.isPharoTool(name)) {
      const result = await gateway.callPharoTool(
        name,
        request.params.arguments ?? {},
      );

      return result.ok
        ? (result.data as CallToolResult)
        : jsonResult(result, true);
    }

    const result = await gateway.handleTool(
      name,
      request.params.arguments ?? {},
    );

    return jsonResult(result, !result.ok);
  });

  return server;
}

export async function startPlexusAgentServer(
  options: PlexusAgentServerOptions,
): Promise<void> {
  const server = createPlexusAgentServer(options);
  await server.connect(new StdioServerTransport());
}
