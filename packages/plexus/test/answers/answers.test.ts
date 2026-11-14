import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import {
  checkArguments,
  created,
  deleted,
  image,
  list,
  olderMcp,
  pharoVersion,
  render,
  started,
  state,
  stopped,
  templates,
} from "../../src/answers/index.js";
import { defaultPharoMcpVersion } from "../../src/config/pharoMcpVersion.js";
import { imageTools } from "../../src/mcp/server.js";
import type { ImageInfo } from "../../src/types.js";

const nextStable = "Pharo 14.0 - 64bit (next stable)";

function row(name: string, fields: Partial<ImageInfo> = {}): ImageInfo {
  return {
    name,
    diskName: `plexus_image-${name}`,
    path: `/Users/me/.plexus/profiles/images/plexus_image-${name}/plexus_image-${name}.image`,
    running: false,
    pids: [],
    ...fields,
  };
}

function runningRow(name: string, fields: Partial<ImageInfo> = {}): ImageInfo {
  return row(name, {
    running: true,
    pids: [4242],
    display: "headless",
    endpoint: { url: "http://127.0.0.1:7001/", pid: 4242 },
    ...fields,
  });
}

const pinned = { source: "pin", version: defaultPharoMcpVersion } as const;

function tool(name: string): Tool {
  const found = imageTools.find((each) => each.name === name);
  if (found === undefined) {
    throw new Error(`plexus mcp serves no ${name}`);
  }
  return found;
}

describe("render", () => {
  it("writes the summary, the warnings, the fields, the list and the groups, in that order", () => {
    expect(
      render({
        summary: "Something happened. Then more.",
        warnings: ["One thing.", "Another."],
        fields: [
          ["path", "/a b/c"],
          ["every start", "/abs/load.st"],
        ],
        list: {
          label: "images",
          records: [
            { name: "dev", pairs: [["state", "running"]] },
            { name: "ci", pairs: [["state", "stopped"]] },
          ],
        },
        groups: [{ label: "Category", lines: ["Pharo 15.0 - 64bit (development version, latest)"] }],
      }),
    ).toBe(
      [
        "Something happened. Then more.",
        "Warning: One thing.",
        "Warning: Another.",
        "path: /a b/c",
        "every start: /abs/load.st",
        "images:",
        "  dev state=running",
        "  ci state=stopped",
        "Category:",
        "  Pharo 15.0 - 64bit (development version, latest)",
      ].join("\n"),
    );
  });

  it("quotes a record's value holding whitespace, escaping its quotes, and prints any other as it is", () => {
    expect(
      render({
        summary: "S.",
        warnings: [],
        fields: [],
        list: {
          label: "items",
          records: [
            { name: "a", pairs: [["note", 'say "hi" \\ go'], ["mark", 'it"s']] },
          ],
        },
      }),
    ).toBe(['S.', "items:", '  a note="say \\"hi\\" \\\\ go" mark=it"s'].join("\n"));
  });

  it("says once beside the label a field every record holds with the same value, and not for one record", () => {
    const records = [
      { name: "a", pairs: [["state", "running"], ["pharo", "14.0"], ["mcp", "3.8.0"]] as [string, string][] },
      { name: "b", pairs: [["pharo", "14.0"], ["state", "stopped"], ["mcp", "3.8.0"]] as [string, string][] },
    ];
    expect(render({ summary: "S.", warnings: [], fields: [], list: { label: "images", records } })).toBe(
      ["S.", "images (each pharo=14.0 mcp=3.8.0):", "  a state=running", "  b state=stopped"].join("\n"),
    );
    expect(
      render({ summary: "S.", warnings: [], fields: [], list: { label: "images", records: records.slice(0, 1) } }),
    ).toBe(["S.", "images:", "  a state=running pharo=14.0 mcp=3.8.0"].join("\n"));
  });

  it("lifts a field even when the records keep only their names", () => {
    const records = [
      { name: "a", pairs: [["state", "stopped"]] as [string, string][] },
      { name: "b", pairs: [["state", "stopped"]] as [string, string][] },
    ];
    expect(render({ summary: "S.", warnings: [], fields: [], list: { label: "images", records } })).toBe(
      ["S.", "images (each state=stopped):", "  a", "  b"].join("\n"),
    );
  });

  it("writes no list for no record", () => {
    expect(render({ summary: "S.", warnings: [], fields: [], list: { label: "images", records: [] } })).toBe("S.");
  });
});

