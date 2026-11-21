/**
 * `plexus mcp`: the image tools, and the tools of the images running in
 * scope, each forwarded to the image it names. A request's work runs in the
 * trace context its `_meta` carries, so what it forwards continues the host's
 * trace.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "node:crypto";
import { context, SpanKind } from "@opentelemetry/api";
import * as answers from "../answers/index.js";
import { PlexusError } from "../errors.js";
import { callTool, listTools } from "../forward/index.js";
import { endpointOf } from "../images/endpoint.js";
import type { Images } from "../images/index.js";
import {
  argumentNames,
  clientAttributes,
  contextFromMeta,
  failed,
  identifierOrOther,
  inSpan,
} from "../telemetry/trace.js";
import type { Display, Endpoint, ImageInfo } from "../types.js";
import { plexusVersion } from "../version.js";

export type ImagesApi = Pick<
  Images,
  "templates" | "list" | "create" | "start" | "stop" | "delete"
>;

/** What a forwarded call carries beside its arguments. */
export interface ForwardOptions {
  /** The schema the image listed for the tool, which sets how long the call waits. */
  inputSchema?: Tool["inputSchema"];
  /** Aborted when the host cancels the call. */
  signal?: AbortSignal;
}

export interface PlexusMcpServerOptions {
  images: ImagesApi;
  listTools?: (endpoint: Endpoint) => Promise<Tool[]>;
  callTool?: (
    endpoint: Endpoint,
    name: string,
    args: Record<string, unknown>,
    options: ForwardOptions,
  ) => Promise<CallToolResult>;
}

/**
 * What a host reads at session start, beside the tool names, before it defers
 * the rest: it decides whether these tools are searched for at all. It names
 * only PLexus's own tools, since an image's come from the MCP it holds.
 */
export const serverInstructions = `Live Pharo images for this project: reading and changing code, running tests,
searching and critiquing it.

Search these tools for any Pharo, Smalltalk, Tonel or .st work. image_list
says which images this project has and which are running, as of the call.
Start an image with image_start before calling its tools; a project with no
image needs image_templates and image_create first. A running image lists its
common tools here, and its own search tools find the rest.

An image takes one writer: image_create a new one for each new subject or
parallel agent rather than share one, named like a branch
(pretty-print-formatter, not p15). A running image may be another session's.
A call to an image's tool names the image, and may leave it out while only
one runs. image_stop kills an image without saving it; with save: true, the
image saves itself and quits.`;

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
      "List the templates an image can be created from, by category. A template in several categories needs its category in image_create.",
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
      "Stop an image. By default it kills every VM that runs it without saving, and the image starts again as it was last saved. With save: true, the image saves itself and quits instead, keeping its changes. Evaluating `Smalltalk saveSession` in the image saves it without stopping it.",
    inputSchema: schema(
      {
        name: nameProperty,
        save: {
          type: "boolean",
          description: "true to have the image save itself and quit; false or absent kills it without saving.",
        },
      },
      ["name"],
    ),
  },
  {
    name: "image_delete",
    description: "Delete an image and its directory. It refuses an image that is running.",
    inputSchema: schema({ name: nameProperty }, ["name"]),
  },
  {
    name: "image_list",
    description:
      "List the images: whether each runs and takes calls, its template and Pharo version. Name one to see only that one, with its path.",
    inputSchema: schema({ name: nameProperty }),
  },
];

const imageToolNames = new Set(imageTools.map((tool) => tool.name));

/** The input schemas each image listed, by image, then by tool. */
type ListedSchemas = Map<string, Map<string, Tool["inputSchema"]>>;

