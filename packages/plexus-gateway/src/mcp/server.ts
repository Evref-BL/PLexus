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
import { PlexusGateway, type GatewayRouteReferenceInput } from "../routing/gateway.js";
import {
  formatToolResultPayload,
  toolResultDetailFromArguments,
  toolResultDetailSchema,
  type ToolResultDetail,
} from "../support/toolResultFormatting.js";

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

const routeReferenceProperties = {
  projectId: optionalStringSchema,
  workspaceId: optionalStringSchema,
  targetId: optionalStringSchema,
  detail: toolResultDetailSchema,
} as const;

const projectStateSchema = {
  type: "object",
  additionalProperties: true,
} as const;

export const gatewayTools = [
  {
    name: "plexus_gateway_register_target",
    description:
      "Register or update one gateway target route from PLexus runtime state.",
    inputSchema: objectSchema(
      {
        projectRoot: stringSchema,
        statePath: stringSchema,
        state: projectStateSchema,
        detail: toolResultDetailSchema,
      },
      ["projectRoot", "statePath", "state"],
    ),
  },
  {
    name: "plexus_gateway_unregister_target",
    description:
      "Remove a registered gateway target route without opening or closing project images.",
    inputSchema: objectSchema(routeReferenceProperties),
  },
  {
    name: "plexus_gateway_status",
    description:
      "Return gateway route status for registered targets/images. Optionally refresh route health or the project-wide Pharo tool schema fingerprint.",
    inputSchema: objectSchema({
      ...routeReferenceProperties,
      refreshHealth: { type: "boolean" },
      refreshTools: { type: "boolean" },
      toolSchemaImageId: optionalStringSchema,
    }),
  },
  {
    name: "plexus_gateway_cleanup_stale_routes",
    description:
      "Remove registered gateway target routes whose runtime state files are gone.",
    inputSchema: objectSchema({ detail: toolResultDetailSchema }),
  },
] as const;

export const rawRoutingTool = {
  name: "plexus_route_to_image",
  description:
    "Route a Pharo MCP tool call to the MCP server running inside a selected image.",
  inputSchema: objectSchema(
    {
      ...routeReferenceProperties,
      imageId: stringSchema,
      toolName: stringSchema,
      arguments: {
        type: "object",
        additionalProperties: true,
      },
    },
    ["imageId", "toolName"],
  ),
} as const;

export type GatewaySurface = "route-control" | "gateway";

export interface GatewayServerOptions {
  surface?: GatewaySurface;
  exposeRawRoutingTool?: boolean;
}

export interface GatewayEnvironmentOptions {
  surface: GatewaySurface;
  exposeRawRoutingTool: boolean;
  pharoTools: Tool[];
  pharoScope: GatewayRouteReferenceInput;
  pharoToolSchemaImageId?: string;
}

function agentGatewaySurface(surface: GatewaySurface): boolean {
  return surface === "gateway";
}

function pharoToolsVisible(surface: GatewaySurface): boolean {
  return agentGatewaySurface(surface);
}

function routeControlToolsVisible(surface: GatewaySurface): boolean {
  return surface === "route-control";
}

function visibleRouteControlTools(exposeRawRoutingTool: boolean): Tool[] {
  return [
    ...gatewayTools,
    ...(exposeRawRoutingTool ? [rawRoutingTool] : []),
  ] as Tool[];
}

function visibleRawRoutingTools(exposeRawRoutingTool: boolean): Tool[] {
  return (exposeRawRoutingTool ? [rawRoutingTool] : []) as Tool[];
}

async function visibleTools(
  gateway: PlexusGateway,
  surface: GatewaySurface,
  exposeRawRoutingTool: boolean,
): Promise<Tool[]> {
  const pharoTools = pharoToolsVisible(surface)
    ? await gateway.refreshPharoTools()
    : [];

  return [
    ...(routeControlToolsVisible(surface)
      ? visibleRouteControlTools(exposeRawRoutingTool)
      : []),
    ...(!routeControlToolsVisible(surface) && exposeRawRoutingTool
      ? visibleRawRoutingTools(exposeRawRoutingTool)
      : []),
    ...pharoTools,
  ];
}

function parseBooleanEnv(value: string | undefined, name: string): boolean {
  if (value === undefined || value.trim().length === 0) {
    return false;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === "true" || normalized === "1" || normalized === "yes") {
    return true;
  }

  if (normalized === "false" || normalized === "0" || normalized === "no") {
    return false;
  }

  throw new Error(`${name} must be true or false`);
}