describe("the facts of an image", () => {
  it("reads a Pharo version as Pharo says it", () => {
    expect(pharoVersion("140")).toBe("14.0");
    expect(pharoVersion("61")).toBe("6.1");
    expect(pharoVersion("x")).toBe("x");
    expect(pharoVersion("1400")).toBe("1400");
  });

  it("says creating whatever runs it, then stopped, starting or running", () => {
    expect(state(row("a", { building: true }))).toBe("creating");
    expect(
      state(row("a", { running: true, building: true, endpointProblem: "not started by this PLexus" })),
    ).toBe("creating");
    expect(state(row("a"))).toBe("stopped");
    expect(state(row("a", { running: true, endpointProblem: "no endpoint written yet" }))).toBe("starting");
    expect(state(runningRow("a"))).toBe("running");
    expect(state(row("a", { running: true, endpointProblem: "not started by this PLexus" }))).toBe("running");
  });

  it("warns of an image pinned to another MCP than the current one, not of a script's", () => {
    expect(olderMcp(row("old", { mcp: { source: "pin", version: "3.7.0" } }))).toBe(
      `Image old holds Pharo MCP 3.7.0, and images are created with ${defaultPharoMcpVersion} now, so its tools may differ from the current ones. Recreating it gives it the current MCP.`,
    );
    expect(olderMcp(row("new", { mcp: pinned }))).toBeUndefined();
    expect(olderMcp(row("mine", { mcp: { source: "script", script: "/abs/MCP.st" } }))).toBeUndefined();
    expect(olderMcp(row("unknown"))).toBeUndefined();
  });
});

describe("image_templates", () => {
  it("lists the names under their categories, and says which need one", () => {
    const answer = templates([
      { name: "Pharo 14.0 - 64bit (stable)", category: "Official distributions" },
      { name: "Pharo 13.0 - 64bit", category: "Official distributions" },
      { name: "Pharo 10.0 - 64bit", category: "Official distributions", ambiguous: true },
      { name: "Pharo 10.0 - 64bit", category: "Pharo Mooc", ambiguous: true },
    ]);
    expect(render(answer)).toBe(
      [
        "4 templates in 2 categories. Pharo 10.0 - 64bit is in more than one, so image_create needs its category.",
        "Official distributions:",
        "  Pharo 14.0 - 64bit (stable)",
        "  Pharo 13.0 - 64bit",
        "  Pharo 10.0 - 64bit",
        "Pharo Mooc:",
        "  Pharo 10.0 - 64bit",
      ].join("\n"),
    );
  });

  it("names every template in several categories", () => {
    const twice = (name: string) => [
      { name, category: "A" },
      { name, category: "B" },
    ];
    expect(templates([...twice("X"), ...twice("Y")]).summary).toBe(
      "4 templates in 2 categories. X and Y are each in more than one, so image_create needs their category.",
    );
    expect(templates([...twice("X"), ...twice("Y"), ...twice("Z")]).summary).toBe(
      "6 templates in 2 categories. X, Y, and Z are each in more than one, so image_create needs their category.",
    );
    expect(templates([{ name: "X", category: "A" }]).summary).toBe("1 template in 1 category.");
  });

  it("says when there is none", () => {
    expect(render(templates([]))).toBe("No templates are listed.");
  });
});

