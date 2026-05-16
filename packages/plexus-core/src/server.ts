import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import {
  PlexusProjectLifecycle,
  createProjectLifecycleFromEnvironment,
} from "./projectLifecycle.js";

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
      "Close a PLexus project: stop running images, update runtime state, and unregister routes.",
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
      "Return PLexus project lifecycle status from runtime state and registered routes.",
    inputSchema: objectSchema({
      ...projectReferenceProperties,
      refreshHealth: { type: "boolean" },
    }),
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
      },
      ["projectPath", "operation", "sourceImageId"],
    ),
  },
] as const;

function jsonResult(value: unknown, isError = false): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
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
    const result = await lifecycle.handleTool(
      request.params.name,
      request.params.arguments ?? {},
    );

    return jsonResult(result, !result.ok);
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