export function createPlexusMcpServer(options: PlexusMcpServerOptions): Server {
  const images = options.images;
  // The forwarding answers what the image sent, which is what the protocol says.
  const listToolsOf = options.listTools ?? ((endpoint: Endpoint) => listTools(endpoint) as Promise<Tool[]>);
  const callToolOn = options.callTool ?? (callTool as NonNullable<PlexusMcpServerOptions["callTool"]>);
  // From the last tools/list, so that a call waits as long as the schema the
  // image listed for its tool allows.
  let listedSchemas: ListedSchemas = new Map();

  const server = new Server(
    { name: "plexus", version: plexusVersion },
    { capabilities: { tools: { listChanged: true } }, instructions: serverInstructions },
  );

  // One host connection is one working session: what groups its calls in
  // the field telemetry, random, and gone with the process.
  const sessionId = randomUUID();

  server.setRequestHandler(ListToolsRequestSchema, (request) =>
    context.with(contextFromMeta(request.params?._meta), () => listAll()),
  );
  server.setRequestHandler(CallToolRequestSchema, (request, extra) =>
    context.with(contextFromMeta(request.params._meta), () =>
      served(request.params, () => call(request.params, extra.signal)),
    ),
  );

  /**
   * A call this server answers, as a SERVER span after the MCP conventions:
   * the tool, the names of its arguments and those an image tool does not
   * take, the session, and the host as its initialize request named itself.
   * Never a value. An answer that is an error fails the span as `tool_error`.
   */
  function served(
    params: { name: string; arguments?: Record<string, unknown> },
    run: () => Promise<CallToolResult>,
  ): Promise<CallToolResult> {
    const tool = identifierOrOther(params.name);
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    const names = argumentNames(args);
    const declared = imageTools.find((each) => each.name === params.name)?.inputSchema.properties;
    const unknown = declared === undefined ? [] : names.filter((name) => !(name in declared));
    return inSpan(
      `tools/call ${tool}`,
      SpanKind.SERVER,
      {
        "mcp.method.name": "tools/call",
        "gen_ai.operation.name": "execute_tool",
        "gen_ai.tool.name": tool,
        "network.transport": "pipe",
        "session.id": sessionId,
        ...clientAttributes(server.getClientVersion()),
        ...(names.length === 0 ? {} : { "plexus.argument.names": names }),
        ...(unknown.length === 0 ? {} : { "plexus.argument.unknown_names": unknown }),
      },
      async (span) => {
        const result = await run();
        if (result.isError) {
          failed(span, "tool_error");
        }
        return result;
      },
    );
  }

  async function listAll(): Promise<{ tools: Tool[] }> {
    const running = answering(await images.list().catch(() => []));
    const names = running.map((image) => image.name);
    const listings = await Promise.allSettled(
      running.map((image) => listToolsOf(image.endpoint)),
    );
    const forwarded = new Map<string, Tool>();
    const schemas: ListedSchemas = new Map();
    listings.forEach((listing, index) => {
      // An image that cannot list its tools now leaves the others listed.
      if (listing.status !== "fulfilled") {
        return;
      }
      schemas.set(running[index].name, new Map(listing.value.map((tool) => [tool.name, tool.inputSchema])));
      for (const tool of listing.value) {
        if (!imageToolNames.has(tool.name) && !forwarded.has(tool.name)) {
          forwarded.set(tool.name, withImageArgument(tool, names));
        }
      }
    });
    listedSchemas = schemas;
    return { tools: [...imageTools, ...forwarded.values()] };
  }

  async function call(
    params: { name: string; arguments?: Record<string, unknown> },
    signal: AbortSignal,
  ): Promise<CallToolResult> {
    const name = params.name;
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    const imageTool = imageTools.find((tool) => tool.name === name);
    if (imageTool === undefined) {
      const callOn = (endpoint: Endpoint, image: string, forwarded: Record<string, unknown>) => {
        const inputSchema = listedSchemas.get(image)?.get(name);
        return callToolOn(endpoint, name, forwarded, {
          ...(inputSchema === undefined ? {} : { inputSchema }),
          signal,
        });
      };
      // Given none, the refusal of a tool the image does not have asks the
      // image for its listing itself, waiting less than a tools/list does.
      return forward(images, callOn, options.listTools, name, args);
    }
    const refusal = answers.checkArguments(imageTool, args);
    if (refusal !== undefined) {
      return text(refusal, true);
    }
    try {
      const answer = await answerImageTool(images, name, args);
      if (name === "image_start" || name === "image_stop" || name === "image_delete") {
        await server.sendToolListChanged();
      }
      return text(answers.render(answer));
    } catch (error) {
      // An image that stopped without saving has gone all the same.
      if (error instanceof PlexusError && error.code === "stopped-unsaved") {
        await server.sendToolListChanged();
      }
      return failure(error);
    }
  }

  return server;
}

export async function runPlexusMcpServer(options: PlexusMcpServerOptions): Promise<void> {
  await createPlexusMcpServer(options).connect(new StdioServerTransport());
}