describe("image_list", () => {
  it("says what main-1's three images are, sharing what they share", () => {
    const answer = list([
      runningRow("eval", { pharoVersion: "140", template: nextStable, mcp: { source: "script", script: "/abs/MCP-14ae2d5.st" } }),
      runningRow("old", { pharoVersion: "140", template: nextStable, mcp: pinned }),
      row("scratch", { pharoVersion: "140", template: nextStable, mcp: pinned }),
    ]);
    const text = render(answer);
    expect(text).toBe(
      [
        "3 images, 2 running.",
        'images (each pharo=14.0 template="Pharo 14.0 - 64bit (next stable)"):',
        "  eval state=running mcp=script",
        "  old state=running mcp=3.8.0",
        "  scratch state=stopped mcp=3.8.0",
      ].join("\n"),
    );
    expect(text).toHaveLength(186);
  });

  it("gives each field only when known, and the display only when a window is open", () => {
    expect(
      render(
        list([
          runningRow("dev", { display: "interactive", pharoVersion: "130", template: "Pharo 13.0 - 64bit", mcp: pinned }),
          row("bare"),
        ]),
      ),
    ).toBe(
      [
        "2 images, 1 running.",
        "images:",
        `  dev state=running pharo=13.0 template="Pharo 13.0 - 64bit" mcp=${defaultPharoMcpVersion} display=interactive`,
        "  bare state=stopped",
      ].join("\n"),
    );
  });

  it("warns of an image that takes no calls and of an older MCP, in record order", () => {
    const text = render(
      list([
        row("legacy", { running: true, pids: [5120], endpointProblem: "not started by this PLexus" }),
        row("old", { mcp: { source: "pin", version: "3.7.0" } }),
      ]),
    );
    expect(text.split("\n").slice(0, 3)).toEqual([
      "2 images, 1 running.",
      "Warning: Image legacy runs as pid 5120 but takes no calls: not started by this PLexus. image_stop kills that VM without saving; image_start then starts it as it was last saved.",
      `Warning: Image old holds Pharo MCP 3.7.0, and images are created with ${defaultPharoMcpVersion} now, so its tools may differ from the current ones. Recreating it gives it the current MCP.`,
    ]);
  });

  it("warns of neither a starting image nor one a create runs", () => {
    const answer = list([
      row("dev", { running: true, pids: [4242], endpointProblem: "no endpoint written yet" }),
      row("spike", {
        running: true,
        pids: [4243],
        building: true,
        endpointProblem: "not started by this PLexus",
      }),
    ]);
    expect(answer.warnings).toEqual([]);
    expect(render(answer)).toBe(
      ["2 images, none running.", "images:", "  dev state=starting", "  spike state=creating"].join("\n"),
    );
  });

  it("adds what a server knows to each record", () => {
    expect(
      render(list([runningRow("dev"), row("ci")], (each) => (each.name === "dev" ? [["mount", ".pharo-agent/mounts/dev"]] : []))),
    ).toBe(["2 images, 1 running.", "images:", "  dev state=running mount=.pharo-agent/mounts/dev", "  ci state=stopped"].join("\n"));
  });

  it("counts one image as one, and says where to start with none", () => {
    expect(list([row("dev")]).summary).toBe("1 image, none running.");
    expect(render(list([]))).toBe("No image yet: image_templates lists the templates image_create makes one from.");
  });

  it("describes a named image alone, with its path", () => {
    expect(render(image(runningRow("spike", { pharoVersion: "140", template: nextStable, mcp: pinned })))).toBe(
      [
        "Image spike is running.",
        "pharo: 14.0",
        `template: ${nextStable}`,
        `mcp: ${defaultPharoMcpVersion}`,
        "path: /Users/me/.plexus/profiles/images/plexus_image-spike/plexus_image-spike.image",
      ].join("\n"),
    );
  });

  it("says a named image's state, its script and what every start files in", () => {
    expect(image(runningRow("spike", { display: "interactive" })).summary).toBe(
      "Image spike is running, with its window open.",
    );
    expect(image(row("spike", { running: true, pids: [4242], endpointProblem: "no endpoint written yet" })).summary).toBe(
      "Image spike is starting: its MCP server does not answer yet.",
    );
    expect(image(row("spike", { building: true })).summary).toBe("Image spike is being created.");
    expect(
      render(
        image(
          row("scratch", {
            mcp: { source: "script", script: "/abs/MCP-14ae2d5.st" },
            everyStart: "/abs/load.st",
          }),
        ),
      ),
    ).toBe(
      [
        "Image scratch is not running.",
        "mcp: script /abs/MCP-14ae2d5.st",
        "every start: /abs/load.st",
        "path: /Users/me/.plexus/profiles/images/plexus_image-scratch/plexus_image-scratch.image",
      ].join("\n"),
    );
    expect(
      image(row("legacy", { running: true, pids: [5120], endpointProblem: "not started by this PLexus" })).warnings,
    ).toEqual([
      "Image legacy runs as pid 5120 but takes no calls: not started by this PLexus. image_stop kills that VM without saving; image_start then starts it as it was last saved.",
    ]);
  });
});

