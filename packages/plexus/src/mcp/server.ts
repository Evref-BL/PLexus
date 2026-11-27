/**
 * `plexus mcp`: the image tools, and the tools of the images running in
 * scope, each forwarded to the image it names. A request's work runs in the
 * trace context its `_meta` carries, so what it forwards continues the host's
 * trace.
 */
import { CLIENT_INFO_META_KEY, Server, type CallToolResult, type ServerContext, type Tool } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { randomUUID } from "node:crypto";
import { context, SpanKind } from "@opentelemetry/api";
import * as answers from "../answers/index.js";
import { PlexusError, type PlexusErrorCode } from "../errors.js";
import { callTool, listTools } from "../forward/index.js";
import { endpointOf } from "../images/endpoint.js";
import type { Images } from "../images/index.js";
import {
  answeredCode,
  argumentAttributes,
  clientAttributes,
  contentAttributes,
  contextFromMeta,
  failed,
  identifierOrOther,
  inSpan,
  serverFailedWith,
  withSession,
  withTraceContext,
} from "../telemetry/trace.js";
import type { Display, Endpoint, ImageInfo, ImageTelemetry } from "../types.js";
import { plexusVersion } from "../version.js";

export type ImagesApi = Pick<
  Images,
  "templates" | "list" | "create" | "start" | "stop" | "delete" | "answering"
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
  /**
   * The images are enrolled in OpenTelemetry, as the `telemetry` option of
   * `Images` asks: the image tools then say whether an image records its
   * calls, and why not.
   */
  telemetry?: boolean;
  /**
   * Whether the OTEL_* settings the images start with send traces to an OTLP
   * endpoint they name. When they do not, the image tools say that what an
   * image records is sent nowhere.
   */
  endpointNamed?: boolean;
  /** The clock a working session's idle time is kept by. */
  now?: () => number;
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

Search these tools for any Pharo, Smalltalk, Tonel or .st work. Call
image_list first: it says which images this project has and which run.
image_start starts one; image_create makes one and starts it. A running image
lists its common tools here, and its own search tools find the rest.

An image takes one writer. A running image you did not start or create may be
another session's: do not call, stop or delete it unless the user says so.
image_create one for each new subject or parallel agent, named like a branch
(pretty-print-formatter, not p15), and name the image in every call to its
tools.

