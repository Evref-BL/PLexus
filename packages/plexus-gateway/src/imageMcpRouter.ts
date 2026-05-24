import http from "node:http";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

const imageMcpProtocolVersion = "2025-06-18";
const imageMcpClientInfo = {
  name: "plexus-gateway",
  version: "0.1.0",
} as const;

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

export type ImageMcpLifecycleStatus =
  | "initialized"
  | "unsupported"
  | "failed";

export interface ImageMcpLifecycleInfo {
  status: ImageMcpLifecycleStatus;
  reason?: string;
}

export interface ImageMcpServerInfo {
  name?: string;
  title?: string;
  version?: string;
  [key: string]: unknown;
}

export interface ImageMcpConnectionInfo {
  lifecycle: ImageMcpLifecycleInfo;
  protocolVersion?: string;
  sessionId?: string;
  capabilities?: Record<string, unknown>;
  serverInfo?: ImageMcpServerInfo;
}

export interface ImageMcpToolRouter {
  listTools?(route: ImageMcpRoute): Promise<Tool[]>;
  connectionInfo?(route: ImageMcpRoute): ImageMcpConnectionInfo | undefined;
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

interface JsonRpcHttpResponse {
  payload: unknown;
  sessionId?: string;
}

export class StreamableHttpImageMcpToolRouter implements ImageMcpToolRouter {
  private readonly host: string;
  private readonly path: string;
  private readonly timeoutMs: number;
  private readonly connectionInfoByEndpoint = new Map<
    string,
    ImageMcpConnectionInfo
  >();

  constructor(options: StreamableHttpImageMcpToolRouterOptions = {}) {
    this.host = options.host ?? "127.0.0.1";
    this.path = options.path ?? "/";
    this.timeoutMs = options.timeoutMs ?? 60_000;
  }

