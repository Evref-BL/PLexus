import { Client } from "@modelcontextprotocol/client";
import {
  InMemoryTransport,
  LATEST_PROTOCOL_VERSION,
  type CallToolResult,
  type JSONRPCMessage,
  type Tool,
} from "@modelcontextprotocol/server";
import { context, propagation, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { CompositePropagator, W3CBaggagePropagator, W3CTraceContextPropagator } from "@opentelemetry/core";
import { InMemorySpanExporter, SimpleSpanProcessor, TracerProvider } from "@opentelemetry/sdk-trace";
import { describe, expect, it } from "vitest";
import * as texts from "../../src/answers/texts.js";
import { defaultPharoMcpVersion } from "../../src/config/pharoMcpVersion.js";
import { PlexusError } from "../../src/errors.js";
import { callWaitMs } from "../../src/forward/index.js";
import {
  createPlexusMcpServer,
  firstListingWaitMs,
  sessionIdleMs,
  type ForwardOptions,
  type ImagesApi,
  type PlexusMcpServerOptions,
} from "../../src/mcp/server.js";
import { sessionOf, withTraceContext } from "../../src/telemetry/trace.js";
import type { CreateOptions, Endpoint, ImageInfo, StartOptions, StopOptions } from "../../src/types.js";

/** Records what each test's spans are, through an SDK registered as an application registers one. */
function recordSpans(): { exporter: InMemorySpanExporter; end(): void } {
  const exporter = new InMemorySpanExporter();
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  propagation.setGlobalPropagator(
    new CompositePropagator({ propagators: [new W3CTraceContextPropagator(), new W3CBaggagePropagator()] }),
  );
  trace.setGlobalTracerProvider(new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] }));
  return {
    exporter,
    end: () => {
      trace.disable();
      propagation.disable();
      context.disable();
    },
  };
}

function servedSpans(exporter: InMemorySpanExporter) {
  return exporter.getFinishedSpans().filter((span) => span.kind === SpanKind.SERVER);
}

function row(
  name: string,
  state: { port?: number; running?: boolean; problem?: string; fields?: Partial<ImageInfo> } = {},
): ImageInfo {
  const running = state.running ?? state.port !== undefined;
  return {
    name,
    path: `/home/.plexus/profiles/images/Scope-${name}/Scope-${name}.image`,
    state: !running ? "stopped" : state.port !== undefined ? "running" : state.problem === undefined ? "starting" : "unreachable",
    running,
    pids: running ? [100] : [],
    ...(state.port === undefined ? {} : { endpoint: { url: `http://127.0.0.1:${state.port}/`, pid: 100 } }),
    ...(running && state.port === undefined && state.problem !== undefined ? { endpointProblem: state.problem } : {}),
    ...state.fields,
  };
}

class FakeImages implements ImagesApi {
  readonly calls: Array<[string, ...unknown[]]> = [];
  constructor(public rows: ImageInfo[] = []) {}

  async templates() {
    this.calls.push(["templates"]);
    return [{ name: "Pharo 14.0 - 64bit", category: "Official distributions" }];
  }

  async list(name?: string) {
    this.calls.push(["list", name]);
    if (name === undefined) {
      return this.rows;
    }
    const found = this.rows.filter((each) => each.name === name);
    if (found.length === 0) {
      throw new PlexusError("no-such-image", texts.noSuchImage(name));
    }
    return found;
  }

  async create(name: string, options: CreateOptions) {
    this.calls.push(["create", name, options]);
    // As the library does: no template is the current stable Pharo.
    return { ...row(name, { fields: { template: options.template ?? "Pharo 14.0 - 64bit (stable)" } }), seconds: 1 };
  }

  async start(name: string, options?: StartOptions) {
    this.calls.push(["start", name, options]);
    if (name === "broken") {
      throw new PlexusError("start-failed", "Image broken exited during start.");
    }
    if (this.rows.some((each) => each.name === name && each.state === "running")) {
      return { name, pids: [100], endpoint: { url: "http://127.0.0.1:7001/", pid: 100 }, display: "headless" as const, seconds: 0, alreadyRunning: true as const };
    }
    return { name, pids: [100], endpoint: { url: "http://127.0.0.1:7001/" }, display: options?.display ?? "headless", seconds: 2 };
  }

  async stop(name: string, options?: StopOptions) {
    this.calls.push(["stop", name, options]);
    if (name === "unsaved") {
      throw new PlexusError("stopped-unsaved", texts.stoppedUnsaved(name));
    }
    if (name === "unsavable") {
      throw new PlexusError("save-failed", texts.notSaved(name, "it refused the connection"), { pids: [100] });
    }
    return options?.save ? { name, killed: [], saved: true as const } : { name, killed: [100] };
  }

  async delete(name: string) {
    this.calls.push(["delete", name]);
    if (name.startsWith("busy")) {
      throw new PlexusError("image-running", `Image ${name} is running.`);
    }
    // A one-letter name is one of the rows when there is such an image; any
    // longer name is taken as there.
    if (name.length === 1 && !this.rows.some((each) => each.name === name)) {
      throw new PlexusError("no-such-image", texts.noSuchImage(name));
    }
    return { name };
  }

  /** Where a call goes without a look, as `Images` knows it from an earlier one: by default, never. */
  known?: { name: string; endpoint: Endpoint; telemetry?: ImageInfo["telemetry"] };

  answering(name?: string) {
    this.calls.push(["answering", name]);
    return this.known !== undefined && (name === undefined || name === this.known.name) ? this.known : undefined;
  }
}

function tool(name: string, properties: Record<string, object> = {}, required: string[] = []): Tool {
  const json = properties as NonNullable<Tool["inputSchema"]["properties"]>;
  return { name, description: `${name} in the image`, inputSchema: { type: "object", properties: json, required } };
}

type Forwarded = { endpoint: Endpoint; name: string; args: Record<string, unknown>; options: ForwardOptions };