function optionalStringEnv(value: string | undefined): string | undefined {
  return value && value.trim().length > 0 ? value : undefined;
}

function parseGatewaySurface(value: string | undefined): GatewaySurface {
  if (value === undefined || value.trim().length === 0) {
    return "gateway";
  }

  if (value === "route-control" || value === "gateway") {
    return value;
  }

  throw new Error(
    `Unsupported PLexus gateway surface: ${value}. ` +
      "Use PLEXUS_GATEWAY_SURFACE=gateway for agent-facing /mcp or " +
      "PLEXUS_GATEWAY_SURFACE=route-control for trusted route-control tooling.",
  );
}

export interface GatewayHttpServerOptions {
  host?: string;
  port: number;
  healthPath?: string;
  mcpPath?: string;
  routeControlMcpPath?: string;
  gateway?: PlexusGateway;
  serverOptions?: GatewayServerOptions;
}

export interface GatewayCliOptions {
  transport: "stdio" | "http";
  host: string;
  port: number;
  mcpPath: string;
  routeControlMcpPath: string;
}

type ToolResult = CallToolResult;

function jsonResult(
  value: unknown,
  isError = false,
  detail: ToolResultDetail = "summary",
): ToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(formatToolResultPayload(value, detail), null, 2),
      },
    ],
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
  detail: ToolResultDetail = "summary",
): ToolResult {
  if (isCallToolResult(value)) {
    return withToolMeta(value, meta);
  }

  return withToolMeta(jsonResult(value, false, detail), meta);
}

export function createGatewayServer(gateway = new PlexusGateway()): Server {
  return createGatewayServerWithOptions(gateway);
}

