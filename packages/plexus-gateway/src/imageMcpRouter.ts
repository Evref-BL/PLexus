import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export interface ImageMcpRoute {
  projectId: string;
  workspaceId: string;
  targetId: string;
  imageId: string;
  imageName: string;
  port: number;
}

export interface ImageMcpToolRouter {
  callTool(
    route: ImageMcpRoute,
    toolName: string,
    argumentsValue: Record<string, unknown>,
  ): Promise<unknown>;
}

export interface StreamableHttpImageMcpToolRouterOptions {
  host?: string;
  path?: string;
}

export class StreamableHttpImageMcpToolRouter implements ImageMcpToolRouter {
  private readonly host: string;
  private readonly path: string;

  constructor(options: StreamableHttpImageMcpToolRouterOptions = {}) {
    this.host = options.host ?? "127.0.0.1";
    this.path = options.path ?? "/";
  }

  async callTool(
    route: ImageMcpRoute,
    toolName: string,
    argumentsValue: Record<string, unknown>,
  ): Promise<unknown> {
    const client = new Client(
      {
        name: "plexus-gateway",
        version: "0.1.0",
      },
      {
        capabilities: {},
      },
    );
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://${this.host}:${route.port}${this.path}`),
    );

    await client.connect(transport);

    try {
      return await client.callTool({
        name: toolName,
        arguments: argumentsValue,
      });
    } finally {
      await client.close();
    }
  }
}
