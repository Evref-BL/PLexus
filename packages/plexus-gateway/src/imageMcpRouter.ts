import http from "node:http";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

export type ImageMcpEndpointTransport = "http";

export interface ImageMcpEndpoint {
  transport: ImageMcpEndpointTransport;
  host: string;
  port: number;
  path: string;
}

export interface ImageMcpRoute {
  projectId: string;
  workspaceId: string;
  targetId: string;
  imageId: string;
  imageName: string;
  port?: number;
  mcpEndpoint?: ImageMcpEndpoint;
}

export interface ImageMcpToolRouter {
  listTools?(route: ImageMcpRoute): Promise<Tool[]>;
  callTool(
    route: ImageMcpRoute,
    toolName: string,
    argumentsValue: Record<string, unknown>,
  ): Promise<unknown>;
}

export interface StreamableHttpImageMcpToolRouterOptions {
  host?: string;
  path?: string;
  timeoutMs?: number;
}

export class StreamableHttpImageMcpToolRouter implements ImageMcpToolRouter {
  private readonly host: string;
  private readonly path: string;
  private readonly timeoutMs: number;

  constructor(options: StreamableHttpImageMcpToolRouterOptions = {}) {
    this.host = options.host ?? "127.0.0.1";
    this.path = options.path ?? "/";
    this.timeoutMs = options.timeoutMs ?? 60_000;
  }

  async listTools(route: ImageMcpRoute): Promise<Tool[]> {
    const response = await this.postJsonRpc(this.endpointForRoute(route), {
      jsonrpc: "2.0",
      id: `plexus-${route.targetId}-${route.imageId}-tools-${Date.now()}`,
      method: "tools/list",
    });

    if ("error" in response) {
      throw new Error(`MCP error ${jsonRpcErrorText(response.error)}`);
    }

    const result = response.result;
    if (!isRecord(result) || !Array.isArray(result.tools)) {
      throw new Error("MCP tools/list response did not include result.tools");
    }

    return result.tools.map(toolFromMcpListItem);
  }

  async callTool(
    route: ImageMcpRoute,
    toolName: string,
    argumentsValue: Record<string, unknown>,
  ): Promise<unknown> {
    const response = await this.postJsonRpc(this.endpointForRoute(route), {
      jsonrpc: "2.0",
      id: `plexus-${route.targetId}-${route.imageId}-${Date.now()}`,
      method: "tools/call",
      params: {
        name: toolName,
        arguments: argumentsValue,
      },
    });

    if ("error" in response) {
      throw new Error(`MCP error ${jsonRpcErrorText(response.error)}`);
    }

    if (!("result" in response)) {
      throw new Error("MCP response did not include a result");
    }

    return response.result;
  }

  private endpointForRoute(route: ImageMcpRoute): ImageMcpEndpoint {
    if (route.mcpEndpoint) {
      return route.mcpEndpoint;
    }

    if (route.port === undefined) {
      throw new Error(
        `Image route ${route.imageId} has no registered MCP endpoint`,
      );
    }

    return {
      transport: "http",
      host: this.host,
      port: route.port,
      path: this.path,
    };
  }

  private async postJsonRpc(
    endpoint: ImageMcpEndpoint,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (endpoint.transport !== "http") {
      throw new Error(`Unsupported image MCP endpoint: ${endpoint.transport}`);
    }

    const body = JSON.stringify(payload);

    return new Promise((resolve, reject) => {
      const request = http.request(
        {
          hostname: endpoint.host,
          port: endpoint.port,
          path: endpoint.path,
          method: "POST",
          headers: {
            accept: "application/json, text/event-stream",
            "content-type": "application/json",
            "content-length": Buffer.byteLength(body),
            connection: "close",
          },
          timeout: this.timeoutMs,
        },
        (response) => {
          const chunks: Buffer[] = [];

          response.on("data", (chunk: Buffer | string) => {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          });
          response.on("end", () => {
            if (
              response.statusCode === undefined ||
              response.statusCode < 200 ||
              response.statusCode >= 300
            ) {
              reject(
                new Error(
                  `HTTP ${response.statusCode ?? "unknown"} ${
                    response.statusMessage ?? ""
                  }`.trim(),
                ),
              );
              return;
            }

            let data: unknown;
            try {
              data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            } catch (error) {
              reject(
                new Error(
                  `MCP response was not valid JSON: ${
                    error instanceof Error ? error.message : String(error)
                  }`,
                ),
              );
              return;
            }

            if (!isRecord(data)) {
              reject(new Error("MCP response was not a JSON object"));
              return;
            }

            resolve(data);
          });
        },
      );

      request.on("timeout", () => {
        request.destroy(
          new Error(`MCP request timed out after ${this.timeoutMs}ms`),
        );
      });
      request.on("error", reject);
      request.end(body);
    });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function toolFromMcpListItem(value: unknown, index: number): Tool {
  if (!isRecord(value) || typeof value.name !== "string") {
    throw new Error(`MCP tools/list returned an invalid tool at index ${index}`);
  }

  if (!isRecord(value.inputSchema)) {
    throw new Error(
      `MCP tools/list returned tool ${value.name} without an inputSchema object`,
    );
  }

  return value as Tool;
}

function jsonRpcErrorText(value: unknown): string {
  if (!isRecord(value)) {
    return JSON.stringify(value);
  }

  const code = typeof value.code === "number" ? value.code : undefined;
  const message =
    typeof value.message === "string" ? value.message : JSON.stringify(value);

  return code === undefined ? message : `${code}: ${message}`;
}