describe("image_create, image_start, image_stop and image_delete", () => {
  it("says what a create made, and that it does not run yet", () => {
    expect(render(created(row("p13", { template: "Pharo 13.0 - 64bit (stable)", mcp: pinned })))).toBe(
      "Created image p13 from Pharo 13.0 - 64bit (stable). It is not running yet; image_start starts it.",
    );
    expect(
      render(
        created(row("mine", { template: "Pharo 14.0 - 64bit (stable)", mcp: { source: "script", script: "/abs/load-my-mcp.st" } })),
      ),
    ).toBe(
      "Created image mine from Pharo 14.0 - 64bit (stable), with /abs/load-my-mcp.st filed in instead of the pinned MCP. It is not running yet; image_start starts it.",
    );
    expect(
      created(
        row("mine", {
          template: "Pharo 14.0 - 64bit (stable)",
          mcp: { source: "script", script: "/abs/load-my-mcp.st" },
          everyStart: "/abs/load-my-mcp.st",
        }),
      ).summary,
    ).toBe(
      "Created image mine from Pharo 14.0 - 64bit (stable), with /abs/load-my-mcp.st filed in instead of the pinned MCP, and again at every start. It is not running yet; image_start starts it.",
    );
    expect(created(row("p13", { mcp: pinned })).summary).toBe(
      "Created image p13. It is not running yet; image_start starts it.",
    );
  });

  it("says a start is of the image as it was last saved, and nothing of pids or endpoints", () => {
    expect(render(started({ name: "p13", display: "headless" }, row("p13", { mcp: pinned })))).toBe(
      "Started image p13 as it was last saved.",
    );
    expect(started({ name: "p13", display: "interactive" }).summary).toBe(
      "Started image p13 as it was last saved, with its window open.",
    );
    expect(started({ name: "mine", display: "headless" }, row("mine", { everyStart: "/abs/load.st" })).summary).toBe(
      "Started image mine as it was last saved, with /abs/load.st filed in again.",
    );
    expect(started({ name: "mine", display: "interactive" }, row("mine", { everyStart: "/abs/load.st" })).summary).toBe(
      "Started image mine as it was last saved, with its window open and /abs/load.st filed in again.",
    );
    expect(started({ name: "old", display: "headless" }, row("old", { mcp: { source: "pin", version: "3.7.0" } })).warnings).toEqual([
      `Image old holds Pharo MCP 3.7.0, and images are created with ${defaultPharoMcpVersion} now, so its tools may differ from the current ones. Recreating it gives it the current MCP.`,
    ]);
  });

  it("says a stop loses what was not saved, or that nothing ran", () => {
    expect(render(stopped({ name: "p13", killed: [4242] }))).toBe("Stopped image p13; what it had not saved is lost.");
    expect(render(stopped({ name: "p13", killed: [] }))).toBe("Image p13 was not running.");
  });

  it("says a delete took the files", () => {
    expect(render(deleted({ name: "old" }))).toBe("Deleted image old and its files.");
  });
});

