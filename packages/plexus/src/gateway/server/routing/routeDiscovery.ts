import fs from "node:fs";
import path from "node:path";

import { parseEndpointHandoff } from "./endpointHandoffFormat.js";
import type {
  GatewayImageMcpEndpoint,
  GatewayProjectImageMcpServer,
  GatewayProjectState,
} from "./routingTable.js";

/**
 * Where a project keeps the two things a route is made of: the state file that
 * says which images are declared, and the handoff files the images write when
 * their MCP binds.
 */
export interface RouteDiscoverySource {
  projectRoot: string;
  statePath: string;
}

export interface RouteDiscoveryDependencies {
  readFile?: (filePath: string) => string;
  exists?: (filePath: string) => boolean;
}

export const mcpEndpointDirectoryName = "mcp-endpoints";

export function endpointHandoffPath(statePath: string, imageId: string): string {
  return path.join(
    path.dirname(statePath),
    mcpEndpointDirectoryName,
    `${imageId}.properties`,
  );
}

export function readProjectState(
  statePath: string,
  dependencies: RouteDiscoveryDependencies = {},
): GatewayProjectState | undefined {
  const exists = dependencies.exists ?? fs.existsSync;
  const readFile =
    dependencies.readFile ?? ((filePath) => fs.readFileSync(filePath, "utf8"));
  if (!exists(statePath)) {
    return undefined;
  }

  try {
    return JSON.parse(readFile(statePath)) as GatewayProjectState;
  } catch {
    return undefined;
  }
}

/**
 * The image's own answer to "where do I listen", read when asked. A declared
 * image with no handoff file has no endpoint, which is the same thing the host
 * would tell you.
 */
export function discoverImageMcpServers(
  statePath: string,
  imageId: string,
  dependencies: RouteDiscoveryDependencies = {},
): GatewayProjectImageMcpServer[] {
  const endpoint = readEndpointHandoff(
    endpointHandoffPath(statePath, imageId),
    dependencies,
  );

  return endpoint === undefined ? [] : [{ id: imageId, endpoint }];
}

function readEndpointHandoff(
  filePath: string,
  dependencies: RouteDiscoveryDependencies,
): GatewayImageMcpEndpoint | undefined {
  const exists = dependencies.exists ?? fs.existsSync;
  const readFile =
    dependencies.readFile ?? ((candidate) => fs.readFileSync(candidate, "utf8"));
  if (!exists(filePath)) {
    return undefined;
  }

  // A handoff this cannot read is a handoff with no route. Refusing to route
  // is the safe half of that: the alternative was reading a port out of
  // something malformed and sending tool calls to it.
  try {
    return parseEndpointHandoff(readFile(filePath));
  } catch {
    return undefined;
  }
}
