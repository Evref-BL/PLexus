import http from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import {
  PlexusProjectLifecycle,
  createProjectLifecycleFromEnvironment,
} from "./projectLifecycle.js";
import {
  formatToolResultPayload,
  toolResultDetailFromArguments,
  toolResultDetailSchema,
  type ToolResultDetail,
} from "./toolResultFormatting.js";

const stringSchema = { type: "string", minLength: 1 } as const;
const optionalStringSchema = { type: "string", minLength: 1 } as const;
const displayModeSchema = {
  type: "string",
  enum: ["headless", "interactive"],
} as const;

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
  sourcePath: optionalStringSchema,
  projectId: optionalStringSchema,
  workspaceId: optionalStringSchema,
  targetId: optionalStringSchema,
  stateRoot: optionalStringSchema,
  detail: toolResultDetailSchema,
} as const;

const historyEntrySelectionSchema = objectSchema({
  indexes: {
    type: "array",
    items: { type: "integer" },
  },
  entryReferences: {
    type: "array",
    items: stringSchema,
  },
  startIndex: { type: "integer" },
  endIndex: { type: "integer" },
  latestCount: { type: "integer", minimum: 1 },
});

const repositoryActionSchema = objectSchema(
  {
    label: optionalStringSchema,
    toolName: {
      type: "string",
      enum: ["load_repository", "edit_repository"],
    },
    arguments: {
      type: "object",
      additionalProperties: true,
    },
  },
  ["arguments"],
);

export const projectLifecycleTools = [
  {
    name: "plexus_project_open",
    description:
      "Open a PLexus project: launch active images, update runtime state, and register routes.",
    inputSchema: objectSchema(
      {
        projectPath: stringSchema,
        sourcePath: optionalStringSchema,
        workspaceId: optionalStringSchema,
        targetId: optionalStringSchema,
        stateRoot: optionalStringSchema,
        displayMode: displayModeSchema,
      },
      ["projectPath"],
    ),
  },
  {
    name: "plexus_project_close",
    description:
      "Close a PLexus project: stop running images, update runtime state, and unregister routes.",
    inputSchema: objectSchema(
      {
        projectPath: stringSchema,
        workspaceId: optionalStringSchema,
        stateRoot: optionalStringSchema,
        repositoryWorkspaceCleanupPolicy: {
          type: "string",
          enum: ["preserve", "archive", "delete-disposable"],
        },
        repositoryWorkspaceArchiveRoot: optionalStringSchema,
      detail: toolResultDetailSchema,
      },
      ["projectPath"],
    ),
  },
  {
    name: "plexus_project_cleanup",
    description:
      "Audit PLexus-owned leftover runtime resources, and clean them only when confirm: true is supplied.",
    inputSchema: objectSchema(
      {
        projectPath: stringSchema,
        workspaceId: optionalStringSchema,
        stateRoot: optionalStringSchema,
        confirm: { type: "boolean" },
        deleteStateFile: { type: "boolean" },
        deleteLauncherImages: { type: "boolean" },
        repositoryWorkspaceCleanupPolicy: {
          type: "string",
          enum: ["preserve", "archive", "delete-disposable"],
        },
        repositoryWorkspaceArchiveRoot: optionalStringSchema,
      },
      ["projectPath"],
    ),
  },
  {
    name: "plexus_project_status",
    description:
      "Return PLexus project lifecycle status from runtime state and registered routes.",
    inputSchema: objectSchema({
      ...projectReferenceProperties,
      refreshHealth: { type: "boolean" },
      includeDiagnostics: { type: "boolean" },
    }),
  },
  {
    name: "plexus_home_image_cache_status",
    description:
      "List PLexus home-level template image cache entries for one project.",
    inputSchema: objectSchema(
      {
        projectPath: stringSchema,
        key: optionalStringSchema,
      detail: toolResultDetailSchema,
      },
      ["projectPath"],
    ),
  },
  {
    name: "plexus_home_image_cache_flush",
    description:
      "Flush PLexus home-level template image cache entries and delete their home-profile launcher images. Requires confirm: true.",
    inputSchema: objectSchema(
      {
        projectPath: stringSchema,
        key: optionalStringSchema,
        confirm: { type: "boolean" },
      detail: toolResultDetailSchema,
      },
      ["projectPath", "confirm"],
    ),
  },
  {
    name: "plexus_rescue_image",
    description:
      "Plan or run rescue of a crashed Pharo image into a new image by recreating launcher state, restoring repositories when possible, and applying selected history entries from the source image ombu files.",
    inputSchema: objectSchema(
      {
        ...projectReferenceProperties,
        operation: {
          type: "string",
          enum: ["snapshotSource", "plan", "prepareTarget", "applyPlan"],
        },
        sourceImageId: stringSchema,
        targetImageId: optionalStringSchema,
        targetImageName: optionalStringSchema,
        targetTemplateName: optionalStringSchema,
        targetTemplateCategory: optionalStringSchema,
        targetMcpPort: { type: "integer", minimum: 1, maximum: 65_535 },
        sourceHistoryDirectoryPath: optionalStringSchema,
        historyFilePath: optionalStringSchema,
        selection: historyEntrySelectionSchema,
        exclude: historyEntrySelectionSchema,
        codeChangesOnly: { type: "boolean" },
        includeEntryCounts: { type: "boolean" },
        loadRepositories: { type: "boolean" },
        repositoryActions: {
          type: "array",
          items: repositoryActionSchema,
        },
        confirm: { type: "boolean" },
      detail: toolResultDetailSchema,
      },
      ["projectPath", "operation", "sourceImageId"],
    ),
  },
] as const;