  async listTools(route: ImageMcpRoute): Promise<Tool[]> {
    const endpoint = this.endpointForRoute(route);
    const connectionInfo = await this.initializeEndpoint(route, endpoint);
    const response = await this.postJsonRpc(endpoint, {
      jsonrpc: "2.0",
      id: `plexus-${route.targetId}-${route.imageId}-tools-${Date.now()}`,
      method: "tools/list",
    }, {
      protocolVersion: connectionInfo.protocolVersion,
      sessionId: connectionInfo.sessionId,
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
    const endpoint = this.endpointForRoute(route);
    const connectionInfo = await this.initializeEndpoint(route, endpoint);
    const response = await this.postJsonRpc(endpoint, {
      jsonrpc: "2.0",
      id: `plexus-${route.targetId}-${route.imageId}-${Date.now()}`,
      method: "tools/call",
      params: {
        name: toolName,
        arguments: argumentsValue,
      },
    }, {
      protocolVersion: connectionInfo.protocolVersion,
      sessionId: connectionInfo.sessionId,
    });

    if ("error" in response) {
      throw new Error(`MCP error ${jsonRpcErrorText(response.error)}`);
    }

    if (!("result" in response)) {
      throw new Error("MCP response did not include a result");
    }

    return response.result;
  }

  connectionInfo(route: ImageMcpRoute): ImageMcpConnectionInfo | undefined {
    return this.connectionInfoByEndpoint.get(
      this.endpointKey(this.endpointForRoute(route)),
    );
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

  private endpointKey(endpoint: ImageMcpEndpoint): string {
    return `${endpoint.transport}:${endpoint.host}:${endpoint.port}${endpoint.path}`;
  }

  private recordConnectionInfo(
    endpoint: ImageMcpEndpoint,
    info: ImageMcpConnectionInfo,
  ): ImageMcpConnectionInfo {
    this.connectionInfoByEndpoint.set(this.endpointKey(endpoint), info);
    return info;
  }

  private async initializeEndpoint(
    route: ImageMcpRoute,
    endpoint: ImageMcpEndpoint,
  ): Promise<ImageMcpConnectionInfo> {
    let response: Record<string, unknown>;
    let sessionId: string | undefined;
    try {
      const initializeResponse = await this.postJsonRpcWithHttpMetadata(endpoint, {
        jsonrpc: "2.0",
        id: `plexus-${route.targetId}-${route.imageId}-initialize-${Date.now()}`,
        method: "initialize",
        params: {
          protocolVersion: imageMcpProtocolVersion,
          capabilities: {},
          clientInfo: imageMcpClientInfo,
        },
      });
      const payload = initializeResponse.payload;
      if (!isRecord(payload)) {
        throw new Error("MCP response was not a JSON object");
      }
      response = payload;
      sessionId = initializeResponse.sessionId;
    } catch (error) {
      return this.recordConnectionInfo(endpoint, {
        lifecycle: {
          status: "failed",
          reason: error instanceof Error ? error.message : String(error),
        },
      });
    }

    if ("error" in response) {
      return this.recordConnectionInfo(endpoint, {
        lifecycle: {
          status: "unsupported",
          reason: `MCP initialize returned ${jsonRpcErrorText(response.error)}`,
        },
      });
    }

    const result = response.result;
    if (!isRecord(result)) {
      return this.recordConnectionInfo(endpoint, {
        lifecycle: {
          status: "unsupported",
          reason: "MCP initialize response did not include a result object",
        },
      });
    }

    const protocolVersion =
      typeof result.protocolVersion === "string"
        ? result.protocolVersion
        : undefined;
    const capabilities = isRecord(result.capabilities)
      ? result.capabilities
      : undefined;
    const serverInfo = serverInfoFromInitializeResult(result.serverInfo);

    if (!protocolVersion && !capabilities && !serverInfo) {
      return this.recordConnectionInfo(endpoint, {
        lifecycle: {
          status: "unsupported",
          reason: "MCP initialize response did not include protocol metadata",
        },
      });
    }

    const connectionInfo = this.recordConnectionInfo(endpoint, {
      lifecycle: {
        status: "initialized",
      },
      ...(protocolVersion ? { protocolVersion } : {}),
      ...(sessionId ? { sessionId } : {}),
      ...(capabilities ? { capabilities } : {}),
      ...(serverInfo ? { serverInfo } : {}),
    });

    await this.postJsonRpcNotification(
      endpoint,
      {
        jsonrpc: "2.0",
        method: "notifications/initialized",
      },
      { protocolVersion, sessionId },
    ).catch(() => {
      // Some existing image MCP endpoints are stateless and do not implement
      // initialized notifications. Initialization metadata is still useful.
    });

    return connectionInfo;
  }

  private async postJsonRpc(
    endpoint: ImageMcpEndpoint,
    payload: Record<string, unknown>,
    options: { protocolVersion?: string; sessionId?: string } = {},
  ): Promise<Record<string, unknown>> {
    const response = await this.postJsonRpcPayload(endpoint, payload, options);
    if (!isRecord(response.payload)) {
      throw new Error("MCP response was not a JSON object");
    }

    return response.payload;
  }

  private async postJsonRpcWithHttpMetadata(
    endpoint: ImageMcpEndpoint,
    payload: Record<string, unknown>,
    options: { protocolVersion?: string; sessionId?: string } = {},
  ): Promise<JsonRpcHttpResponse> {
    return this.postJsonRpcPayload(endpoint, payload, options);
  }

  private async postJsonRpcNotification(
    endpoint: ImageMcpEndpoint,
    payload: Record<string, unknown>,
    options: { protocolVersion?: string; sessionId?: string } = {},
  ): Promise<void> {
    await this.postJsonRpcPayload(endpoint, payload, options);
  }

  private async postJsonRpcPayload(
    endpoint: ImageMcpEndpoint,
    payload: Record<string, unknown>,
    options: { protocolVersion?: string; sessionId?: string } = {},
  ): Promise<JsonRpcHttpResponse> {
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
            ...(options.protocolVersion
              ? { "MCP-Protocol-Version": options.protocolVersion }
              : {}),
            ...(options.sessionId ? { "Mcp-Session-Id": options.sessionId } : {}),
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

            const sessionId = response.headers["mcp-session-id"];
            resolve({
              payload: data,
              ...(typeof sessionId === "string" ? { sessionId } : {}),
            });
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

function serverInfoFromInitializeResult(
  value: unknown,
): ImageMcpServerInfo | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const serverInfo: ImageMcpServerInfo = {};
  for (const [key, item] of Object.entries(value)) {
    serverInfo[key] = item;
  }

  return serverInfo;
}
