import fs from "node:fs";
import {
  dirnamePathLike,
  joinPathLike,
} from "../support/pathStyle.js";
import { parseEndpointHandoff } from "./server/routing/endpointHandoffFormat.js";
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
      endpoint: parseEndpointHandoff(fs.readFileSync(filePath, "utf8")),
    };
  } catch (error) {
    return {
      status: "invalid",
      path: filePath,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
