import fs from "node:fs";
import {
  dirnamePathLike,
  joinPathLike,
} from "../support/pathStyle.js";
import {
  projectStateDirectoryPath,
  type ProjectImageMcpEndpoint,
  type ProjectStatePathOptions,
} from "../workspace/projectState.js";

export const projectImageMcpEndpointDirectoryName = "mcp-endpoints";

export interface ProjectImageMcpEndpointHandoffPathOptions
  extends ProjectStatePathOptions {
  imageId: string;
}

export type ProjectImageMcpEndpointHandoffReadResult =
  | { status: "missing"; path: string }
  | { status: "valid"; path: string; endpoint: ProjectImageMcpEndpoint }
  | { status: "invalid"; path: string; error: string };

export function imageMcpEndpointHandoffFileName(imageId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(imageId)) {
    throw new Error(
      `Image id must be file-safe to generate an MCP endpoint handoff path: ${imageId}`,
    );
  }

  return `${imageId}.properties`;
}

export function imageMcpEndpointHandoffDirectoryPath(
  options: Omit<ProjectImageMcpEndpointHandoffPathOptions, "imageId">,
): string {
  return joinPathLike(
    projectStateDirectoryPath(options),
    projectImageMcpEndpointDirectoryName,
  );
}

export function imageMcpEndpointHandoffPath(
  options: ProjectImageMcpEndpointHandoffPathOptions,
): string {
  return joinPathLike(
    imageMcpEndpointHandoffDirectoryPath(options),
    imageMcpEndpointHandoffFileName(options.imageId),
  );
}

export function removeImageMcpEndpointHandoff(filePath: string): void {
  fs.rmSync(filePath, { force: true });
}

function parseProperties(source: string): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const separator = line.indexOf("=");
    if (separator <= 0) {
      throw new Error(`Invalid endpoint handoff line: ${rawLine}`);
    }

    parsed[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }

  return parsed;
}

function validatedEndpoint(
  properties: Record<string, string>,
): ProjectImageMcpEndpoint {
  const transport = properties.transport;
  if (transport !== "http") {
    throw new Error(
      `MCP endpoint transport must be http, got ${transport || "<missing>"}`,
    );
  }

  const host = properties.host;
  if (!host) {
    throw new Error("MCP endpoint host is missing");
  }

  const port = Number.parseInt(properties.port ?? "", 10);
  if (
    !Number.isInteger(port) ||
    String(port) !== properties.port ||
    port < 1 ||
    port > 65_535
  ) {
    throw new Error(
      `MCP endpoint port must be an integer between 1 and 65535, got ${properties.port ?? "<missing>"}`,
    );
  }

  const path = properties.path;
  if (!path || !path.startsWith("/")) {
    throw new Error("MCP endpoint path must start with /");
  }

  return { transport, host, port, path };
}

export function readImageMcpEndpointHandoff(
  filePath: string,
): ProjectImageMcpEndpointHandoffReadResult {
  if (!fs.existsSync(filePath)) {
    return { status: "missing", path: filePath };
  }

  try {
    return {
      status: "valid",
      path: filePath,
      endpoint: validatedEndpoint(
        parseProperties(fs.readFileSync(filePath, "utf8")),
      ),
    };
  } catch (error) {
    return {
      status: "invalid",
      path: filePath,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function ensureImageMcpEndpointHandoffDirectory(filePath: string): void {
  fs.mkdirSync(dirnamePathLike(filePath), { recursive: true });
}
