import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  ToolListChangedNotificationSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { PlexusError } from "../../src/errors.js";
import { createPlexusMcpServer, type ImagesApi } from "../../src/mcp/server.js";
import type { CreateOptions, Endpoint, ImageInfo, StartOptions } from "../../src/types.js";

function row(name: string, state: { port?: number; running?: boolean } = {}): ImageInfo {
  const running = state.running ?? state.port !== undefined;
  return {
    name,
    diskName: `Scope-${name}`,
    path: `/home/.plexus/profiles/images/Scope-${name}/Scope-${name}.image`,
    running,
    pids: running ? [100] : [],
    ...(state.port === undefined ? {} : { endpoint: { url: `http://127.0.0.1:${state.port}/`, pid: 100 } }),
    ...(running && state.port === undefined ? { endpointProblem: "no endpoint written yet" } : {}),
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
      throw new PlexusError("no-such-image", `There is no image ${name}.`);
    }
    return found;
  }

  async create(name: string, options: CreateOptions) {
    this.calls.push(["create", name, options]);
    return { ...row(name), fromBase: true, seconds: 1 };
  }

  async start(name: string, options?: StartOptions) {
    this.calls.push(["start", name, options]);
    if (name === "broken") {
      throw new PlexusError("start-failed", "Image broken exited during start.");
    }
    return { name, pids: [100], endpoint: { url: "http://127.0.0.1:7001/" }, display: options?.display ?? "headless", seconds: 2 };
  }

  async stop(name: string) {
    this.calls.push(["stop", name]);
    return { name, killed: [100] };
  }

  async delete(name: string) {
    this.calls.push(["delete", name]);
    return { name };
  }
}

function tool(name: string, properties: Record<string, object> = {}, required: string[] = []): Tool {
  return { name, description: `${name} in the image`, inputSchema: { type: "object", properties, required } };
}

async function connect(
  images: FakeImages,
  toolsByUrl: Record<string, Tool[] | Error> = {},
) {
  const forwarded: Array<{ endpoint: Endpoint; name: string; args: Record<string, unknown> }> = [];
  const server = createPlexusMcpServer({
    images,
    listTools: async (endpoint) => {
      const tools = toolsByUrl[endpoint.url];
      if (tools instanceof Error || tools === undefined) {
        throw tools ?? new Error("connection refused");
      }
      return tools;
    },
    callTool: async (endpoint, name, args): Promise<CallToolResult> => {
      forwarded.push({ endpoint, name, args });
      return { content: [{ type: "text", text: `${name} answered` }] };
    },
  });
  const client = new Client({ name: "test", version: "1.0.0" });
  let listChanged = 0;
  client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
    listChanged += 1;
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    forwarded,
    listChanged: async () => {
      await new Promise((resolve) => setImmediate(resolve));
      return listChanged;
    },
    call: async (name: string, args: Record<string, unknown> = {}) =>
      (await client.callTool({ name, arguments: args })) as CallToolResult,
  };
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
    expect(tools.find((each) => each.name === "image_stop")?.description).toContain("without saving");
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
    expect(forwarded).toEqual([
      { endpoint: { url: "http://127.0.0.1:7001/", pid: 100 }, name: "class_search", args: { name: "Object" } },
      { endpoint: { url: "http://127.0.0.1:7001/", pid: 100 }, name: "class_search", args: { name: "Object" } },
    ]);
  });

  it("asks which image when several run, and refuses one that cannot take the call", async () => {
    const { call, forwarded } = await connect(
      new FakeImages([row("a", { port: 7001 }), row("b", { port: 7002 }), row("idle"), row("starting", { running: true })]),
    );

    const ambiguous = await call("eval");
    expect(ambiguous.isError).toBe(true);
    expect(textOf(ambiguous)).toBe("Several images are running (a, b): name one with the image argument.");

    await call("eval", { image: "b", code: "1" });
    expect(forwarded.at(-1)).toMatchObject({ endpoint: { url: "http://127.0.0.1:7002/" }, args: { code: "1" } });

    expect(textOf(await call("eval", { image: "idle" }))).toBe("Image idle is not running.");
    expect(textOf(await call("eval", { image: "starting" }))).toBe(
      "Image starting runs, but has no endpoint to forward to: no endpoint written yet.",
    );
    expect(textOf(await call("eval", { image: "gone" }))).toBe('There is no image "gone".');
  });

  it("knows no tool beyond its own while no image runs", async () => {
    const { call } = await connect(new FakeImages([row("dev")]));
    const result = await call("class_search");
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe("Unknown tool: class_search");
  });

  it("answers the image tools from Images, refusals as their code", async () => {
    const images = new FakeImages([row("dev")]);
    const { call } = await connect(images);

    expect(JSON.parse(textOf(await call("image_list")))).toEqual([row("dev")]);
    expect(JSON.parse(textOf(await call("image_list", { name: "dev" })))).toEqual([row("dev")]);
    await call("image_create", { name: "new", template: "Pharo 14.0 - 64bit", category: "Official distributions" });
    await call("image_start", { name: "dev", display: "interactive" });
    expect(images.calls).toContainEqual(["create", "new", { template: "Pharo 14.0 - 64bit", category: "Official distributions" }]);
    expect(images.calls).toContainEqual(["start", "dev", { display: "interactive" }]);

    const refused = await call("image_list", { name: "gone" });
    expect(refused.isError).toBe(true);
    expect(JSON.parse(textOf(refused))).toEqual({ ok: false, code: "no-such-image", error: "There is no image gone." });
  });

  it("says the tool list changed after a start, a stop or a delete, and only then", async () => {
    const { call, listChanged } = await connect(new FakeImages([row("dev")]));

    await call("image_list");
    await call("image_templates");
    await call("image_create", { name: "new", template: "T" });
    await call("image_start", { name: "broken" });
    expect(await listChanged()).toBe(0);

    await call("image_start", { name: "dev" });
    expect(await listChanged()).toBe(1);
    await call("image_stop", { name: "dev" });
    await call("image_delete", { name: "dev" });
    expect(await listChanged()).toBe(3);
  });
});
