/**
 * `plexus mcp`: the image tools, and the tools of the images running in
 * scope, each forwarded to the image it names.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { PlexusError } from "../errors.js";
import { callTool, listTools } from "../forward/index.js";
import type { Images } from "../images/index.js";
import type { Display, Endpoint, ImageInfo } from "../types.js";
import { plexusVersion } from "../version.js";

export type ImagesApi = Pick<
  Images,
  "templates" | "list" | "create" | "start" | "stop" | "delete"
>;

export interface PlexusMcpServerOptions {
  images: ImagesApi;
  listTools?: (endpoint: Endpoint) => Promise<Tool[]>;
  callTool?: (
    endpoint: Endpoint,
    name: string,
    args: Record<string, unknown>,
  ) => Promise<CallToolResult>;
}

const nameProperty = { type: "string", description: "The image's name." } as const;

function schema(
  properties: Record<string, object>,
  required: string[] = [],
): Tool["inputSchema"] {
  return { type: "object", properties, required, additionalProperties: false };
}

export const imageTools: Tool[] = [
  {
    name: "image_templates",
    description:
      "List the templates an image can be created from, with their category. A template marked ambiguous is in several categories, so a create from it must name one.",
    inputSchema: schema({}),
  },
  {
    name: "image_create",
    description:
      "Create an image from a template, with MCP loaded and saved in it. It is not started.",
    inputSchema: schema(
      {
        name: nameProperty,
        template: { type: "string", description: "The template's name." },
        category: {
          type: "string",
          description: "The template's category, needed when its name is ambiguous.",
        },
      },
      ["name", "template"],
    ),
  },
  {
    name: "image_start",
    description:
      "Start an image and wait until its MCP server answers; its tools are then listed here. It refuses an image that is already running.",
    inputSchema: schema(
      {
        name: nameProperty,
        display: {
          type: "string",
          enum: ["headless", "interactive"],
          description: "headless unless interactive is asked for.",
        },
      },
      ["name"],
    ),
  },
  {
    name: "image_stop",
    description:
      "Stop an image by killing every VM that runs it. It kills without saving, so save through the image first to keep its changes.",
    inputSchema: schema({ name: nameProperty }, ["name"]),
  },
  {
    name: "image_delete",
    description: "Delete an image and its directory. It refuses an image that is running.",
    inputSchema: schema({ name: nameProperty }, ["name"]),
  },
  {
    name: "image_list",
    description:
      "List the images, whether each is running and where its MCP server answers. Name one to see only that one.",
    inputSchema: schema({ name: nameProperty }),
  },
];

const imageToolNames = new Set(imageTools.map((tool) => tool.name));

export function createPlexusMcpServer(options: PlexusMcpServerOptions): Server {
  const images = options.images;
  const listToolsOf = options.listTools ?? ((endpoint: Endpoint) => listTools(endpoint));
  const callToolOn =
    options.callTool ??
    ((endpoint: Endpoint, name: string, args: Record<string, unknown>) =>
      callTool(endpoint, name, args));

  const server = new Server(
    { name: "plexus", version: plexusVersion },
    { capabilities: { tools: { listChanged: true } } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const running = forwardable(await images.list().catch(() => []));
    const names = running.map((image) => image.name);
    const listings = await Promise.allSettled(
      running.map((image) => listToolsOf(image.endpoint)),
    );
    const forwarded = new Map<string, Tool>();
    for (const listing of listings) {
      // An image that cannot list its tools now leaves the others listed.
      if (listing.status !== "fulfilled") {
        continue;
      }
      for (const tool of listing.value) {
        if (!imageToolNames.has(tool.name) && !forwarded.has(tool.name)) {
          forwarded.set(tool.name, withImageArgument(tool, names));
        }
      }
    }
    return { tools: [...imageTools, ...forwarded.values()] };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    if (!imageToolNames.has(name)) {
      return forward(images, callToolOn, name, args);
    }
    try {
      const result = await callImageTool(images, name, args);
      if (name === "image_start" || name === "image_stop" || name === "image_delete") {
        await server.sendToolListChanged();
      }
      return text(JSON.stringify(result, null, 2));
    } catch (error) {
      return failure(error);
    }
  });

  return server;
}

export async function runPlexusMcpServer(options: PlexusMcpServerOptions): Promise<void> {
  await createPlexusMcpServer(options).connect(new StdioServerTransport());
}

async function callImageTool(
  images: ImagesApi,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const image = args.name as string;
  switch (name) {
    case "image_templates":
      return images.templates();
    case "image_create":
      return images.create(image, {
        template: args.template as string,
        ...(typeof args.category === "string" ? { category: args.category } : {}),
      });
    case "image_start":
      return images.start(image, displayOption(args.display));
    case "image_stop":
      return images.stop(image);
    case "image_delete":
      return images.delete(image);
    default:
      return images.list(args.name === undefined ? undefined : image);
  }
}

function displayOption(value: unknown): { display?: Display } {
  if (value === undefined) {
    return {};
  }
  if (value !== "headless" && value !== "interactive") {
    throw new Error(`display must be headless or interactive, not ${JSON.stringify(value)}`);
  }
  return { display: value };
}

type Forwardable = ImageInfo & { endpoint: Endpoint };

function forwardable(rows: readonly ImageInfo[]): Forwardable[] {
  return rows.filter((row): row is Forwardable => row.running && row.endpoint !== undefined);
}

function withImageArgument(tool: Tool, running: readonly string[]): Tool {
  const required = tool.inputSchema.required ?? [];
  return {
    ...tool,
    inputSchema: {
      ...tool.inputSchema,
      properties: {
        ...tool.inputSchema.properties,
        image: {
          type: "string",
          description:
            running.length === 1
              ? `The image to call, ${running[0]} unless named.`
              : `The image to call: one of ${running.join(", ")}.`,
        },
      },
      required: running.length === 1 ? required : [...required, "image"],
    },
  };
}

async function forward(
  images: ImagesApi,
  callToolOn: NonNullable<PlexusMcpServerOptions["callTool"]>,
  name: string,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  const { image, ...rest } = args;
  let rows: ImageInfo[];
  try {
    rows = await images.list();
  } catch (error) {
    return failure(error);
  }

  let target: ImageInfo | undefined;
  if (image !== undefined) {
    target = rows.find((row) => row.name === image);
    if (target === undefined) {
      return text(`There is no image ${JSON.stringify(image)}.`, true);
    }
  } else {
    const running = forwardable(rows);
    if (running.length === 0) {
      return text(`Unknown tool: ${name}`, true);
    }
    if (running.length > 1) {
      return text(
        `Several images are running (${running.map((row) => row.name).join(", ")}): name one with the image argument.`,
        true,
      );
    }
    target = running[0];
  }

  if (!target.running) {
    return text(`Image ${target.name} is not running.`, true);
  }
  if (target.endpoint === undefined) {
    return text(
      `Image ${target.name} runs, but has no endpoint to forward to: ${target.endpointProblem}.`,
      true,
    );
  }
  try {
    return await callToolOn(target.endpoint, name, rest);
  } catch (error) {
    return text(error instanceof Error ? error.message : String(error), true);
  }
}

function failure(error: unknown): CallToolResult {
  return text(
    JSON.stringify(
      error instanceof PlexusError
        ? { ok: false, code: error.code, error: error.message, ...(error.details ? { details: error.details } : {}) }
        : { ok: false, error: error instanceof Error ? error.message : String(error) },
      null,
      2,
    ),
    true,
  );
}

function text(value: string, isError = false): CallToolResult {
  return { content: [{ type: "text", text: value }], ...(isError ? { isError: true } : {}) };
}