/** Runs an image tool whose arguments keep its schema, and says what it did. */
async function answerImageTool(
  images: ImagesApi,
  name: string,
  args: Record<string, unknown>,
): Promise<answers.ToolAnswer> {
  const image = args.name as string;
  switch (name) {
    case "image_templates":
      return answers.templates(await images.templates());
    case "image_create":
      return answers.created(
        await images.create(image, {
          template: args.template as string,
          ...(args.category === undefined ? {} : { category: args.category as string }),
        }),
      );
    case "image_start": {
      // Listed first, for the script every start files in and the MCP it
      // holds; the start itself refuses an image that is not there.
      const row = await images.list(image).then(([found]) => found, () => undefined);
      const result = await images.start(
        image,
        args.display === undefined ? {} : { display: args.display as Display },
      );
      const answer = answers.started(result, row);
      // True by construction: a call that names no image goes to the only
      // one that answers.
      return { ...answer, summary: `${answer.summary} ${answers.texts.passImage(image)}` };
    }
    case "image_stop":
      return answers.stopped(await images.stop(image, args.save === true ? { save: true } : {}));
    case "image_delete":
      return answers.deleted(await images.delete(image));
    default: {
      if (args.name === undefined) {
        return answers.list(await images.list());
      }
      const [row] = await images.list(image);
      return answers.image(row);
    }
  }
}

interface Reachable {
  name: string;
  endpoint: Endpoint;
}

/** The images a call can reach now: those `endpointOf` answers for. */
function answering(rows: readonly ImageInfo[]): Reachable[] {
  return rows.flatMap((row) => {
    try {
      return [{ name: row.name, endpoint: endpointOf(row) }];
    } catch {
      return [];
    }
  });
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

/** The one argument of a forwarded call this server reads; the rest is the image's to check. */
const imageArgument: Tool["inputSchema"] = { type: "object", properties: { image: { type: "string" } } };

/**
 * A call to a tool of an image: to the image it names, or, naming none, to
 * the only one that answers. An answer the image gives, an error or not,
 * passes as it is. `listToolsAt` lists the image's tools when it answers
 * that it has no such tool.
 */
async function forward(
  images: ImagesApi,
  callOn: (endpoint: Endpoint, image: string, args: Record<string, unknown>) => Promise<CallToolResult>,
  listToolsAt: PlexusMcpServerOptions["listTools"],
  name: string,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  const { image, ...rest } = args;
  const refusal = answers.checkArguments({ name, inputSchema: imageArgument }, image === undefined ? {} : { image });
  if (refusal !== undefined) {
    return text(refusal, true);
  }

  let target: Reachable;
  try {
    target = image === undefined ? await onlyAnswering(images, name) : await named(images, image as string);
  } catch (error) {
    return failure(error);
  }
  try {
    return await callOn(target.endpoint, target.name, rest);
  } catch (error) {
    const answer = await answers.callFailed(
      target.name,
      name,
      error,
      async () => (await images.list(target.name))[0],
      listToolsAt,
    );
    // A cancelled call is answered nothing: the host gave up on it.
    return answer === undefined ? failure(error) : text(answers.render(answer), true);
  }
}

/** The image named, or the library's refusal of a missing or invalid name, or why it takes no call. */
async function named(images: ImagesApi, image: string): Promise<Reachable> {
  const [row] = await images.list(image);
  return { name: row.name, endpoint: endpointOf(row) };
}

async function onlyAnswering(images: ImagesApi, tool: string): Promise<Reachable> {
  const rows = await images.list();
  const reachable = answering(rows);
  if (reachable.length === 1) {
    return reachable[0];
  }
  if (reachable.length > 1) {
    throw new Error(answers.texts.severalAnswer(reachable.map((each) => each.name)));
  }
  const running = rows.filter((row) => row.running);
  if (running.length === 1) {
    return { name: running[0].name, endpoint: endpointOf(running[0]) };
  }
  if (running.length > 1) {
    throw new Error(answers.texts.noneTakesCalls(running.map((row) => row.name)));
  }
  throw new Error(answers.texts.noImageRunning(tool));
}

/** A refusal is its message alone: what happened and what to do. */
function failure(error: unknown): CallToolResult {
  return text(error instanceof Error ? error.message : String(error), true);
}

function text(value: string, isError = false): CallToolResult {
  return { content: [{ type: "text", text: value }], ...(isError ? { isError: true } : {}) };
}
