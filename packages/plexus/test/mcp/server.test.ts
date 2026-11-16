import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  ToolListChangedNotificationSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import * as texts from "../../src/answers/texts.js";
import { defaultPharoMcpVersion } from "../../src/config/pharoMcpVersion.js";
import { PlexusError } from "../../src/errors.js";
import { callWaitMs } from "../../src/forward/index.js";
import {
  createPlexusMcpServer,
  type ForwardOptions,
  type ImagesApi,
  type PlexusMcpServerOptions,
} from "../../src/mcp/server.js";
import type { CreateOptions, Endpoint, ImageInfo, StartOptions, StopOptions } from "../../src/types.js";

function row(
  name: string,
  state: { port?: number; running?: boolean; problem?: string; fields?: Partial<ImageInfo> } = {},
): ImageInfo {
  const running = state.running ?? state.port !== undefined;
  return {
    name,
    diskName: `Scope-${name}`,
    path: `/home/.plexus/profiles/images/Scope-${name}/Scope-${name}.image`,
    running,
    pids: running ? [100] : [],
    ...(state.port === undefined ? {} : { endpoint: { url: `http://127.0.0.1:${state.port}/`, pid: 100 } }),
    ...(running && state.port === undefined ? { endpointProblem: state.problem ?? "no endpoint written yet" } : {}),
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
    return { ...row(name, { fields: { template: options.template } }), fromBase: true, seconds: 1 };
  }

  async start(name: string, options?: StartOptions) {
    this.calls.push(["start", name, options]);
    if (name === "broken") {
      throw new PlexusError("start-failed", "Image broken exited during start.");
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
    return { name };
  }
}

function tool(name: string, properties: Record<string, object> = {}, required: string[] = []): Tool {
  return { name, description: `${name} in the image`, inputSchema: { type: "object", properties, required } };
}

type Forwarded = { endpoint: Endpoint; name: string; args: Record<string, unknown>; options: ForwardOptions };

async function connect(
  images: FakeImages,
  toolsByUrl: Record<string, Tool[] | Error> = {},
  answer: NonNullable<PlexusMcpServerOptions["callTool"]> = async (_endpoint, name) => ({
    content: [{ type: "text", text: `${name} answered` }],
  }),
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
    callTool: async (endpoint, name, args, options): Promise<CallToolResult> => {
      forwarded.push({ endpoint, name, args, options });
      return answer(endpoint, name, args, options);
    },
  });
  const client = new Client({ name: "test", version: "1.0.0" });
  let listChanged = 0;
  client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
    listChanged += 1;
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
    expect(tools.find((each) => each.name === "image_start")?.description).toContain("refuses an image that is already running");
    const imageStop = tools.find((each) => each.name === "image_stop")!;
    expect(imageStop.description).toContain("without saving");
    expect(imageStop.description).toContain("With save: true, the image saves itself and quits");
    expect(imageStop.description).toContain("Evaluating `Smalltalk saveSession` in the image saves it without stopping it.");
    expect(imageStop.inputSchema.properties).toMatchObject({ save: { type: "boolean" } });
    expect(imageStop.inputSchema.required).toEqual(["name"]);
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

  it("knows no tool beyond its own while no image runs", async () => {
    const { call } = await connect(new FakeImages([row("dev")]));
    const result = await call("class_search");
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(
      "No image is running to take class_search. Start one with image_start; it starts as it was last saved.",
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
      row("dev", { fields: { template: "Pharo 14.0 - 64bit", pharoVersion: "140", mcp: { source: "pin", version: defaultPharoMcpVersion } } }),
      row("old", { port: 7001, fields: { template: "Pharo 13.0 - 64bit", pharoVersion: "130", mcp: older, everyStart: "/abs/load.st" } }),
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
        "images:",
        `  dev state=stopped pharo=14.0 template="Pharo 14.0 - 64bit" mcp=${defaultPharoMcpVersion}`,
        '  old state=running pharo=13.0 template="Pharo 13.0 - 64bit" mcp=3.7.0',
      ].join("\n"),
    );
    expect(textOf(await call("image_list", { name: "dev" }))).toBe(
      [
        "Image dev is not running.",
        "pharo: 14.0",
        "template: Pharo 14.0 - 64bit",
        `mcp: ${defaultPharoMcpVersion}`,
        "path: /home/.plexus/profiles/images/Scope-dev/Scope-dev.image",
      ].join("\n"),
    );
    expect(
      textOf(await call("image_create", { name: "new", template: "Pharo 14.0 - 64bit", category: "Official distributions" })),
    ).toBe("Created image new from Pharo 14.0 - 64bit. It is not running yet; image_start starts it.");
    expect(textOf(await call("image_start", { name: "dev", display: "interactive" }))).toBe(
      'Started image dev as it was last saved, with its window open. Pass image: "dev" to its tools while another image runs.',
    );
    expect(textOf(await call("image_start", { name: "old" }))).toBe(
      [
        'Started image old as it was last saved, with /abs/load.st filed in again. Pass image: "old" to its tools while another image runs.',
        olderWarning,
      ].join("\n"),
    );
    expect(textOf(await call("image_stop", { name: "dev" }))).toBe(
      "Stopped image dev; what it had not saved is lost. image_stop with save: true saves an image before stopping it.",
    );
    expect(textOf(await call("image_stop", { name: "old", save: true }))).toBe("Saved and stopped image old.");
    expect(textOf(await call("image_delete", { name: "dev" }))).toBe("Deleted image dev and its files.");
    expect(images.calls).toContainEqual(["create", "new", { template: "Pharo 14.0 - 64bit", category: "Official distributions" }]);
    expect(images.calls).toContainEqual(["start", "dev", { display: "interactive" }]);
    expect(images.calls).toContainEqual(["start", "old", {}]);
    expect(images.calls).toContainEqual(["stop", "dev", {}]);
    expect(images.calls).toContainEqual(["stop", "old", { save: true }]);

    for (const [tool, args, refusal] of [
      ["image_list", { name: "gone" }, "There is no image gone. image_list names the images there are; image_create makes one."],
      ["image_start", { name: "broken" }, "Image broken exited during start."],
    ] as const) {
      const refused = await call(tool, args);
      expect(refused.isError, tool).toBe(true);
      expect(textOf(refused), tool).toBe(refusal);
    }
  });

  it("refuses arguments that break a tool's schema before any of it runs", async () => {
    const images = new FakeImages([row("dev")]);
    const { call } = await connect(images);

    for (const [tool, args, refusal] of [
      ["image_start", {}, "Invalid arguments for image_start. name is required."],
      ["image_start", { name: "  " }, "Invalid arguments for image_start. name is required."],
      [
        "image_delete",
        { name: "dev", force: true },
        "Invalid arguments for image_delete. force is not accepted here; expected one of name.",
      ],
      [
        "image_start",
        { name: "dev", display: "window" },
        'Invalid arguments for image_start. display must be "headless" or "interactive", not "window".',
      ],
      ["image_create", { name: "new", template: 3 }, "Invalid arguments for image_create. template must be string, not integer."],
      ["image_stop", { name: "dev", save: "yes" }, "Invalid arguments for image_stop. save must be boolean, not string."],
    ] as const) {
      const result = await call(tool, args);
      expect(result.isError, tool).toBe(true);
      expect(textOf(result), JSON.stringify(args)).toBe(refusal);
    }
    expect(images.calls).toEqual([]);
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
    const call = client.callTool({ name: "image_evaluate", arguments: {} }, undefined, { signal: controller.signal });
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
    const { call, listChanged } = await connect(new FakeImages([row("dev")]));

    await call("image_list");
    await call("image_templates");
    await call("image_create", { name: "new", template: "T" });
    await call("image_start", { name: "broken" });
    await call("image_start", {});
    expect(await listChanged()).toBe(0);

    await call("image_start", { name: "dev" });
    expect(await listChanged()).toBe(1);
    await call("image_stop", { name: "dev" });
    await call("image_delete", { name: "dev" });
    expect(await listChanged()).toBe(3);

    await call("image_stop", { name: "unsavable", save: true });
    expect(await listChanged()).toBe(3);
    expect((await call("image_stop", { name: "unsaved", save: true })).isError).toBe(true);
    expect(await listChanged()).toBe(4);
  });
});