async function connect(
  images: FakeImages,
  toolsByUrl: Record<string, Tool[] | Error> = {},
  answer: NonNullable<PlexusMcpServerOptions["callTool"]> = async (_endpoint, name) => ({
    content: [{ type: "text", text: `${name} answered` }],
  }),
  extra: Partial<PlexusMcpServerOptions> = {},
) {
  const forwarded: Forwarded[] = [];
  const server = createPlexusMcpServer({
    images,
    listTools: async (endpoint) => {
      const tools = toolsByUrl[endpoint.url];
      if (tools instanceof Error || tools === undefined) {
        throw tools ?? new Error("connection refused");
      }
      return tools;
    },
    ...extra,
    callTool: async (endpoint, name, args, options): Promise<CallToolResult> => {
      forwarded.push({ endpoint, name, args, options });
      return answer(endpoint, name, args, options);
    },
  });
  const client = new Client({ name: "test", version: "1.0.0" });
  let listChanged = 0;
  const changes: unknown[] = [];
  client.setNotificationHandler("notifications/tools/list_changed", (notification) => {
    listChanged += 1;
    changes.push(notification.params);
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  // What the server answered, by request id.
  const responded: unknown[] = [];
  const send = serverTransport.send.bind(serverTransport);
  serverTransport.send = async (message, options) => {
    if ("id" in message && ("result" in message || "error" in message)) {
      responded.push(message.id);
    }
    return send(message, options);
  };
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    forwarded,
    responded,
    listChanged: async () => {
      await new Promise((resolve) => setImmediate(resolve));
      return listChanged;
    },
    /** The params of each tool list change the host was told of. */
    changes,
    call: async (name: string, args: Record<string, unknown> = {}) =>
      (await client.callTool({ name, arguments: args })) as CallToolResult,
  };
}

/** An error as callTool rejects with: its message, and its kind with what that carries. */
function forwardFailure(message: string, kind: Record<string, unknown>): Error {
  return Object.assign(new Error(message), kind);
}

function textOf(result: CallToolResult): string {
  return (result.content[0] as { text: string }).text;
}

const imageToolNames = ["image_templates", "image_create", "image_start", "image_stop", "image_delete", "image_list"];

describe("plexus mcp", () => {
  it("offers the six image tools and says its list changes", async () => {
    const { client } = await connect(new FakeImages([row("dev")]));

    const { tools } = await client.listTools();
    expect(tools.map((each) => each.name)).toEqual(imageToolNames);
    expect(client.getServerCapabilities()?.tools).toEqual({ listChanged: true });
    expect(client.getInstructions()).toContain("Search these tools for any Pharo, Smalltalk, Tonel or .st work.");
    expect(client.getInstructions()).toContain("name the image in every call to its\ntools");
    expect(client.getInstructions()).toContain("do not call, stop or delete it unless the user says so");
    expect(tools.find((each) => each.name === "image_start")?.description).toContain("An image already running is left as it is.");
    const imageStop = tools.find((each) => each.name === "image_stop")!;
    expect(imageStop.description).toContain("without saving");
    expect(imageStop.description).toContain("With save: true, it saves itself first");
    expect(imageStop.description).toContain("Evaluating `Smalltalk saveSession` in the image saves it without stopping it.");
    expect(imageStop.inputSchema.properties).toMatchObject({ save: { type: "boolean" } });
    expect(imageStop.inputSchema.required).toEqual(["image"]);
    const imageCreate = tools.find((each) => each.name === "image_create")!;
    expect(imageCreate.inputSchema.required).toEqual(["image"]);
    expect(imageCreate.inputSchema.properties).toMatchObject({ start: { type: "boolean" } });
    expect(tools.find((each) => each.name === "image_delete")!.inputSchema.properties).toMatchObject({
      stop: { type: "boolean" },
    });
  });

  it("adds the running image's tools, its name optional while it is the only one", async () => {
    const { client } = await connect(new FakeImages([row("dev", { port: 7001 }), row("idle")]), {
      "http://127.0.0.1:7001/": [tool("class_search", { name: { type: "string" } }, ["name"])],
    });

    const { tools } = await client.listTools();
    const classSearch = tools.find((each) => each.name === "class_search")!;
    expect(tools.map((each) => each.name)).toEqual([...imageToolNames, "class_search"]);
    expect(classSearch.inputSchema.properties).toMatchObject({ name: { type: "string" }, image: { type: "string" } });
    expect(classSearch.inputSchema.required).toEqual(["name"]);
  });

  it("requires the image once two run, and lists what either has", async () => {
    const images = new FakeImages([
      row("a", { port: 7001 }),
      row("b", { port: 7002 }),
      row("c", { port: 7003 }),
      row("starting", { running: true }),
    ]);
    const { client } = await connect(images, {
      "http://127.0.0.1:7001/": [tool("eval", { code: { type: "string" } }), tool("image_list")],
      "http://127.0.0.1:7002/": [tool("eval", { source: { type: "string" } }), tool("class_search")],
      "http://127.0.0.1:7003/": new Error("connection reset"),
    });

    const { tools } = await client.listTools();
    expect(tools.map((each) => each.name)).toEqual([...imageToolNames, "eval", "class_search"]);
    const evaluate = tools.find((each) => each.name === "eval")!;
    expect(Object.keys(evaluate.inputSchema.properties ?? {})).toEqual(["code", "image"]);
    expect(evaluate.inputSchema.required).toEqual(["image"]);
    expect(tools.find((each) => each.name === "image_list")?.description).not.toContain("in the image");
  });

  it("forwards a call to the only running image, without the image argument", async () => {
    const { call, forwarded } = await connect(new FakeImages([row("dev", { port: 7001 })]));

    expect(textOf(await call("class_search", { name: "Object" }))).toBe("class_search answered");
    expect((await call("class_search", { name: "Object", image: "dev" })).isError).toBeUndefined();
    expect(forwarded.map(({ options: _options, ...rest }) => rest)).toEqual([
      { endpoint: { url: "http://127.0.0.1:7001/", pid: 100 }, name: "class_search", args: { name: "Object" } },
      { endpoint: { url: "http://127.0.0.1:7001/", pid: 100 }, name: "class_search", args: { name: "Object" } },
    ]);
  });

  it("forwards without a look where the images know the image that answers, and looks again after a failed call", async () => {
    const images = new FakeImages([row("dev", { port: 7001 })]);
    images.known = { name: "dev", endpoint: { url: "http://127.0.0.1:7009/", pid: 100 } };
    let fail = false;
    const { call, forwarded } = await connect(images, {}, async (_endpoint, name) => {
      if (fail) {
        throw forwardFailure("connect ECONNREFUSED 127.0.0.1:7009", { kind: "refused" });
      }
      return { content: [{ type: "text", text: `${name} answered` }] };
    });

    await call("class_search", { name: "Object" });
    await call("class_search", { name: "Object", image: "dev" });
    expect(forwarded.map((each) => each.endpoint.url)).toEqual(["http://127.0.0.1:7009/", "http://127.0.0.1:7009/"]);
    expect(images.calls.filter(([method]) => method === "list")).toEqual([]);

    fail = true;
    await call("class_search", { name: "Object" });
    expect(images.calls.filter(([method]) => method === "list")).toEqual([["list", "dev"]]);
  });

  it("answers a start of an image already running as no error, with no error span", async () => {
    const recording = recordSpans();
    try {
      const { call } = await connect(new FakeImages([row("dev", { port: 7001 }), row("other", { port: 7002 })]));
      const answer = await call("image_start", { image: "dev" });

      expect(answer.isError).toBeUndefined();
      expect(textOf(answer)).toBe(
        'Image dev was already running. This session did not start it, so it may be another session\'s. Pass image: "dev" to its tools while another image runs.',
      );
      const spans = recording.exporter.getFinishedSpans();
      expect(spans.filter((span) => span.status.code === SpanStatusCode.ERROR)).toEqual([]);
      expect(servedSpans(recording.exporter)[0].attributes).not.toHaveProperty("plexus.error.code");
    } finally {
      recording.end();
    }
  });

  it("among several images, sends a call naming none to the only one that has the tool, and says when none has it", async () => {
    const recording = recordSpans();
    try {
      const { call, forwarded } = await connect(
        new FakeImages([row("a", { port: 7001 }), row("b", { port: 7002 })]),
        {
          "http://127.0.0.1:7001/": [tool("eval"), tool("image_evaluate")],
          "http://127.0.0.1:7002/": [tool("eval"), tool("class_get")],
        },
      );

      expect(textOf(await call("class_get", { name: "Object" }))).toBe("class_get answered");
      expect(forwarded.map((each) => each.endpoint.url)).toEqual(["http://127.0.0.1:7002/"]);

      const missing = await call("class_search");
      expect(missing.isError).toBe(true);
      expect(textOf(missing)).toBe("No running image (a, b) has a tool class_search: tool_search finds the tools an image has.");
      expect(textOf(await call("evaluate"))).toBe(
        "No running image (a, b) has a tool evaluate, but a lists image_evaluate: call that instead.",
      );
      expect(textOf(await call("eval"))).toBe("Several images are running (a, b): name one with the image argument.");
      expect(forwarded).toHaveLength(1);

      const [, none, , several] = servedSpans(recording.exporter);
      expect(none.attributes).not.toHaveProperty("plexus.error.code");
      expect(none.attributes["error.type"]).toBe("tool_error");
      expect(several.attributes["plexus.error.code"]).toBe("several-images");
    } finally {
      recording.end();
    }
  });

  it("asks which image when an image that may have the tool could not be listed", async () => {
    const { call, forwarded } = await connect(new FakeImages([row("a", { port: 7001 }), row("b", { port: 7002 })]), {
      "http://127.0.0.1:7001/": new Error("busy"),
      "http://127.0.0.1:7002/": [tool("evaluate")],
    });

    expect(textOf(await call("evaluate", { code: "1" }))).toBe(
      "Several images are running (a, b): name one with the image argument.",
    );
    expect(forwarded).toEqual([]);
  });

  it("passes the image's own error as it is", async () => {
    const refused: CallToolResult = { content: [{ type: "text", text: "Unable to compile method." }], isError: true };
    const { call } = await connect(new FakeImages([row("dev", { port: 7001 })]), {}, async () => refused);

    expect(await call("method_compile", { source: "x" })).toEqual(refused);
  });

  it("asks which image when several run, and refuses one that cannot take the call", async () => {
    const { call, forwarded } = await connect(
      new FakeImages([
        row("a", { port: 7001 }),
        row("b", { port: 7002 }),
        row("idle"),
        row("starting", { running: true }),
        row("legacy", { running: true, problem: "not started by this PLexus" }),
      ]),
    );

    const ambiguous = await call("eval");
    expect(ambiguous.isError).toBe(true);
    expect(textOf(ambiguous)).toBe("Several images are running (a, b): name one with the image argument.");

    await call("eval", { image: "b", code: "1" });
    expect(forwarded.at(-1)).toMatchObject({ endpoint: { url: "http://127.0.0.1:7002/" }, args: { code: "1" } });

    const refusals: Array<[string, string]> = [
      ["idle", "Image idle is not running. Start it with image_start; it starts as it was last saved."],
      [
        "starting",
        "Image starting is starting as pid 100: its MCP server does not answer yet. Call it again once image_list shows it running.",
      ],
      [
        "legacy",
        "Image legacy runs as pid 100 but takes no calls: not started by this PLexus. image_stop kills that VM without saving; image_start then starts it as it was last saved.",
      ],
      ["gone", "There is no image gone. image_list names the images there are; image_create makes one."],
    ];
    for (const [image, refusal] of refusals) {
      const result = await call("eval", { image });
      expect(result.isError, image).toBe(true);
      expect(textOf(result), image).toBe(refusal);
    }
    expect(forwarded).toHaveLength(1);
  });

  it("says why no image takes a call that names none", async () => {
    const one = await connect(new FakeImages([row("idle"), row("dev", { running: true })]));
    expect(textOf(await one.call("eval"))).toBe(
      "Image dev is starting as pid 100: its MCP server does not answer yet. Call it again once image_list shows it running.",
    );

    const two = await connect(
      new FakeImages([row("a", { running: true }), row("b", { running: true, problem: "not started by this PLexus" })]),
    );
    const none = await two.call("eval");
    expect(none.isError).toBe(true);
    expect(textOf(none)).toBe("Images a and b are running, but none takes calls: image_list says why.");
    expect(two.forwarded).toEqual([]);
  });

  it("takes the values a model writes in other spellings", async () => {
    const images = new FakeImages([row("dev")]);
    const { call } = await connect(images);

    expect((await call("image_start", { image: ["dev"], display: "Interactive" })).isError).toBeUndefined();
    expect((await call("image_stop", { image: "dev", save: "true" })).isError).toBeUndefined();
    expect(images.calls).toContainEqual(["start", "dev", { display: "interactive" }]);
    expect(images.calls).toContainEqual(["stop", "dev", { save: true }]);
    expect(textOf(await call("image_stop", { image: "dev", save: "maybe" }))).toBe(
      "Invalid arguments for image_stop. save must be boolean, not string.",
    );
  });

  it("names the images there are not once, however many a call names", async () => {
    const { call } = await connect(new FakeImages([row("a")]));
    expect(textOf(await call("image_delete", { image: ["a", "x", "y"] }))).toBe(
      [
        "Deleted image a and its files.",
        "Warning: There are no images x and y. image_list names the images there are; image_create makes one.",
      ].join("\n"),
    );
  });

  it("says which image a call naming none could start, or that there is none", async () => {
    const none = await connect(new FakeImages([]));
    expect(textOf(await none.call("class_search"))).toBe(
      "No image is running to take class_search, and there is none: image_create makes one.",
    );
    const many = await connect(new FakeImages(["a", "b", "c", "d", "e", "f"].map((name) => row(name))));
    expect(textOf(await many.call("class_search"))).toBe(
      "No image is running to take class_search. image_start starts one of the 6 image_list names; image_create makes another.",
    );
  });

  it("knows no tool beyond its own while no image runs", async () => {
    const { call } = await connect(new FakeImages([row("dev")]));
    const result = await call("class_search");
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(
      "No image is running to take class_search. image_start starts dev; image_create makes another.",
    );
  });

  it("refuses an image argument that is not a name", async () => {
    const { call, forwarded } = await connect(new FakeImages([row("dev", { port: 7001 })]));
    const result = await call("class_search", { image: 3 });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe("Invalid arguments for class_search. image must be string, not integer.");
    expect(forwarded).toEqual([]);
  });

  it("answers the image tools in plain text, refusals as their message", async () => {
    const older = { source: "pin", version: "3.7.0" } as const;
    const images = new FakeImages([
      row("dev", { fields: { template: "Pharo 14.0 - 64bit", pharoVersion: "14.0", mcp: { source: "pin", version: defaultPharoMcpVersion } } }),
      row("old", { port: 7001, fields: { template: "Pharo 13.0 - 64bit", pharoVersion: "13.0", mcp: older } }),
    ]);
    const { call } = await connect(images);
    const olderWarning = `Warning: Image old holds Pharo MCP 3.7.0, and images are created with ${defaultPharoMcpVersion} now, so its tools may differ from the current ones. Recreating it gives it the current MCP.`;

    expect(textOf(await call("image_templates"))).toBe(
      ["1 template in 1 category.", "Official distributions:", "  Pharo 14.0 - 64bit"].join("\n"),
    );
    expect(textOf(await call("image_list"))).toBe(
      [
        "2 images, 1 running.",
        olderWarning,
        "running:",
        "  old pharo=13.0 mcp=3.7.0",
        "stopped:",
        "  dev pharo=14.0",
      ].join("\n"),
    );
    expect(textOf(await call("image_list", { image: "dev" }))).toBe(
      [
        "Image dev is not running.",
        "pharo: 14.0",
        "template: Pharo 14.0 - 64bit",
        `mcp: ${defaultPharoMcpVersion}`,
        "path: /home/.plexus/profiles/images/Scope-dev/Scope-dev.image",
      ].join("\n"),
    );
    expect(
      textOf(
        await call("image_create", { image: "new", template: "Pharo 14.0 - 64bit", category: "Official distributions", start: false }),
      ),
    ).toBe("Created image new; image_start starts it.");
    // A create starts its image unless told not to, and names the template it took when the call named none.
    expect(textOf(await call("image_create", { image: "fresh" }))).toBe(
      'Created image fresh from Pharo 14.0 - 64bit (stable). Started image fresh. Pass image: "fresh" to its tools while another image runs.',
    );
    expect(images.calls.slice(-3)).toEqual([["create", "fresh", {}], ["list", undefined], ["start", "fresh", {}]]);
    expect(textOf(await call("image_start", { image: "dev", display: "interactive" }))).toBe(
      'Started image dev, with its window open. Pass image: "dev" to its tools while another image runs.',
    );
    // Old runs already, and is the only image running, so its start says nothing of image.
    expect(textOf(await call("image_start", { image: "old" }))).toBe(
      ["Image old was already running. This session did not start it, so it may be another session's.", olderWarning].join("\n"),
    );
    // Once started here, or met here already running, it is not said again.
    expect(textOf(await call("image_start", { image: "old" }))).toBe(["Image old was already running.", olderWarning].join("\n"));
    expect(textOf(await call("image_stop", { image: "dev" }))).toBe("Stopped image dev; what it had not saved is lost.");
    expect(textOf(await call("image_stop", { image: "old", save: true }))).toBe("Saved and stopped image old.");
    expect(textOf(await call("image_delete", { image: "dev" }))).toBe("Deleted image dev and its files.");
    expect(images.calls).toContainEqual(["create", "new", { template: "Pharo 14.0 - 64bit", category: "Official distributions" }]);
    expect(images.calls).toContainEqual(["start", "dev", { display: "interactive" }]);
    expect(images.calls).toContainEqual(["start", "old", {}]);
    expect(images.calls).toContainEqual(["stop", "dev", {}]);
    expect(images.calls).toContainEqual(["stop", "old", { save: true }]);

    for (const [tool, args, refusal] of [
      ["image_list", { image: "gone" }, "There is no image gone. image_list names the images there are; image_create makes one."],
      ["image_start", { image: "broken" }, "Image broken exited during start."],
      ["image_create", { image: "broken" }, "Created image broken, but it did not start (image_start tries again): Image broken exited during start."],
    ] as const) {
      const refused = await call(tool, args);
      expect(refused.isError, tool).toBe(true);
      expect(textOf(refused), tool).toBe(refusal);
    }
  });

  it("stops or deletes several images in turn, saying why any was not, and refuses only when none was", async () => {
    const images = new FakeImages([row("a"), row("b")]);
    const { call } = await connect(images);

    expect(textOf(await call("image_stop", { image: ["a", "b"], save: true }))).toBe(
      "Saved and stopped image a. Saved and stopped image b.",
    );
    const some = await call("image_delete", { image: ["a", "busy", "b"] });
    expect(some.isError).toBeUndefined();
    expect(textOf(some)).toBe(
      [
        "Deleted image a and its files. Deleted image b and its files.",
        "Warning: Image busy is running, maybe for another session. Once its work is done, image_delete with stop: true stops it without saving, then deletes it.",
      ].join("\n"),
    );
    expect(images.calls.filter(([method]) => method === "delete")).toEqual([
      ["delete", "a"],
      ["delete", "busy"],
      ["delete", "b"],
    ]);
    const none = await call("image_delete", { image: ["busy", "busy-too"] });
    expect(none.isError).toBe(true);
    expect(textOf(none)).toBe(
      [
        "Image busy is running, maybe for another session. Once its work is done, image_delete with stop: true stops it without saving, then deletes it.",
        "Image busy-too is running, maybe for another session. Once its work is done, image_delete with stop: true stops it without saving, then deletes it.",
      ].join("\n"),
    );
  });

  it("stops a running image before deleting it when asked to", async () => {
    const images = new FakeImages([row("dev", { port: 7001 }), row("idle")]);
    const { call } = await connect(images);

    expect(textOf(await call("image_delete", { image: ["dev", "idle"], stop: true }))).toBe(
      "Stopped image dev without saving, and deleted it and its files. Stopped image idle without saving, and deleted it and its files.",
    );
    expect(images.calls.filter(([method]) => method === "stop" || method === "delete")).toEqual([
      ["stop", "dev", undefined],
      ["delete", "dev"],
      ["stop", "idle", undefined],
      ["delete", "idle"],
    ]);
  });

  it("refuses arguments that break a tool's schema before any of it runs", async () => {
    const images = new FakeImages([row("dev")]);
    const { call } = await connect(images);

    for (const [tool, args, refusal] of [
      ["image_start", {}, "Invalid arguments for image_start. image is required."],
      ["image_start", { image: "  " }, "Invalid arguments for image_start. image is required."],
      [
        "image_start",
        { name: "dev" },
        "Invalid arguments for image_start. image is required. name is not accepted here; expected one of display, image.",
      ],
      [
        "image_delete",
        { image: "dev", force: true },
        "Invalid arguments for image_delete. force is not accepted here; expected one of image, stop.",
      ],
      [
        "image_start",
        { image: "dev", display: "window" },
        'Invalid arguments for image_start. display must be "headless" or "interactive", not "window".',
      ],
      ["image_create", { image: "new", template: 3 }, "Invalid arguments for image_create. template must be string, not integer."],
      ["image_stop", { image: "dev", save: "yes" }, "Invalid arguments for image_stop. save must be boolean, not string."],
    ] as const) {
      const result = await call(tool, args);
      expect(result.isError, tool).toBe(true);
      expect(textOf(result), JSON.stringify(args)).toBe(refusal);
    }
    expect(images.calls).toEqual([]);
  });

  it("forwards a call in the trace context its _meta carries", async () => {
    context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
    propagation.setGlobalPropagator(new W3CTraceContextPropagator());
    try {
      const parents: unknown[] = [];
      const { client } = await connect(new FakeImages([row("dev", { port: 7001 })]), {}, async () => {
        // Without an SDK the server's span records nothing and passes the
        // parent it was given on, or an invalid context for none.
        const parent = trace.getSpanContext(context.active());
        parents.push(parent !== undefined && trace.isSpanContextValid(parent) ? parent : undefined);
        return { content: [] };
      });

      await client.callTool({
        name: "class_get",
        arguments: {},
        _meta: { traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01" },
      });
      await client.callTool({ name: "class_get", arguments: {} });

      expect(parents).toEqual([
        expect.objectContaining({ traceId: "4bf92f3577b34da6a3ce929d0e0e4736", spanId: "00f067aa0ba902b7", isRemote: true }),
        undefined,
      ]);
    } finally {
      propagation.disable();
      context.disable();
    }
  });

  it("records each call it serves as a SERVER span: its id, the tool, argument names, session and host, no value unless content is on", async () => {
    const exporter = new InMemorySpanExporter();
    context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
    propagation.setGlobalPropagator(new W3CTraceContextPropagator());
    trace.setGlobalTracerProvider(new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] }));
    try {
      const { client } = await connect(
        new FakeImages([row("dev", { port: 7001 })]),
        { "http://127.0.0.1:7001/": [tool("class_get", { name: { type: "string" } })] },
        async () => ({
          content: [{ type: "text", text: "no such class" }],
          isError: true,
        }),
      );
      await client.listTools();
      await client.callTool({
        name: "class_get",
        arguments: { name: "SecretClass", image: "dev", ghp_SecretToken: 1 },
        _meta: { traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01" },
      });
      await client.callTool({ name: "image_list", arguments: { image: "dev", secretFlag: "/Users/ada" } });
      const second = await connect(new FakeImages([row("dev", { port: 7001 })]));
      await second.client.callTool({ name: "image_list", arguments: {} });

      const served = exporter.getFinishedSpans().filter((span) => span.kind === SpanKind.SERVER);
      expect(served.map((span) => span.name)).toEqual(["tools/call class_get", "tools/call image_list", "tools/call image_list"]);
      const [forwarded, refused, other] = served;
      expect(forwarded.spanContext().traceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
      expect(forwarded.parentSpanContext?.spanId).toBe("00f067aa0ba902b7");
      expect(forwarded.attributes).toEqual({
        "mcp.method.name": "tools/call",
        "jsonrpc.request.id": expect.stringMatching(/^\d+$/),
        "gen_ai.operation.name": "execute_tool",
        "gen_ai.tool.name": "class_get",
        "mcp.protocol.version": LATEST_PROTOCOL_VERSION,
        "network.transport": "pipe",
        "session.id": expect.stringMatching(/^[0-9a-f-]{36}$/),
        "plexus.call.index": 1,
        "plexus.call.forwarded": true,
        "plexus.client.name": "test",
        "plexus.client.version": "1.0.0",
        "plexus.argument.names": ["name", "image"],
        "plexus.argument.unknown_names": ["ghp_SecretToken"],
        "error.type": "tool_error",
      });
      expect(forwarded.status).toEqual({ code: SpanStatusCode.ERROR });
      expect(refused.attributes["plexus.argument.names"]).toEqual(["image"]);
      expect(refused.attributes["plexus.argument.unknown_names"]).toEqual(["secretFlag"]);
      expect(refused.attributes["session.id"]).toBe(forwarded.attributes["session.id"]);
      expect(refused.attributes["plexus.call.index"]).toBe(2);
      expect(refused.attributes["plexus.call.forwarded"]).toBe(false);
      expect(refused.attributes["plexus.error.code"]).toBe("invalid-arguments");
      expect(forwarded.attributes).not.toHaveProperty("plexus.error.code");
      expect(other.attributes["session.id"]).not.toBe(forwarded.attributes["session.id"]);
      expect(other.attributes["plexus.call.index"]).toBe(1);
      expect(JSON.stringify(served.map((span) => span.attributes))).not.toMatch(/SecretClass|\/Users\/ada|dev/);
    } finally {
      trace.disable();
      propagation.disable();
      context.disable();
    }
  });

  it("says on the span of a forwarded call whether the image records its calls, as its listing says, and nothing when it does not say", async () => {
    const recording = recordSpans();
    try {
      const images = new FakeImages([
        row("recording", { port: 7001, fields: { telemetry: { on: true } } }),
        row("bare", { port: 7002, fields: { telemetry: { on: false, reason: "no-backend" } } }),
        row("unsaid", { port: 7003, fields: { telemetry: { on: false } } }),
        row("older", { port: 7004 }),
      ]);
      const listing = [tool("class_get", { name: { type: "string" } })];
      const { client } = await connect(images, {
        "http://127.0.0.1:7001/": listing,
        "http://127.0.0.1:7002/": listing,
        "http://127.0.0.1:7003/": listing,
        "http://127.0.0.1:7004/": listing,
        "http://127.0.0.1:7005/": listing,
      });
      for (const image of ["recording", "bare", "unsaid", "older"]) {
        await client.callTool({ name: "class_get", arguments: { name: "Object", image } });
      }
      images.known = { name: "fast", endpoint: { url: "http://127.0.0.1:7005/", pid: 101 }, telemetry: { on: true } };
      await client.callTool({ name: "class_get", arguments: { name: "Object", image: "fast" } });
      await client.callTool({ name: "image_list", arguments: {} });

      const served = recording.exporter.getFinishedSpans().filter((span) => span.kind === SpanKind.SERVER);
      expect(served.map((span) => span.attributes["plexus.image.telemetry"])).toEqual(["on", "no-backend", "off", undefined, "on", undefined]);
    } finally {
      recording.end();
    }
  });

  it("learns the tools of an image a call goes to before the host listed them, waiting a little for them once answered", async () => {
    const recording = recordSpans();
    try {
      const listed: string[] = [];
      const { call, forwarded } = await connect(new FakeImages([row("dev", { port: 7001 })]), {}, undefined, {
        listTools: async (endpoint) => {
          listed.push(endpoint.url);
          await new Promise((resolve) => setTimeout(resolve, 30));
          return [tool("evaluate", { code: { type: "string" }, timeoutSeconds: { type: "integer", default: 300 } })];
        },
      });
      await call("evaluate", { code: "1", made_up: true });
      await call("evaluate", { code: "2", image: "dev" });

      expect(listed).toEqual(["http://127.0.0.1:7001/"]);
      expect(forwarded[1].options.inputSchema?.properties).toHaveProperty("timeoutSeconds");
      const [first, second] = servedSpans(recording.exporter);
      expect(first.attributes["plexus.argument.names"]).toEqual(["code"]);
      expect(first.attributes["plexus.argument.unknown_names"]).toEqual(["made_up"]);
      expect(second.attributes["plexus.argument.names"]).toEqual(["code", "image"]);
      expect(second.attributes).not.toHaveProperty("plexus.argument.unknown_names");
    } finally {
      recording.end();
    }
  });

  it("says only image of a call whose image did not list its tools in time, rather than calling the rest unknown", async () => {
    const recording = recordSpans();
    try {
      const { call } = await connect(new FakeImages([row("dev", { port: 7001 })]), {}, undefined, {
        listTools: () => new Promise<Tool[]>(() => undefined),
      });
      const started = Date.now();
      expect(textOf(await call("evaluate", { code: "1", image: "dev" }))).toBe("evaluate answered");

      expect(Date.now() - started).toBeLessThan(firstListingWaitMs + 1_000);
      const [served] = servedSpans(recording.exporter);
      expect(served.attributes["plexus.argument.names"]).toEqual(["image"]);
      expect(served.attributes).not.toHaveProperty("plexus.argument.unknown_names");
    } finally {
      recording.end();
    }
  });

  it("lists the images' tools in the session the calls run in, without counting the listing as a call", async () => {
    const recording = recordSpans();
    try {
      const listedIn: string[] = [];
      const images = new FakeImages([row("dev", { port: 7001 })]);
      const { client } = await connect(images, {}, undefined, {
        listTools: async () => {
          listedIn.push(sessionOf(context.active()));
          return [tool("class_get")];
        },
      });
      await client.listTools();
      await client.callTool({ name: "class_get", arguments: {} });
      await client.listTools();

      const [served] = servedSpans(recording.exporter);
      expect(listedIn).toEqual([served.attributes["session.id"], served.attributes["session.id"]]);
      expect(served.attributes["plexus.call.index"]).toBe(1);
    } finally {
      recording.end();
    }
  });

  it("opens a new session after thirty minutes without a call, and counts calls within one from 1", async () => {
    const recording = recordSpans();
    try {
      let now = Date.UTC(2026, 10, 22, 9);
      const slow = { release: () => undefined as void };
      let started = () => undefined as void;
      const running = new Promise<void>((resolve) => (started = resolve));
      const { call } = await connect(
        new FakeImages([row("dev", { port: 7001 })]),
        {},
        async (_endpoint, name) => {
          if (name === "test_run") {
            await new Promise<void>((resolve) => {
              slow.release = resolve;
              started();
            });
          }
          return { content: [{ type: "text", text: "done" }] };
        },
        { now: () => now },
      );

      await call("image_list");
      now += sessionIdleMs - 1;
      await call("image_list");
      const slowCall = call("test_run");
      await running;
      // A call that runs longer than the idle time keeps its session open.
      now += 2 * sessionIdleMs;
      await call("image_list");
      slow.release();
      await slowCall;
      now += sessionIdleMs;
      await call("image_list");

      const spans = servedSpans(recording.exporter);
      const longCall = spans.find((span) => span.name === "tools/call test_run")!;
      const inSession = (same: boolean) =>
        spans
          .filter((span) => (span.attributes["session.id"] === longCall.attributes["session.id"]) === same)
          .map((span) => [span.name, span.attributes["plexus.call.index"]])
          .sort((a, b) => Number(a[1]) - Number(b[1]));
      expect(inSession(true)).toEqual([
        ["tools/call image_list", 1],
        ["tools/call image_list", 2],
        ["tools/call test_run", 3],
        ["tools/call image_list", 4],
      ]);
      expect(inSession(false)).toEqual([["tools/call image_list", 1]]);
    } finally {
      recording.end();
    }
  });

  it("records the protocol version it agreed with the host at initialize", async () => {
    const recording = recordSpans();
    try {
      const server = createPlexusMcpServer({ images: new FakeImages([]) });
      const [hostSide, serverSide] = InMemoryTransport.createLinkedPair();
      const answered = new Map<number, () => void>();
      hostSide.onmessage = (message: JSONRPCMessage) => {
        if ("id" in message && typeof message.id === "number") answered.get(message.id)?.();
      };
      await server.connect(serverSide);
      await hostSide.start();
      const send = (id: number, method: string, params: Record<string, unknown>) =>
        new Promise<void>((resolve) => {
          answered.set(id, resolve);
          void hostSide.send({ jsonrpc: "2.0", id, method, params });
        });

      // An older version the SDK supports is the one agreed, not its latest.
      await send(1, "initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "host", version: "1.0" } });
      await hostSide.send({ jsonrpc: "2.0", method: "notifications/initialized" });
      await send(2, "tools/call", { name: "image_list", arguments: {} });

      const [span] = servedSpans(recording.exporter);
      expect(span.attributes["mcp.protocol.version"]).toBe("2025-03-26");
      await server.close();
    } finally {
      recording.end();
    }
  });

  it("tells the host its tools changed in the trace context of the call that changed them", async () => {
    const recording = recordSpans();
    try {
      const { call, changes, listChanged } = await connect(new FakeImages([row("dev")]));

      await call("image_start", { image: "dev" });
      expect(await listChanged()).toBe(1);

      const [span] = servedSpans(recording.exporter);
      expect(changes).toEqual([
        { _meta: { traceparent: `00-${span.spanContext().traceId}-${span.spanContext().spanId}-01`, baggage: expect.stringMatching(/^session\.id=/) } },
      ]);
    } finally {
      recording.end();
    }
  });

  it("sends the session in the baggage of what a call forwards, beside the host's own entries", async () => {
    const recording = recordSpans();
    try {
      const metas: unknown[] = [];
      const { client } = await connect(new FakeImages([row("dev", { port: 7001 })]), {}, async () => {
        metas.push(withTraceContext({})?._meta);
        return { content: [] };
      });

      await client.callTool({
        name: "class_get",
        arguments: {},
        _meta: { traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01", baggage: "run=r1" },
      });

      const [span] = servedSpans(recording.exporter);
      expect(metas).toEqual([
        {
          traceparent: expect.stringMatching(/^00-4bf92f3577b34da6a3ce929d0e0e4736-[0-9a-f]{16}-01$/),
          baggage: `run=r1,session.id=${String(span.attributes["session.id"])}`,
        },
      ]);
    } finally {
      recording.end();
    }
  });

  it("says why it refused a call before any image saw it, by a code of its own", async () => {
    const recording = recordSpans();
    try {
      const images = new FakeImages([]);
      const { call } = await connect(images);

      await call("class_get");
      images.rows = [row("a", { port: 7001 }), row("b", { port: 7002 })];
      await call("class_get");
      await call("class_get", { image: 3 });
      await call("class_get", { image: "gone" });
      images.rows = [row("a", { running: true, problem: "no endpoint" }), row("b", { running: true, problem: "no endpoint" })];
      await call("class_get");
      await call("image_start", { image: "broken" });
      await call("image_list", { image: "a" });

      expect(servedSpans(recording.exporter).map((span) => span.attributes["plexus.error.code"])).toEqual([
        "no-image-running",
        "several-images",
        "invalid-arguments",
        "no-such-image",
        "none-takes-calls",
        "start-failed",
        undefined,
      ]);
    } finally {
      recording.end();
    }
  });

  it("passes the schema the image listed and the host's signal to the call", async () => {
    const testRun = tool("test_run", { timeoutSeconds: { type: "integer", default: 90 } });
    const { client, call, forwarded } = await connect(new FakeImages([row("dev", { port: 7001 })]), {
      "http://127.0.0.1:7001/": [testRun],
    });

    await client.listTools();
    await call("test_run", { timeoutSeconds: 120 });
    await call("test_run", {});
    await call("found_by_search", {});

    expect(forwarded[0].options.inputSchema).toEqual(testRun.inputSchema);
    expect(forwarded[0].options.signal).toBeInstanceOf(AbortSignal);
    expect(callWaitMs(forwarded[0].args, forwarded[0].options)).toBe(150_000);
    expect(callWaitMs(forwarded[1].args, forwarded[1].options)).toBe(120_000);
    expect(forwarded[2].options.inputSchema).toBeUndefined();
    expect(callWaitMs(forwarded[2].args, forwarded[2].options)).toBe(60_000);
  });

  it("says what a call that failed did to the image", async () => {
    const images = new FakeImages([row("p13", { port: 7001 })]);
    const failures: Record<string, Error> = {
      not_found: forwardFailure("MCP error -32601: Method not found", { kind: "answered", rpcCode: -32601 }),
      invalid: forwardFailure("MCP error -32602: Invalid method parameter(s).", { kind: "answered", rpcCode: -32602 }),
      busy: forwardFailure("MCP initialize timed out after 60000ms", { kind: "no-handshake", waitedMs: 60_000 }),
      slow: forwardFailure("MCP request timed out after 120000ms", { kind: "timeout", waitedMs: 120_000 }),
      refused: forwardFailure("connect ECONNREFUSED 127.0.0.1:7001", { kind: "refused" }),
      save: forwardFailure("socket hang up", { kind: "closed" }),
      broken: forwardFailure("HTTP 500 Internal Server Error", { kind: "other" }),
    };
    const { call } = await connect(images, {}, async (_endpoint, name) => {
      if (name === "quit") {
        images.rows = [row("p13")];
        throw forwardFailure("socket hang up", { kind: "closed" });
      }
      throw failures[name];
    });

    const answers: Array<[string, string]> = [
      [
        "not_found",
        "Image p13 answered that it has no tool not_found: tool_search finds the tools it has.",
      ],
      ["invalid", "MCP error -32602: Invalid method parameter(s)."],
      [
        "busy",
        "Image p13 did not answer within 60 s, so busy was not sent. It still runs, and may be busy with an earlier call: image_stop kills it without saving, and image_start then starts it as it was last saved.",
      ],
      [
        "slow",
        "Image p13 did not answer slow within 120 s, and still runs: it may still be working on the call. image_stop kills it without saving, and image_start then starts it as it was last saved.",
      ],
      ["refused", "Image p13 runs, but refused the connection for refused, so the call was not made."],
      [
        "save",
        "Image p13 closed the connection before answering save, and still runs: check whether the call took effect before making it again.",
      ],
      ["broken", "Image p13 did not answer broken: HTTP 500 Internal Server Error. It still runs."],
      ["quit", "Image p13 stopped before answering quit. Start it with image_start; it starts as it was last saved."],
    ];
    for (const [name, answer] of answers) {
      const result = await call(name);
      expect(result.isError, name).toBe(true);
      expect(textOf(result), name).toBe(answer);
    }
  });

  it("names the tool an image lists for one it does not have, asking it for its listing", async () => {
    const notFound = forwardFailure("MCP error -32601: Method not found", { kind: "answered", rpcCode: -32601 });
    const { call } = await connect(
      new FakeImages([row("eval", { port: 7001 }), row("p13", { port: 7002 })]),
      {
        "http://127.0.0.1:7001/": [tool("evaluate"), tool("class_search")],
        "http://127.0.0.1:7002/": [tool("image_evaluate"), tool("class_search")],
      },
      async (endpoint, name) => {
        if (endpoint.url === "http://127.0.0.1:7002/" && name !== "image_evaluate") {
          throw notFound;
        }
        return { content: [{ type: "text", text: `${name} answered` }] };
      },
    );

    // No tools/list came first: the image is asked when the call fails.
    expect(textOf(await call("evaluate", { image: "p13", code: "3 + 4" }))).toBe(
      "Image p13 answered that it has no tool evaluate, but it lists image_evaluate: call that instead.",
    );
  });

  it("aborts a forwarded call the host cancels, and answers nothing for it", async () => {
    let signal: AbortSignal | undefined;
    const { client, responded } = await connect(new FakeImages([row("dev", { port: 7001 })]), {}, (_endpoint, _name, _args, options) => {
      signal = options.signal;
      return new Promise((_resolve, reject) => {
        options.signal?.addEventListener("abort", () =>
          reject(forwardFailure("MCP request cancelled", { kind: "cancelled" })),
        );
      });
    });

    const controller = new AbortController();
    const call = client.callTool({ name: "image_evaluate", arguments: {} }, { signal: controller.signal });
    while (signal === undefined) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    const answeredBefore = responded.length;
    controller.abort();
    await expect(call).rejects.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(signal.aborted).toBe(true);
    expect(responded).toHaveLength(answeredBefore);
  });

  it("says the tool list changed after a start, a stop or a delete, an image that stopped unsaved included, and only then", async () => {
    const { call, changes, listChanged } = await connect(new FakeImages([row("dev")]));

    await call("image_list");
    await call("image_templates");
    await call("image_create", { image: "new", template: "T", start: false });
    await call("image_create", { image: "broken" });
    await call("image_start", { image: "broken" });
    await call("image_start", {});
    expect(await listChanged()).toBe(0);
    await call("image_create", { image: "newer" });
    expect(await listChanged()).toBe(1);
    await call("image_stop", { image: "newer" });
    expect(await listChanged()).toBe(2);

    await call("image_start", { image: "dev" });
    expect(await listChanged()).toBe(3);
    await call("image_stop", { image: "dev" });
    await call("image_delete", { image: "dev" });
    expect(await listChanged()).toBe(5);

    await call("image_stop", { image: "unsavable", save: true });
    expect(await listChanged()).toBe(5);
    expect((await call("image_stop", { image: "unsaved", save: true })).isError).toBe(true);
    expect(await listChanged()).toBe(6);
    // Without an SDK there is no trace context to pass.
    expect(changes).toEqual(Array(6).fill(undefined));
  });
});