describe("checkArguments", () => {
  it("passes the arguments a schema accepts", () => {
    expect(checkArguments(tool("image_start"), { name: "dev", display: "interactive" })).toBeUndefined();
    expect(checkArguments(tool("image_templates"), undefined)).toBeUndefined();
    expect(checkArguments(tool("image_list"), {})).toBeUndefined();
  });

  it("says an argument is required, a blank one being missing", () => {
    expect(checkArguments(tool("image_start"), {})).toBe("Invalid arguments for image_start. name is required.");
    expect(checkArguments(tool("image_start"), { name: "  " })).toBe(
      "Invalid arguments for image_start. name is required.",
    );
  });

  it("says an optional argument is blank", () => {
    expect(checkArguments(tool("image_create"), { name: "x", template: "y", category: " \t" })).toBe(
      "Invalid arguments for image_create. category is blank; leave it out or give it a value.",
    );
  });

  it("names the values an enum allows", () => {
    expect(checkArguments(tool("image_start"), { name: "dev", display: "window" })).toBe(
      'Invalid arguments for image_start. display must be "headless" or "interactive", not "window".',
    );
  });

  it("names a value's JSON type", () => {
    expect(checkArguments(tool("image_create"), { name: "x", template: 3 })).toBe(
      "Invalid arguments for image_create. template must be string, not integer.",
    );
    expect(checkArguments(tool("image_create"), { name: "x", template: 1.5 })).toBe(
      "Invalid arguments for image_create. template must be string, not number.",
    );
    for (const [value, type] of [
      [null, "null"],
      [{}, "object"],
      [[], "array"],
      [true, "boolean"],
    ] as const) {
      expect(checkArguments(tool("image_stop"), { name: value })).toBe(
        `Invalid arguments for image_stop. name must be string, not ${type}.`,
      );
    }
  });

  it("refuses an argument the schema does not accept, naming those it does", () => {
    expect(checkArguments(tool("image_delete"), { name: "dev", force: true })).toBe(
      "Invalid arguments for image_delete. force is not accepted here; expected one of name.",
    );
    expect(checkArguments(tool("image_templates"), { detail: 1 })).toBe(
      "Invalid arguments for image_templates. detail is not accepted here.",
    );
  });

  it("says the required first, then the values, then what is not accepted", () => {
    expect(checkArguments(tool("image_create"), { extra: 1, template: 3 })).toBe(
      "Invalid arguments for image_create. name is required. template must be string, not integer. extra is not accepted here; expected one of category, name, template.",
    );
  });

  it("checks only the type of what a schema accepting other arguments names", () => {
    const forwarded: Pick<Tool, "name" | "inputSchema"> = {
      name: "class_search",
      inputSchema: { type: "object", properties: { image: { type: "string" } } },
    };
    expect(checkArguments(forwarded, { image: 3, pattern: "Eval*" })).toBe(
      "Invalid arguments for class_search. image must be string, not integer.",
    );
    expect(checkArguments(forwarded, { pattern: "Eval*" })).toBeUndefined();
  });

  it("takes each server's own schema: the plugin's start needs no name, and its stop takes all", () => {
    const pluginStart: Pick<Tool, "name" | "inputSchema"> = {
      name: "image_start",
      inputSchema: {
        type: "object",
        properties: { name: { type: "string" }, display: { type: "string", enum: ["headless", "interactive"] } },
        additionalProperties: false,
      },
    };
    const pluginStop: Pick<Tool, "name" | "inputSchema"> = {
      name: "image_stop",
      inputSchema: {
        type: "object",
        properties: { name: { type: "string" }, all: { type: "boolean" } },
        additionalProperties: false,
      },
    };
    expect(checkArguments(pluginStart, {})).toBeUndefined();
    expect(checkArguments(pluginStop, {})).toBeUndefined();
    expect(checkArguments(pluginStop, { all: true })).toBeUndefined();
    expect(checkArguments(pluginStop, { all: "yes" })).toBe(
      "Invalid arguments for image_stop. all must be boolean, not string.",
    );
  });
});