Stop an image you started once its work pauses: a running image holds its
memory. image_stop stops it without saving; save: true keeps what it holds.
A stopped image holds its disk until it is deleted: keep it a while after its
subject is done, and when image_list shows images unused for some time,
propose to the user which to delete.`;

const nameProperty = { type: "string", description: "The image's name." } as const;

const newNameProperty = {
  type: "string",
  description: "A new image's name, like a branch's: letters, digits, dots, dashes and underscores.",
} as const;

const namesProperty = {
  type: ["string", "array"],
  items: { type: "string" },
  description: "The image's name, or several.",
} as const;

function schema(
  properties: Record<string, object>,
  required: string[] = [],
): Tool["inputSchema"] {
  // The property literals are JSON, which their `as const` types do not say.
  const json = properties as NonNullable<Tool["inputSchema"]["properties"]>;
  return { type: "object", properties: json, required, additionalProperties: false };
}

export const imageTools: Tool[] = [
  {
    name: "image_templates",
    description:
      "List the templates an image can be created from, by category. A template in several categories is taken from Official, else Deprecated distributions, and otherwise needs its category in image_create.",
    inputSchema: schema({}),
  },
  {
    name: "image_create",
    description:
      "Create an image from a template, with MCP loaded and saved in it, and start it unless start is false; its tools are then listed here.",
    inputSchema: schema(
      {
        image: newNameProperty,
        template: {
          type: "string",
          description: "The template's name, as image_templates lists it; the current stable Pharo when absent.",
        },
        category: {
          type: "string",
          description: "The template's category, needed when its name is ambiguous.",
        },
        start: {
          type: "boolean",
          description: "false to leave the image stopped; true or absent starts it.",
        },
      },
      ["image"],
    ),
  },
  {
    name: "image_start",
    description:
      "Start an image and wait until its MCP server answers; its tools are then listed here. An image already running is left as it is.",
    inputSchema: schema(
      {
        image: nameProperty,
        display: {
          type: "string",
          enum: ["headless", "interactive"],
          description: "headless unless interactive is asked for.",
        },
      },
      ["image"],
    ),
  },
  {
    name: "image_stop",
    description:
      "Stop an image, or several, without saving: it starts again as it was last saved. With save: true, it saves itself first, keeping its changes. Evaluating `Smalltalk saveSession` in the image saves it without stopping it.",
    inputSchema: schema(
      {
        image: namesProperty,
        save: {
          type: "boolean",
          description: "true to have the image save itself and quit; false or absent stops it without saving.",
        },
      },
      ["image"],
    ),
  },
  {
    name: "image_delete",
    description:
      "Delete an image and its directory, or several, for good: what it holds that is not exported or pushed is lost. It refuses a running image unless stop is true, which stops it without saving first.",
    inputSchema: schema(
      {
        image: namesProperty,
        stop: {
          type: "boolean",
          description: "true to stop a running image without saving before deleting it; false or absent refuses it.",
        },
      },
      ["image"],
    ),
  },
  {
    name: "image_list",
    description:
      "List the images: whether each runs and takes calls, its Pharo version, and, for a stopped one, the day it was last used and the size of its image file. Name one to see only that one, with its template and path.",
    inputSchema: schema({ image: nameProperty }),
  },
];

const imageToolNames = new Set(imageTools.map((tool) => tool.name));

/** The input schemas each image listed, by image, then by tool. */
type ListedSchemas = Map<string, Map<string, Tool["inputSchema"]>>;

/**
 * Why this server answered a call with an error of its own, before any image
 * saw the call: a refusal of its arguments, of the image it names or of the
 * images it could go to, or the failure of one of its own tools, by its
 * PlexusError code, or `_OTHER` for any other error.
 */
export type RefusalCode =
  | PlexusErrorCode
  | "no-image-running"
  | "several-images"
  | "none-takes-calls"
  | "_OTHER";

/** A refusal with its code, which only the call's span records. */
class Refusal extends Error {
  constructor(
    readonly code: RefusalCode,
    message: string,
  ) {
    super(message);
  }
}

/** No image a call naming none could go to lists its tool: answered as an image answers a tool it lacks, with no refusal code. */
class NoImageHasTool extends Error {}

/** A call's answer, the code of the refusal it is, when this server refused it, and the image a forwarded call went to. */
interface Answered {
  result: CallToolResult;
  refusal?: RefusalCode;
  image?: string;
  /** Whether the image the call went to records its calls, when PLexus knows. */
  imageTelemetry?: ImageTelemetry;
}

/**
 * `plexus.image.telemetry`: `on`, or why the image does not record its calls,
 * or `off` when it does not say why.
 */
export function imageTelemetryValue(telemetry: ImageTelemetry): string {
  return telemetry.on ? "on" : (telemetry.reason ?? "off");
}

/** How long the first call to an image whose tools the host has not listed waits, once answered, for their listing. */
export const firstListingWaitMs = 500;

/** The promise's end, or the bound's, whichever comes first. */
async function settledWithin(work: Promise<unknown>, boundMs: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([work.catch(() => undefined), new Promise((resolve) => (timer = setTimeout(resolve, boundMs)))]);
  } finally {
    clearTimeout(timer);
  }
}

/** How long a working session lasts without a call before the next one opens another. */
export const sessionIdleMs = 30 * 60_000;

/**
 * The client a request names: in the 2026-07-28 revision, the `clientInfo`
 * of its own `_meta`; before it, the one the host named at initialize.
 */
function requestClient(server: Server, ctx: ServerContext): unknown {
  const envelope = ctx.mcpReq.envelope as Record<string, unknown> | undefined;
  return envelope?.[CLIENT_INFO_META_KEY] ?? server.getClientVersion();
}

export function createPlexusMcpServer(options: PlexusMcpServerOptions): Server {
  const images = options.images;
  // The forwarding answers what the image sent, which is what the protocol says.
  const listToolsOf = options.listTools ?? ((endpoint: Endpoint) => listTools(endpoint) as Promise<Tool[]>);
  const callToolOn = options.callTool ?? (callTool as NonNullable<PlexusMcpServerOptions["callTool"]>);
  // From the last tools/list, so that a call waits as long as the schema the
  // image listed for its tool allows.
  let listedSchemas: ListedSchemas = new Map();
  // The images this server created or started, which a start finding one
  // already running does not warn of.
  const startedHere = new Set<string>();
  /**
   * The names of the tools the image lists: the host's last listing of it,
   * else one fetched now, waited for as briefly as a first call waits; none
   * when it does not come.
   */
  async function toolsOf(image: Reachable): Promise<ReadonlySet<string> | undefined> {
    const listing = learnListing(image.name, image.endpoint);
    if (listing !== undefined) {
      await settledWithin(listing, firstListingWaitMs);
    }
    const tools = listedSchemas.get(image.name);
    return tools === undefined ? undefined : new Set(tools.keys());
  }

  // The listings forwarded calls are fetching, by image.
  const learning = new Map<string, Promise<void>>();

  /**
   * Fetches the listing of an image a call goes to before the host listed
   * its tools, beside that call: the calls that follow then wait as its
   * schemas say, and the spans name the arguments its tools declare. Answers
   * the fetch, or nothing when the listing is known.
   */
  function learnListing(image: string, endpoint: Endpoint): Promise<void> | undefined {
    if (listedSchemas.has(image)) {
      return undefined;
    }
    let fetching = learning.get(image);
    if (fetching === undefined) {
      fetching = listToolsOf(endpoint)
        .then((tools) => {
          if (!listedSchemas.has(image)) {
            listedSchemas.set(image, new Map(tools.map((tool) => [tool.name, tool.inputSchema])));
          }
        })
        .catch(() => undefined)
        .finally(() => learning.delete(image));
      learning.set(image, fetching);
    }
    return fetching;
  }

  const server = new Server(
    { name: "plexus", version: plexusVersion },
    { capabilities: { tools: { listChanged: true } }, instructions: serverInstructions },
  );

  /** Tells the host its tools changed, the trace context of the call that changed them in the notification's `_meta`. */
  function toolListChanged(): Promise<void> {
    const params = withTraceContext(undefined);
    return server.notification({ method: "notifications/tools/list_changed", ...(params === undefined ? {} : { params }) });
  }

  // A working session groups a host connection's calls: random, renewed
  // after sessionIdleMs without a call, and gone with the process.
  const now = options.now ?? Date.now;
  let session = { id: randomUUID(), calls: 0, running: 0, lastActive: now() };

  /** The session now: another one when the last call ended sessionIdleMs ago or more. */
  function currentSession(): typeof session {
    const at = now();
    if (session.running === 0 && at - session.lastActive >= sessionIdleMs) {
      session = { id: randomUUID(), calls: 0, running: 0, lastActive: at };
    }
    return session;
  }

  /** The session a call starts in, and its place there, from 1. */
  function callStarted(): { session: typeof session; index: number } {
    const at = now();
    currentSession();
    session.calls += 1;
    session.running += 1;
    session.lastActive = at;
    return { session, index: session.calls };
  }

  function callEnded(ended: typeof session): void {
    ended.running -= 1;
    ended.lastActive = now();
  }

  // A listing is no call: it takes the session as it is, and leaves its
  // calls and its idle time as they were.
  server.setRequestHandler("tools/list", (request) =>
    context.with(contextFromMeta(request.params?._meta), () =>
      context.with(withSession(context.active(), currentSession().id), () => listAll()),
    ),
  );
  server.setRequestHandler("tools/call", (request, ctx) =>
    context.with(contextFromMeta(request.params._meta), () =>
      served(request.params, ctx, () => call(request.params, ctx.mcpReq.signal)),
    ),
  );

  /**
   * The arguments a tool declares: an image tool's schema's, or, for an
   * image's tool, `image` and those the image the call went to listed for it,
   * or any image listed when it went to none. Unknown, for an image's tool,
   * while no listing it could be in is known.
   */
  function declaredArguments(name: string, image: string | undefined): Set<string> | undefined {
    const own = imageTools.find((each) => each.name === name);
    if (own !== undefined) {
      return new Set(Object.keys(own.inputSchema.properties ?? {}));
    }
    const listing = image === undefined ? undefined : listedSchemas.get(image);
    const schemas = image === undefined ? [...listedSchemas.values()] : listing === undefined ? [] : [listing];
    if (schemas.length === 0) {
      return undefined;
    }
    return new Set(["image", ...schemas.flatMap((tools) => Object.keys(tools.get(name)?.properties ?? {}))]);
  }

  /**
   * A call this server answers, as a SERVER span after the MCP conventions:
   * the request's id, the tool, the protocol version of the connection,
   * the names of its arguments the tool declares and of the others, the
   * session and the call's place in it, whether the tool is an image's, and
   * the host as the request names it; the arguments and the
   * result only when content is turned on. An answer
   * that is an error fails the span as `tool_error`, and a refusal of this
   * server's own says its code. A call that throws, which the host gets as a
   * JSON-RPC error, records its code as `rpc.status_code` and fails the span
   * with that code and its message, unless the code says the request was the
   * caller's fault, as the conventions ask of a server. Every span the
   * call makes carries the session, and what it forwards carries it in its
   * baggage.
   */
  function served(
    params: { name: string; arguments?: Record<string, unknown> },
    ctx: ServerContext,
    run: () => Promise<Answered>,
  ): Promise<CallToolResult> {
    const tool = identifierOrOther(params.name);
    const protocolVersion = server.getNegotiatedProtocolVersion();
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    const call = callStarted();
    return context
      .with(withSession(context.active(), call.session.id), () =>
        inSpan(
          `tools/call ${tool}`,
          SpanKind.SERVER,
          {
            "mcp.method.name": "tools/call",
            "jsonrpc.request.id": String(ctx.mcpReq.id),
            "gen_ai.operation.name": "execute_tool",
            "gen_ai.tool.name": tool,
            ...(protocolVersion === undefined ? {} : { "mcp.protocol.version": protocolVersion }),
            "network.transport": "pipe",
            "plexus.call.index": call.index,
            "plexus.call.forwarded": !imageToolNames.has(params.name),
            ...clientAttributes(requestClient(server, ctx) as { name?: unknown; version?: unknown } | undefined),
            ...contentAttributes(params.arguments),
          },
          async (span) => {
            let image: string | undefined;
            try {
              const answered = await run();
              image = answered.image;
              if (answered.refusal !== undefined) {
                span.setAttribute("plexus.error.code", answered.refusal);
              }
              if (answered.imageTelemetry !== undefined) {
                span.setAttribute("plexus.image.telemetry", imageTelemetryValue(answered.imageTelemetry));
              }
              if (answered.result.isError) {
                failed(span, "tool_error");
              }
              span.setAttributes(contentAttributes(undefined, answered.result));
              return answered.result;
            } catch (error) {
              span.setAttribute("rpc.status_code", String(answeredCode(error)));
              if (error instanceof PlexusError) {
                span.setAttribute("plexus.error.code", error.code);
              }
              throw error;
            } finally {
              // Without a listing, only `image` is known to be declared, and
              // nothing is said of the other names.
              const declared = declaredArguments(params.name, image);
              span.setAttributes(
                declared === undefined
                  ? argumentAttributes(args, new Set(["image"]), { unknown: false })
                  : argumentAttributes(args, declared),
              );
            }
          },
          (error) => (serverFailedWith(answeredCode(error)) ? String(answeredCode(error)) : undefined),
          (error) => (error instanceof Error ? error.message : undefined),
        ),
      )
      .finally(() => callEnded(call.session));
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
  ): Promise<Answered> {
    const name = params.name;
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    const imageTool = imageTools.find((tool) => tool.name === name);
    if (imageTool === undefined) {
      const callOn = async (endpoint: Endpoint, image: string, forwarded: Record<string, unknown>) => {
        const listing = learnListing(image, endpoint);
        const inputSchema = listedSchemas.get(image)?.get(name);
        try {
          return await callToolOn(endpoint, name, forwarded, {
            ...(inputSchema === undefined ? {} : { inputSchema }),
            signal,
          });
        } finally {
          // An answer faster than the listing waits a little for it.
          if (listing !== undefined) {
            await settledWithin(listing, firstListingWaitMs);
          }
        }
      };
      // Given none, the refusal of a tool the image does not have asks the
      // image for its listing itself, waiting less than a tools/list does.
      return forward(images, callOn, options.listTools, name, args, toolsOf);
    }
    const given = answers.lenientArguments(imageTool, args);
    const refusal = answers.checkArguments(imageTool, given);
    if (refusal !== undefined) {
      return { result: text(refusal, true), refusal: "invalid-arguments" };
    }
    try {
      const answer = await answerImageTool(images, name, given, {
        enrolled: options.telemetry === true,
        ...(options.endpointNamed === undefined ? {} : { endpointNamed: options.endpointNamed }),
      }, startedHere);
      if (
        name === "image_start" ||
        name === "image_stop" ||
        name === "image_delete" ||
        (name === "image_create" && given.start !== false)
      ) {
        await toolListChanged();
      }
      return { result: text(answers.render(answer)) };
    } catch (error) {
      // An image that stopped without saving has gone all the same.
      if (error instanceof PlexusError && error.code === "stopped-unsaved") {
        await toolListChanged();
      }
      return refused(error);
    }
  }

  return server;
}

/** Serves over stdio, in either era, and returns once the host closes its input. */
export async function runPlexusMcpServer(options: PlexusMcpServerOptions): Promise<void> {
  const closed = new Promise<void>((resolve) => {
    process.stdin.once("end", resolve);
    process.stdin.once("close", resolve);
  });
  // The opening message pins the connection to its era, and to one server.
  serveStdio(() => createPlexusMcpServer(options));
  await closed;
}

/** Runs an image tool whose arguments keep its schema, and says what it did. */
async function answerImageTool(
  images: ImagesApi,
  name: string,
  args: Record<string, unknown>,
  enrollment: answers.Enrollment,
  startedHere: Set<string>,
): Promise<answers.ToolAnswer> {
  const image = args.image as string;
  switch (name) {
    case "image_templates":
      return answers.templates(await images.templates());
    case "image_create": {
      const result = await images.create(image, {
        ...(args.template === undefined ? {} : { template: args.template as string }),
        ...(args.category === undefined ? {} : { category: args.category as string }),
      });
      const created = answers.created(result, enrollment, {
        ...(result.template === undefined || result.template === args.template ? {} : { template: result.template }),
        started: args.start !== false,
      });
      if (args.start === false) {
        return created;
      }
      let started: answers.ToolAnswer;
      try {
        started = await startAnswer(images, image, {}, enrollment, startedHere);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new PlexusError(
          error instanceof PlexusError ? error.code : "start-failed",
          answers.texts.createdNotStarted(image, reason),
        );
      }
      return answers.both(created, started);
    }
    case "image_start":
      return startAnswer(
        images,
        image,
        args.display === undefined ? {} : { display: args.display as Display },
        enrollment,
        startedHere,
      );
    case "image_stop":
      return eachImage(args.image, async (each) =>
        answers.stopped(await images.stop(each, args.save === true ? { save: true } : {})),
      );
    case "image_delete":
      return eachImage(args.image, async (each) => {
        if (args.stop === true) {
          const stopped = await images.stop(each);
          await images.delete(each);
          return stopped.quit === true || stopped.killed.length > 0 ? answers.stoppedAndDeleted(each) : answers.deleted({ name: each });
        }
        try {
          return answers.deleted(await images.delete(each));
        } catch (error) {
          // The library's words name image_stop; this tool can stop it itself.
          if (error instanceof PlexusError && error.code === "image-running") {
            const pids = error.details?.pids ?? [];
            throw new PlexusError("image-running", answers.texts.deleteRunningUnlessStopped(each, pids), error.details);
          }
          throw error;
        }
      });
    default: {
      if (args.image === undefined) {
        return answers.list(await images.list(), enrollment);
      }
      const [row] = await images.list(image);
      return answers.image(row, enrollment);
    }
  }
}

/**
 * Starts the image and says so, naming it when another image runs, and
 * saying when it ran already though this server never started it.
 */
async function startAnswer(
  images: ImagesApi,
  image: string,
  options: { display?: Display },
  enrollment: answers.Enrollment,
  startedHere: Set<string>,
): Promise<answers.ToolAnswer> {
  // Listed first, for the script every start files in, the MCP it holds and
  // whether another image runs; the start itself refuses an image that is
  // not there.
  const rows = await images.list().catch(() => []);
  const result = await images.start(image, options);
  const answer = answers.started(result, rows.find((each) => each.name === image), enrollment);
  const sentences = [
    answer.summary,
    ...(result.alreadyRunning && !startedHere.has(result.name) ? [answers.texts.notStartedHere()] : []),
    // True by construction: a call that names no image goes to the only one
    // that answers, so the image is named only beside another.
    ...(rows.some((each) => each.name !== result.name && each.running) ? [answers.texts.passImage(result.name)] : []),
  ];
  startedHere.add(result.name);
  return { ...answer, summary: sentences.join(" ") };
}

/**
 * A stop or a delete of one image, answered as it is, refusal included; or of
 * several, in turn: the answer says what each did and why any was not done,
 * and is a refusal only when none was.
 */
async function eachImage(
  given: unknown,
  act: (name: string) => Promise<answers.ToolAnswer>,
): Promise<answers.ToolAnswer> {
  if (!Array.isArray(given)) {
    return act(given as string);
  }
  const done: answers.ToolAnswer[] = [];
  const refusals: unknown[] = [];
  const missing: string[] = [];
  for (const name of given as string[]) {
    try {
      done.push(await act(name));
    } catch (error) {
      if (error instanceof PlexusError && error.code === "no-such-image") {
        missing.push(name);
      }
      refusals.push(error);
    }
  }
  // The names of no image, said once.
  const messages = [
    ...(missing.length > 1 ? [answers.texts.noSuchImages(missing)] : []),
    ...refusals
      .filter((error) => missing.length <= 1 || !(error instanceof PlexusError && error.code === "no-such-image"))
      .map((error) => (error instanceof Error ? error.message : String(error))),
  ];
  if (done.length === 0) {
    const first = refusals[0];
    throw first instanceof PlexusError ? new PlexusError(first.code, messages.join("\n")) : new Error(messages.join("\n"));
  }
  return answers.several(done, messages);
}

interface Reachable {
  name: string;
  endpoint: Endpoint;
  telemetry?: ImageTelemetry;
}

/** A row as a call reaches it: its name, its endpoint, and whether it records, when it says. */
function reachable(row: ImageInfo): Reachable {
  return { name: row.name, endpoint: endpointOf(row), ...(row.telemetry === undefined ? {} : { telemetry: row.telemetry }) };
}

/** The images a call can reach now: those `endpointOf` answers for. */
function answering(rows: readonly ImageInfo[]): Reachable[] {
  return rows.flatMap((row) => {
    try {
      return [reachable(row)];
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
              ? `The image to call: ${running[0]}.`
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
  toolsOf: (image: Reachable) => Promise<ReadonlySet<string> | undefined>,
): Promise<Answered> {
  const { image: given, ...rest } = args;
  const { image } = answers.lenientArguments({ inputSchema: imageArgument }, given === undefined ? {} : { image: given });
  const refusal = answers.checkArguments({ name, inputSchema: imageArgument }, image === undefined ? {} : { image });
  if (refusal !== undefined) {
    return { result: text(refusal, true), refusal: "invalid-arguments" };
  }

  let target: Reachable;
  try {
    target =
      images.answering(image as string | undefined) ??
      (image === undefined ? await onlyAnswering(images, name, toolsOf) : await named(images, image as string));
  } catch (error) {
    // No image to ask has the tool: said as an image that lacks it says it.
    if (error instanceof NoImageHasTool) {
      return { result: text(error.message, true) };
    }
    return refused(error);
  }
  const recording = target.telemetry === undefined ? {} : { imageTelemetry: target.telemetry };
  try {
    return { result: await callOn(target.endpoint, target.name, rest), image: target.name, ...recording };
  } catch (error) {
    const answer = await answers.callFailed(
      target.name,
      name,
      error,
      async () => (await images.list(target.name))[0],
      listToolsAt,
    );
    // A cancelled call is answered nothing: the host gave up on it.
    return { result: answer === undefined ? failure(error) : text(answers.render(answer), true), image: target.name, ...recording };
  }
}

/** The image named, or the library's refusal of a missing or invalid name, or why it takes no call. */
async function named(images: ImagesApi, image: string): Promise<Reachable> {
  const [row] = await images.list(image);
  return reachable(row);
}

/**
 * Where a call naming no image goes: the only image that answers or, of
 * several, the only one that lists the tool. When none of them lists it, that
 * is said as an image that lacks a tool says it; when several do, or a
 * listing did not come, the call must name one.
 */
async function onlyAnswering(
  images: ImagesApi,
  tool: string,
  toolsOf: (image: Reachable) => Promise<ReadonlySet<string> | undefined>,
): Promise<Reachable> {
  const rows = await images.list();
  const reachable = answering(rows);
  if (reachable.length === 1) {
    return reachable[0];
  }
  if (reachable.length > 1) {
    const listings = await Promise.all(reachable.map(async (each) => ({ each, tools: await toolsOf(each) })));
    const holders = listings.filter(({ tools }) => tools?.has(tool)).map(({ each }) => each);
    // An image whose listing did not come may hold the tool too.
    const allListed = listings.every(({ tools }) => tools !== undefined);
    if (holders.length === 1 && allListed) {
      return holders[0];
    }
    if (holders.length === 0 && allListed) {
      const listed = listings.flatMap(({ tools }) => [...(tools ?? [])]);
      const meant = answers.meantTool(tool, [...new Set(listed)]);
      const meantBy = listings.filter(({ tools }) => meant !== undefined && tools?.has(meant)).map(({ each }) => each.name);
      throw new NoImageHasTool(
        answers.texts.noImageHasTool(
          reachable.map((each) => each.name),
          tool,
          meant !== undefined && meantBy.length === 1 ? { tool: meant, image: meantBy[0] } : undefined,
        ),
      );
    }
    throw new Refusal(
      "several-images",
      answers.texts.severalAnswer((holders.length > 1 ? holders : reachable).map((each) => each.name)),
    );
  }
  const running = rows.filter((row) => row.running);
  if (running.length === 1) {
    return { name: running[0].name, endpoint: endpointOf(running[0]) };
  }
  if (running.length > 1) {
    throw new Refusal("none-takes-calls", answers.texts.noneTakesCalls(running.map((row) => row.name)));
  }
  throw new Refusal(
    "no-image-running",
    answers.texts.noImageRunning(
      tool,
      rows.filter((row) => row.state === "stopped").map((row) => row.name),
    ),
  );
}

/** A refusal of this server's own: its message as the answer, and its code. */
function refused(error: unknown): Answered {
  return {
    result: failure(error),
    refusal: error instanceof PlexusError || error instanceof Refusal ? error.code : "_OTHER",
  };
}

/** A refusal is its message alone: what happened and what to do. */
function failure(error: unknown): CallToolResult {
  return text(error instanceof Error ? error.message : String(error), true);
}

function text(value: string, isError = false): CallToolResult {
  return { content: [{ type: "text", text: value }], ...(isError ? { isError: true } : {}) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