export function createGatewayServerWithOptions(
  gateway = new PlexusGateway(),
  options: GatewayServerOptions = {},
): Server {
  const surface = options.surface ?? "gateway";
  const exposeRawRoutingTool = options.exposeRawRoutingTool ?? false;
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
    tools: await visibleTools(gateway, surface, exposeRawRoutingTool),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const detail = toolResultDetailFromArguments(request.params.arguments);

    if (gateway.isPharoTool(request.params.name) && pharoToolsVisible(surface)) {
      const result = await gateway.callPharoTool(
        request.params.name,
        request.params.arguments ?? {},
      );

      if (!result.ok) {
        return jsonResult(result, true, detail);
      }

      return directToolResult(result.data);
    }

    if (request.params.name === rawRoutingTool.name) {
      if (!exposeRawRoutingTool) {
        return jsonResult(
          {
            ok: false,
            error:
              "Raw image routing is disabled; set PLEXUS_EXPOSE_RAW_ROUTING_TOOL=true to expose plexus_route_to_image.",
          },
          true,
          detail,
        );
      }

      const result = await gateway.handleTool(
        request.params.name,
        request.params.arguments ?? {},
      );

      if (!result.ok) {
        return jsonResult(result, true, detail);
      }

      return directToolResult(
        result.data,
        result.route ? { plexusRoute: result.route } : undefined,
        detail,
      );
    }

    if (agentGatewaySurface(surface)) {
      return jsonResult(
        {
          ok: false,
          error: `Unknown Pharo tool: ${request.params.name}`,
        },
        true,
        detail,
      );
    }

    const result = await gateway.handleTool(
      request.params.name,
      request.params.arguments ?? {},
    );

    if (!result.ok) {
      return jsonResult(result, true, detail);
    }

    return jsonResult(result, false, detail);
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

export function parseGatewayEnvironmentOptions(
  env: NodeJS.ProcessEnv = process.env,
): GatewayEnvironmentOptions {
  return {
    surface: parseGatewaySurface(env.PLEXUS_GATEWAY_SURFACE),
    exposeRawRoutingTool: parseBooleanEnv(
      env.PLEXUS_EXPOSE_RAW_ROUTING_TOOL,
      "PLEXUS_EXPOSE_RAW_ROUTING_TOOL",
    ),
    pharoTools: parseJsonArrayEnv(
      env.PLEXUS_PHARO_TOOLS_JSON,
      "PLEXUS_PHARO_TOOLS_JSON",
    ) as Tool[],
    pharoScope: {
      projectId: env.PLEXUS_PROJECT_ID,
      workspaceId: env.PLEXUS_WORKSPACE_ID ?? env.VIBE_KANBAN_WORKSPACE_ID,
      targetId: env.PLEXUS_TARGET_ID,
    },
    pharoToolSchemaImageId: optionalStringEnv(
      env.PLEXUS_PHARO_TOOL_SCHEMA_IMAGE_ID,
    ),
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
      pharoToolSchemaImageId: options.pharoToolSchemaImageId,
    }),
    serverOptions: {
      surface: options.surface,
      exposeRawRoutingTool: options.exposeRawRoutingTool,
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

function parseHttpPath(value: string | undefined, name: string): string {
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`${name} must be a non-empty HTTP path`);
  }

  const trimmed = value.trim();
  if (!trimmed.startsWith("/")) {
    throw new Error(`${name} must start with /`);
  }

  return trimmed;
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
  const routeControlMcpPath = parseHttpPath(
    options.routeControlMcpPath ?? "/control-mcp",
    "routeControlMcpPath",
  );
  if (routeControlMcpPath === mcpPath) {
    throw new Error("routeControlMcpPath must differ from mcpPath");
  }
  const environment = options.gateway
    ? {
        gateway: options.gateway,
        serverOptions: options.serverOptions ?? {},
      }
    : createGatewayFromEnvironment();
  const configuredSurface = environment.serverOptions.surface ?? "gateway";
  const agentServerOptions: GatewayServerOptions = {
    ...environment.serverOptions,
    surface: agentGatewaySurface(configuredSurface)
      ? configuredSurface
      : "gateway",
  };
  const routeControlServerOptions: GatewayServerOptions = {
    ...environment.serverOptions,
    surface: "route-control",
  };
  const activeTransports = new Set<StreamableHTTPServerTransport>();

  async function handleMcpRequest(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    serverOptions: GatewayServerOptions,
  ): Promise<void> {
    const gatewayServer = createGatewayServerWithOptions(
      environment.gateway,
      serverOptions,
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
          routeControlMcpPath,
        });
        return;
      }

      if (url.pathname === mcpPath) {
        await handleMcpRequest(request, response, agentServerOptions);
        return;
      }

      if (url.pathname === routeControlMcpPath) {
        await handleMcpRequest(request, response, routeControlServerOptions);
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

interface MutableGatewayCliOptions {
  transport: GatewayCliOptions["transport"];
  host: string;
  portValue: string;
  mcpPath: string;
  routeControlMcpPath: string;
}

function gatewayCliOptionValue(
  args: string[],
  index: number,
  arg: string,
): string {
  const next = args[index + 1];
  if (!next) {
    throw new Error(`${arg} requires a value`);
  }

  return next;
}

function applyGatewayCliArgument(
  options: MutableGatewayCliOptions,
  args: string[],
  index: number,
): number {
  const arg = args[index];

  switch (arg) {
    case "serve":
    case "http":
    case "--http":
      options.transport = "http";
      return index;
    case "--stdio":
      options.transport = "stdio";
      return index;
    case "--host":
      options.host = gatewayCliOptionValue(args, index, arg);
      return index + 1;
    case "--port":
      options.portValue = gatewayCliOptionValue(args, index, arg);
      return index + 1;
    case "--mcp-path":
      options.mcpPath = gatewayCliOptionValue(args, index, arg);
      return index + 1;
    case "--control-mcp-path":
      options.routeControlMcpPath = gatewayCliOptionValue(args, index, arg);
      return index + 1;
    default:
      throw new Error(`Unknown plexus-gateway argument: ${arg}`);
  }
}

export function parseGatewayServerCliOptions(
  args: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): GatewayCliOptions {
  const options: MutableGatewayCliOptions = {
    transport: "stdio",
    host: env.PLEXUS_HOST ?? "127.0.0.1",
    portValue: env.PLEXUS_MCP_PORT ?? env.PORT ?? "7331",
    mcpPath: env.PLEXUS_GATEWAY_AGENT_MCP_PATH ?? "/mcp",
    routeControlMcpPath:
      env.PLEXUS_GATEWAY_CONTROL_MCP_PATH ?? "/control-mcp",
  };

  for (let index = 0; index < args.length; index += 1) {
    index = applyGatewayCliArgument(options, args, index);
  }

  return {
    transport: options.transport,
    host: options.host,
    port: parsePort(options.portValue, "PLexus gateway port"),
    mcpPath: parseHttpPath(options.mcpPath, "PLexus gateway MCP path"),
    routeControlMcpPath: parseHttpPath(
      options.routeControlMcpPath,
      "PLexus gateway route-control MCP path",
    ),
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
    mcpPath: options.mcpPath,
    routeControlMcpPath: options.routeControlMcpPath,
  });
}