export interface ProjectLifecycleHttpServerOptions {
  host?: string;
  port: number;
  healthPath?: string;
  mcpPath?: string;
  lifecycle?: PlexusProjectLifecycle;
}

export interface ProjectLifecycleCliOptions {
  transport: "stdio" | "http";
  host: string;
  port: number;
  mcpPath: string;
}

function jsonResult(
  value: unknown,
  isError = false,
  detail: ToolResultDetail = "summary",
): CallToolResult {
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

export function createProjectLifecycleServer(
  lifecycle = createProjectLifecycleFromEnvironment(),
): Server {
  const server = new Server(
    {
      name: "plexus-core",
      version: "0.1.0",
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: projectLifecycleTools,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const detail = toolResultDetailFromArguments(request.params.arguments);
    const result = await lifecycle.handleTool(
      request.params.name,
      request.params.arguments ?? {},
    );

    return jsonResult(result, !result.ok, detail);
  });

  return server;
}

export async function startProjectLifecycleServer(
  lifecycle?: PlexusProjectLifecycle,
): Promise<void> {
  const server = createProjectLifecycleServer(lifecycle);
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

export async function startProjectLifecycleHttpServer(
  options: ProjectLifecycleHttpServerOptions,
): Promise<http.Server> {
  const host = options.host ?? "127.0.0.1";
  const healthPath = options.healthPath ?? "/health";
  const mcpPath = parseHttpPath(options.mcpPath ?? "/mcp", "mcpPath");
  const lifecycle = options.lifecycle ?? createProjectLifecycleFromEnvironment();
  const activeTransports = new Set<StreamableHTTPServerTransport>();

  async function handleMcpRequest(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> {
    const projectServer = createProjectLifecycleServer(lifecycle);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    activeTransports.add(transport);
    response.once("close", () => {
      activeTransports.delete(transport);
      void transport.close();
    });

    await projectServer.connect(transport);
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
          service: "plexus-core",
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

interface MutableProjectLifecycleCliOptions {
  transport: ProjectLifecycleCliOptions["transport"];
  host: string;
  portValue: string;
  mcpPath: string;
}

function projectLifecycleCliOptionValue(
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

function applyProjectLifecycleCliArgument(
  options: MutableProjectLifecycleCliOptions,
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
      options.host = projectLifecycleCliOptionValue(args, index, arg);
      return index + 1;
    case "--port":
      options.portValue = projectLifecycleCliOptionValue(args, index, arg);
      return index + 1;
    case "--mcp-path":
      options.mcpPath = projectLifecycleCliOptionValue(args, index, arg);
      return index + 1;
    default:
      throw new Error(`Unknown plexus project MCP argument: ${arg}`);
  }
}

export function parseProjectLifecycleServerCliOptions(
  args: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): ProjectLifecycleCliOptions {
  const options: MutableProjectLifecycleCliOptions = {
    transport: "stdio",
    host: env.PLEXUS_HOST ?? "127.0.0.1",
    portValue: env.PLEXUS_PROJECT_MCP_PORT ?? env.PORT ?? "7332",
    mcpPath: env.PLEXUS_PROJECT_MCP_PATH ?? "/mcp",
  };

  for (let index = 0; index < args.length; index += 1) {
    index = applyProjectLifecycleCliArgument(options, args, index);
  }

  return {
    transport: options.transport,
    host: options.host,
    port: parsePort(options.portValue, "PLexus project MCP port"),
    mcpPath: parseHttpPath(options.mcpPath, "PLexus project MCP path"),
  };
}

export async function startProjectLifecycleServerFromCli(
  options = parseProjectLifecycleServerCliOptions(),
): Promise<void> {
  if (options.transport === "stdio") {
    await startProjectLifecycleServer();
    return;
  }

  await startProjectLifecycleHttpServer({
    host: options.host,
    port: options.port,
    mcpPath: options.mcpPath,
  });
}
