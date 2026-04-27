import http from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { PlexusGateway, type ProjectReferenceInput } from "./gateway.js";

const stringSchema = { type: "string", minLength: 1 } as const;
const optionalStringSchema = { type: "string", minLength: 1 } as const;

function objectSchema(
  properties: Record<string, unknown>,
  required: string[] = [],
) {
  return {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  } as const;
}

const projectReferenceProperties = {
  projectPath: optionalStringSchema,
  projectId: optionalStringSchema,
  workspaceId: optionalStringSchema,
  targetId: optionalStringSchema,
  stateRoot: optionalStringSchema,
} as const;

export const gatewayTools = [
  {
    name: "plexus_project_open",
    description:
      "Open a PLexus project: launch active images, update runtime state, and register routes.",
    inputSchema: objectSchema(
      {
        projectPath: stringSchema,
        workspaceId: optionalStringSchema,
        targetId: optionalStringSchema,
        stateRoot: optionalStringSchema,
      },
      ["projectPath"],
    ),
  },
  {
    name: "plexus_project_close",
    description:
      "Close a PLexus project: stop running images and update runtime state.",
    inputSchema: objectSchema(
      {
        projectPath: stringSchema,
        workspaceId: optionalStringSchema,
        stateRoot: optionalStringSchema,
      },
      ["projectPath"],
    ),
  },
  {
    name: "plexus_project_status",
    description:
      "Return gateway route status for a project path, project id, or all registered projects.",
    inputSchema: objectSchema({
      ...projectReferenceProperties,
      refreshHealth: { type: "boolean" },
    }),
  },
  {
    name: "plexus_route_to_image",
    description:
      "Route a Pharo MCP tool call to the MCP server running inside a selected image.",
    inputSchema: objectSchema(
      {
        ...projectReferenceProperties,
        imageId: stringSchema,
        toolName: stringSchema,
        arguments: {
          type: "object",
          additionalProperties: true,
        },
      },
      ["imageId", "toolName"],
    ),
  },
] as const;

export interface GatewayHttpServerOptions {
  host?: string;
  port: number;
  healthPath?: string;
  mcpPath?: string;
}

export interface GatewayCliOptions {
  transport: "stdio" | "http";
  host: string;
  port: number;
}

export type GatewaySurface = "combined" | "gateway" | "pharo";

export interface GatewayServerOptions {
  surface?: GatewaySurface;
}

export interface GatewayEnvironmentOptions {
  surface: GatewaySurface;
  pharoTools: Tool[];
  pharoScope: ProjectReferenceInput;
}

type ToolResult = CallToolResult;

function jsonResult(value: unknown, isError = false): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    ...(isError ? { isError } : {}),
  };
}

function isCallToolResult(value: unknown): value is CallToolResult {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    Array.isArray((value as { content?: unknown }).content)
  );
}

function withToolMeta(
  value: ToolResult,
  meta: Record<string, unknown> | undefined,
): ToolResult {
  if (!meta) {
    return value;
  }

  return {
    ...value,
    _meta: {
      ...(value._meta ?? {}),
      ...meta,
    },
  };
}

function directToolResult(
  value: unknown,
  meta?: Record<string, unknown>,
): ToolResult {
  if (isCallToolResult(value)) {
    return withToolMeta(value as ToolResult, meta);
  }

  return withToolMeta(jsonResult(value), meta);
}

export function createGatewayServer(gateway = new PlexusGateway()): Server {
  return createGatewayServerWithOptions(gateway);
}

export function createGatewayServerWithOptions(
  gateway = new PlexusGateway(),
  options: GatewayServerOptions = {},
): Server {
  const surface = options.surface ?? "combined";
  const server = new Server(
    {
      name: "plexus-gateway",
      version: "0.1.0",
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      ...(surface === "pharo" ? [] : gatewayTools),
      ...(surface === "gateway" ? [] : gateway.listPharoTools()),
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (gateway.isPharoTool(request.params.name)) {
      const result = await gateway.callPharoTool(
        request.params.name,
        request.params.arguments ?? {},
      );

      if (!result.ok) {
        return jsonResult(result, true);
      }

      return directToolResult(result.data);
    }

    if (surface === "pharo") {
      return jsonResult(
        {
          ok: false,
          error: `Unknown Pharo tool: ${request.params.name}`,
        },
        true,
      );
    }

    const result = await gateway.handleTool(
      request.params.name,
      request.params.arguments ?? {},
    );

    if (!result.ok) {
      return jsonResult(result, true);
    }

    if (request.params.name === "plexus_route_to_image") {
      return directToolResult(
        result.data,
        result.route ? { plexusRoute: result.route } : undefined,
      );
    }

    return jsonResult(result);
  });

  return server;
}

function parseJsonArrayEnv(value: string | undefined, name: string): unknown[] {
  if (value === undefined || value.trim().length === 0) {
    return [];
  }

  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error(`${name} must be a JSON array`);
  }

  return parsed;
}

function parseGatewaySurface(value: string | undefined): GatewaySurface {
  if (value === undefined || value.trim().length === 0) {
    return "combined";
  }

  if (value === "combined" || value === "gateway" || value === "pharo") {
    return value;
  }

  throw new Error(`Unsupported PLexus gateway surface: ${value}`);
}

export function parseGatewayEnvironmentOptions(
  env: NodeJS.ProcessEnv = process.env,
): GatewayEnvironmentOptions {
  return {
    surface: parseGatewaySurface(env.PLEXUS_GATEWAY_SURFACE),
    pharoTools: parseJsonArrayEnv(
      env.PLEXUS_PHARO_TOOLS_JSON,
      "PLEXUS_PHARO_TOOLS_JSON",
    ) as Tool[],
    pharoScope: {
      projectPath: env.PLEXUS_PROJECT_ROOT,
      projectId: env.PLEXUS_PROJECT_ID,
      workspaceId: env.PLEXUS_WORKSPACE_ID ?? env.VIBE_KANBAN_WORKSPACE_ID,
      targetId: env.PLEXUS_TARGET_ID,
      stateRoot: env.PLEXUS_STATE_ROOT,
    },
  };
}

export function createGatewayFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): { gateway: PlexusGateway; serverOptions: GatewayServerOptions } {
  const options = parseGatewayEnvironmentOptions(env);
  return {
    gateway: new PlexusGateway({
      pharoTools: options.pharoTools,
      pharoScope: options.pharoScope,
    }),
    serverOptions: {
      surface: options.surface,
    },
  };
}

export async function startGatewayServer(): Promise<void> {
  const environment = createGatewayFromEnvironment();
  const server = createGatewayServerWithOptions(
    environment.gateway,
    environment.serverOptions,
  );
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

function parsePort(value: string | undefined, name: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${name} must be an integer between 1 and 65535`);
  }

  return port;
}

function writeJsonResponse(
  response: http.ServerResponse,
  statusCode: number,
  value: unknown,
): void {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
  });
  response.end(`${JSON.stringify(value)}\n`);
}

function listen(
  server: http.Server,
  port: number,
  host: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };

    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

export async function startGatewayHttpServer(
  options: GatewayHttpServerOptions,
): Promise<http.Server> {
  const host = options.host ?? "127.0.0.1";
  const healthPath = options.healthPath ?? "/health";
  const mcpPath = options.mcpPath ?? "/mcp";
  const environment = createGatewayFromEnvironment();
  const activeTransports = new Set<StreamableHTTPServerTransport>();

  async function handleMcpRequest(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> {
    const gatewayServer = createGatewayServerWithOptions(
      environment.gateway,
      environment.serverOptions,
    );
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    activeTransports.add(transport);
    response.once("close", () => {
      activeTransports.delete(transport);
      void transport.close();
    });

    await gatewayServer.connect(transport);
    await transport.handleRequest(request, response);
  }

  const server = http.createServer((request, response) => {
    void (async () => {
      const url = new URL(
        request.url ?? "/",
        `http://${request.headers.host ?? `${host}:${options.port}`}`,
      );

      if (url.pathname === "/" || url.pathname === healthPath) {
        if (request.method !== "GET" && request.method !== "HEAD") {
          writeJsonResponse(response, 405, {
            ok: false,
            error: "Method not allowed",
          });
          return;
        }

        writeJsonResponse(response, 200, {
          ok: true,
          service: "plexus-gateway",
          mcpPath,
        });
        return;
      }

      if (url.pathname === mcpPath) {
        await handleMcpRequest(request, response);
        return;
      }

      writeJsonResponse(response, 404, {
        ok: false,
        error: "Not found",
      });
    })().catch((error: unknown) => {
      if (!response.headersSent) {
        writeJsonResponse(response, 500, {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
        return;
      }

      response.destroy(error instanceof Error ? error : undefined);
    });
  });

  server.on("close", () => {
    for (const transport of activeTransports) {
      void transport.close();
    }
    activeTransports.clear();
  });

  await listen(server, options.port, host);
  return server;
}

export function parseGatewayServerCliOptions(
  args: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): GatewayCliOptions {
  let transport: GatewayCliOptions["transport"] = "stdio";
  let host = env.PLEXUS_HOST ?? "127.0.0.1";
  let portValue = env.PLEXUS_MCP_PORT ?? env.PORT ?? "7331";

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "serve" || arg === "http" || arg === "--http") {
      transport = "http";
      continue;
    }

    if (arg === "--stdio") {
      transport = "stdio";
      continue;
    }

    if (arg === "--host") {
      const next = args[index + 1];
      if (!next) {
        throw new Error("--host requires a value");
      }

      host = next;
      index += 1;
      continue;
    }

    if (arg === "--port") {
      const next = args[index + 1];
      if (!next) {
        throw new Error("--port requires a value");
      }

      portValue = next;
      index += 1;
      continue;
    }

    throw new Error(`Unknown plexus-gateway argument: ${arg}`);
  }

  return {
    transport,
    host,
    port: parsePort(portValue, "PLexus gateway port"),
  };
}

export async function startGatewayServerFromCli(
  options = parseGatewayServerCliOptions(),
): Promise<void> {
  if (options.transport === "stdio") {
    await startGatewayServer();
    return;
  }

  await startGatewayHttpServer({
    host: options.host,
    port: options.port,
  });
}
