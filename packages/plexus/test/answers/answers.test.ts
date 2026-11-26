import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import {
  callFailed,
  checkArguments,
  created,
  deleted,
  image,
  list,
  olderMcp,
  render,
  started,
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
    path: `/Users/me/.plexus/profiles/images/plexus_image-${name}/plexus_image-${name}.image`,
    state: "stopped",
    running: false,
    pids: [],
    ...fields,
  };
}

function runningRow(name: string, fields: Partial<ImageInfo> = {}): ImageInfo {
  return row(name, {
    state: "running",
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
  it("writes the summary, the warnings, the fields, the lists and the groups, in that order", () => {
    expect(
      render({
        summary: "Something happened. Then more.",
        warnings: ["One thing.", "Another."],
        fields: [
          ["path", "/a b/c"],
          ["every start", "/abs/load.st"],
        ],
        lists: [
          { label: "running", records: [{ name: "dev", pairs: [["pharo", "14.0"]] }] },
          { label: "starting", records: [] },
          { label: "stopped", records: [{ name: "ci", pairs: [] }] },
        ],
        groups: [{ label: "Category", lines: ["Pharo 15.0 - 64bit (development version, latest)"] }],
      }),
    ).toBe(
      [
        "Something happened. Then more.",
        "Warning: One thing.",
        "Warning: Another.",
        "path: /a b/c",
        "every start: /abs/load.st",
        "running:",
        "  dev pharo=14.0",
        "stopped:",
        "  ci",
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
        lists: [
          {
            label: "items",
            records: [{ name: "a", pairs: [["note", 'say "hi" \\ go'], ["mark", 'it"s']] }],
          },
        ],
      }),
    ).toBe(['S.', "items:", '  a note="say \\"hi\\" \\\\ go" mark=it"s'].join("\n"));
  });

  it("writes no list for no record", () => {
    expect(render({ summary: "S.", warnings: [], fields: [], lists: [{ label: "images", records: [] }] })).toBe("S.");
  });
});

describe("the facts of an image", () => {
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
  it("lists the names under their categories", () => {
    const answer = templates([
      { name: "Pharo 14.0 - 64bit (stable)", category: "Official distributions" },
      { name: "Pharo 13.0 - 64bit", category: "Official distributions" },
      { name: "Pharo 10.0 - 64bit", category: "Pharo Mooc" },
    ]);
    expect(render(answer)).toBe(
      [
        "3 templates in 2 categories.",
        "Official distributions:",
        "  Pharo 14.0 - 64bit (stable)",
        "  Pharo 13.0 - 64bit",
        "Pharo Mooc:",
        "  Pharo 10.0 - 64bit",
      ].join("\n"),
    );
    expect(templates([{ name: "X", category: "A" }]).summary).toBe("1 template in 1 category.");
  });

  it("says when there is none", () => {
    expect(render(templates([]))).toBe("No templates are listed.");
  });
});

describe("image_list", () => {
  it("lists each image on one short line under its state, running ones first, with only what is not usual", () => {
    const answer = list([
      row("scratch", { pharoVersion: "14.0", template: nextStable, mcp: pinned }),
      runningRow("eval", { pharoVersion: "14.0", template: nextStable, mcp: { source: "script", script: "/abs/MCP-14ae2d5.st" } }),
      runningRow("old", { pharoVersion: "13.0", template: "Pharo 13.0 - 64bit (stable)", mcp: { source: "pin", version: "3.8.0" } }),
      row("moose", { pharoVersion: "12.0", template: "Moose Suite 12.0", mcp: pinned }),
      row("p10", { pharoVersion: "10.0", template: "Pharo 10.0 - 64bit", mcp: pinned }),
      row("legacy", { pharoVersion: "14.0", template: "Pharo 13.0 - 64bit", mcp: pinned }),
    ]);
    expect(render(answer)).toBe(
      [
        "6 images, 2 running.",
        `Warning: Image old holds Pharo MCP 3.8.0, and images are created with ${defaultPharoMcpVersion} now, so its tools may differ from the current ones. Recreating it gives it the current MCP.`,
        "running:",
        "  eval pharo=14.0 mcp=script",
        "  old pharo=13.0 mcp=3.8.0",
        "stopped:",
        "  scratch pharo=14.0",
        '  moose pharo=12.0 template="Moose Suite 12.0"',
        "  p10 pharo=10.0",
        '  legacy pharo=14.0 template="Pharo 13.0 - 64bit"',
      ].join("\n"),
    );
  });

  it("says once, naming the images, that several take no calls for the same reason", () => {
    const unreachable = (name: string, pids: number[], endpointProblem?: string) =>
      row(name, { state: "unreachable", pids, ...(endpointProblem === undefined ? {} : { endpointProblem }) });
    expect(list([unreachable("a", [11]), unreachable("b", [12, 13]), unreachable("c", [14], "its endpoint refused the connection")]).warnings).toEqual([
      "Images a (pid 11) and b (pids 12, 13) run but take no calls: it wrote no endpoint. image_stop kills an image's VMs without saving; image_start then starts it as it was last saved.",
      "Image c runs as pid 14 but takes no calls: its endpoint refused the connection. image_stop kills that VM without saving; image_start then starts it as it was last saved.",
    ]);
  });

  it("says once, naming the images, a warning that would repeat for each", () => {
    const older = (name: string, version = "3.8.0") => row(name, { mcp: { source: "pin", version } });
    expect(list([older("a"), row("b", { mcp: pinned }), older("c"), older("d", "3.7.0"), older("e")]).warnings).toEqual([
      `Images a, c, and e hold Pharo MCP 3.8.0, and images are created with ${defaultPharoMcpVersion} now, so their tools may differ from the current ones. Recreating them gives them the current MCP.`,
      `Image d holds Pharo MCP 3.7.0, and images are created with ${defaultPharoMcpVersion} now, so its tools may differ from the current ones. Recreating it gives it the current MCP.`,
    ]);
  });

  it("says the day a stopped image was last used and the size of its image file, which tell a stale one", () => {
    const usage = { lastUsed: "2026-11-03T17:12:45.000Z", imageBytes: 74_115_008 };
    expect(render(list([runningRow("dev", { lastUsed: "2026-11-24T09:00:00.000Z", imageBytes: 1 }), row("old", usage)]))).toBe(
      ["2 images, 1 running.", "running:", "  dev", "stopped:", "  old used=2026-11-03 size=74MB"].join("\n"),
    );
    expect(render(image(row("old", usage)))).toContain("used: 2026-11-03\nsize: 74MB");
  });

  it("gives each field only when known, and the display only when a window is open", () => {
    expect(
      render(
        list([
          runningRow("dev", { display: "interactive", pharoVersion: "13.0", template: "Pharo 13.0 - 64bit", mcp: pinned }),
          row("bare"),
        ]),
      ),
    ).toBe(["2 images, 1 running.", "running:", "  dev pharo=13.0 display=interactive", "stopped:", "  bare"].join("\n"));
  });

  it("warns of an image that takes no calls and of an older MCP, in record order", () => {
    const text = render(
      list([
        row("legacy", { state: "unreachable", running: true, pids: [5120], endpointProblem: "not started by this PLexus" }),
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
      row("dev", { state: "starting", running: true, pids: [4242] }),
      row("spike", {
        state: "creating",
        running: true,
        pids: [4243],
        endpointProblem: "not started by this PLexus",
      }),
    ]);
    expect(answer.warnings).toEqual([]);
    expect(render(answer)).toBe(["2 images, none running.", "starting:", "  dev", "creating:", "  spike"].join("\n"));
  });

  it("counts one image as one, and says where to start with none", () => {
    expect(list([row("dev")]).summary).toBe("1 image, none running.");
    expect(render(list([]))).toBe("No image yet: image_templates lists the templates image_create makes one from.");
  });

  it("describes a named image alone, with its path", () => {
    expect(render(image(runningRow("spike", { pharoVersion: "14.0", template: nextStable, mcp: pinned })))).toBe(
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
    expect(image(row("spike", { state: "starting", running: true, pids: [4242] })).summary).toBe(
      "Image spike is starting: its MCP server does not answer yet.",
    );
    expect(image(row("spike", { state: "creating" })).summary).toBe("Image spike is being created.");
    expect(
      render(
        image(
          row("scratch", {
            mcp: { source: "script", script: "/abs/load.st", everyStart: true },
          }),
        ),
      ),
    ).toBe(
      [
        "Image scratch is not running.",
        "mcp: script /abs/load.st",
        "every start: /abs/load.st",
        "path: /Users/me/.plexus/profiles/images/plexus_image-scratch/plexus_image-scratch.image",
      ].join("\n"),
    );
    expect(
      image(row("legacy", { state: "unreachable", running: true, pids: [5120], endpointProblem: "not started by this PLexus" })).warnings,
    ).toEqual([
      "Image legacy runs as pid 5120 but takes no calls: not started by this PLexus. image_stop kills that VM without saving; image_start then starts it as it was last saved.",
    ]);
  });
});

describe("image_create, image_start, image_stop and image_delete", () => {
  it("says what a create made, and what starts it", () => {
    expect(render(created(row("p13", { template: "Pharo 13.0 - 64bit (stable)", mcp: pinned })))).toBe(
      "Created image p13; image_start starts it.",
    );
    expect(
      render(
        created(row("mine", { template: "Pharo 14.0 - 64bit (stable)", mcp: { source: "script", script: "/abs/load-my-mcp.st" } })),
      ),
    ).toBe(
      "Created image mine, with /abs/load-my-mcp.st filed in instead of the pinned MCP; image_start starts it.",
    );
    expect(
      created(
        row("mine", {
          template: "Pharo 14.0 - 64bit (stable)",
          mcp: { source: "script", script: "/abs/load-my-mcp.st", everyStart: true },
        }),
      ).summary,
    ).toBe(
      "Created image mine, with /abs/load-my-mcp.st filed in instead of the pinned MCP, and again at every start; image_start starts it.",
    );
  });

  it("says an image a start found running was already running, as a start would say the rest", () => {
    expect(render(started({ name: "p13", display: "headless", alreadyRunning: true }, row("p13", { mcp: pinned })))).toBe(
      "Image p13 was already running.",
    );
    expect(started({ name: "p13", display: "interactive", alreadyRunning: true }).summary).toBe(
      "Image p13 was already running, with its window open.",
    );
    expect(render(started({ name: "dev", display: "headless", alreadyRunning: true, telemetry: { on: true } }, undefined, { enrolled: true }))).toBe(
      "Image dev was already running.\ntelemetry: on",
    );
  });

  it("says a start, and nothing of pids or endpoints", () => {
    expect(render(started({ name: "p13", display: "headless" }, row("p13", { mcp: pinned })))).toBe("Started image p13.");
    expect(started({ name: "p13", display: "interactive" }).summary).toBe("Started image p13, with its window open.");
    expect(started({ name: "mine", display: "headless" }, row("mine", { mcp: { source: "script", script: "/abs/load.st", everyStart: true } })).summary).toBe(
      "Started image mine, with /abs/load.st filed in again.",
    );
    expect(started({ name: "mine", display: "interactive" }, row("mine", { mcp: { source: "script", script: "/abs/load.st", everyStart: true } })).summary).toBe(
      "Started image mine, with its window open and /abs/load.st filed in again.",
    );
    expect(started({ name: "old", display: "headless" }, row("old", { mcp: { source: "pin", version: "3.7.0" } })).warnings).toEqual([
      `Image old holds Pharo MCP 3.7.0, and images are created with ${defaultPharoMcpVersion} now, so its tools may differ from the current ones. Recreating it gives it the current MCP.`,
    ]);
  });

  it("says a stop lost what was not saved, that it saved, or that nothing ran", () => {
    expect(render(stopped({ name: "p13", killed: [4242] }))).toBe("Stopped image p13; what it had not saved is lost.");
    expect(render(stopped({ name: "p13", killed: [], saved: true }))).toBe("Saved and stopped image p13.");
    expect(render(stopped({ name: "p13", killed: [4243], saved: true }))).toBe("Saved and stopped image p13.");
    expect(render(stopped({ name: "p13", killed: [] }))).toBe("Image p13 was not running.");
  });

  it("says a delete took the files", () => {
    expect(render(deleted({ name: "old" }))).toBe("Deleted image old and its files.");
  });
});

describe("whether an image records its calls", () => {
  const enrolled = { enrolled: true };
  const madeBefore = { on: false, reason: "not-asked" } as const;

  it("is said only by a PLexus that enrolls images in OpenTelemetry", () => {
    const off = row("dev", { mcp: pinned, telemetry: madeBefore });
    expect(render(list([off]))).not.toContain("telemetry");
    expect(render(image(off))).not.toContain("record");
    expect(render(created(off))).not.toContain("record");
    expect(render(started({ name: "dev", display: "headless", telemetry: madeBefore }, off))).not.toContain("record");
  });

  it("marks a listed image that does not record, and says on or why not for one image", () => {
    const text = render(
      list([row("on", { mcp: pinned, telemetry: { on: true } }), row("off", { mcp: pinned, telemetry: madeBefore }), row("older", { mcp: pinned })], enrolled),
    );
    expect(text.split("\n").slice(1)).toEqual(["stopped:", "  on", "  off telemetry=off", "  older"]);
    expect(render(image(row("on", { telemetry: { on: true } }), enrolled))).toContain("\ntelemetry: on\npath: ");
    expect(render(image(row("dev", { mcp: pinned, telemetry: madeBefore }), enrolled))).toContain(
      "Warning: Image dev does not record its calls: it was made without MCP's Telemetry group, by a PLexus that did not enroll images in OpenTelemetry. Recreating it adds the group.",
    );
  });

  it("says that what an image records is sent nowhere when no OTEL_* setting sends it to an endpoint", () => {
    const unnamed = { enrolled: true, endpointNamed: false };
    expect(render(created(row("dev", { mcp: pinned, telemetry: { on: true } }), unnamed))).toBe(
      "Created image dev; image_start starts it.\ntelemetry: recorded, but the OTEL_* settings send it nowhere",
    );
    expect(render(started({ name: "dev", display: "headless", telemetry: { on: true } }, undefined, unnamed))).toContain(
      "\ntelemetry: recorded, but the OTEL_* settings send it nowhere",
    );
    const rows = [row("on", { mcp: pinned, telemetry: { on: true } }), row("off", { mcp: pinned, telemetry: madeBefore })];
    expect(list(rows, unnamed).warnings).toEqual([
      "The images that record their calls through OpenTelemetry have OTEL_* settings that send them nowhere.",
    ]);
    expect(list(rows, { enrolled: true, endpointNamed: true }).warnings).toEqual([]);
    expect(list([rows[1]], unnamed).warnings).toEqual([]);
  });

  it("says why a create or a start gives an image that records nothing, and what to do", () => {
    expect(render(created(row("dev", { template: nextStable, mcp: pinned, telemetry: { on: true } }), enrolled))).toBe(
      "Created image dev; image_start starts it.\ntelemetry: on",
    );
    expect(
      render(created(row("dev", { mcp: pinned, telemetry: { on: false, reason: "base-failed", detail: "Loading MCP failed: offline" } }), enrolled)),
    ).toContain(
      "Warning: Image dev does not record its calls: the base with MCP's Telemetry group failed to build (Loading MCP failed: offline), so it was copied from the base without it. A create tries that base again a day after it failed.",
    );
    const scripted = row("dev", { mcp: { source: "script", script: "/load.st" } });
    expect(render(started({ name: "dev", display: "headless", telemetry: { on: false, reason: "no-backend" } }, scripted, enrolled))).toBe(
      "Started image dev.\nWarning: Image dev does not record its calls: its MCP has no OpenTelemetry backend. Its script must load MCP's Telemetry group.",
    );
    expect(render(started({ name: "dev", display: "headless", telemetry: { on: false, reason: "switch-failed", detail: "Not configured." } }, undefined, enrolled))).toBe(
      "Started image dev.\nWarning: Image dev does not record its calls: its MCP server failed to switch to OpenTelemetry: Not configured.",
    );
    expect(render(started({ name: "dev", display: "headless", telemetry: { on: true } }, undefined, enrolled))).toBe(
      "Started image dev.\ntelemetry: on",
    );
  });
});

describe("checkArguments", () => {
  // Required first, then each value, then what the schema does not accept.
  it.each<[string, Record<string, unknown> | undefined, string | undefined]>([
    ["image_start", { image: "dev", display: "interactive" }, undefined],
    ["image_templates", undefined, undefined],
    ["image_start", { image: "  " }, "image is required."],
    ["image_create", { image: "x", template: "y", category: " \t" }, "category is blank; leave it out or give it a value."],
    ["image_start", { image: "dev", display: "window" }, 'display must be "headless" or "interactive", not "window".'],
    ["image_create", { image: "x", template: 1.5 }, "template must be string, not number."],
    ["image_start", { image: null }, "image must be string, not null."],
    ["image_start", { image: [] }, "image must be string, not array."],
    ["image_stop", { image: ["dev", "mcp"] }, undefined],
    ["image_stop", { image: null }, "image must be string or array, not null."],
    ["image_delete", { image: [] }, "image is required."],
    ["image_delete", { image: ["dev", 3] }, "image must list non-blank strings, not 3."],
    ["image_delete", { image: ["dev", " "] }, 'image must list non-blank strings, not " ".'],
    ["image_delete", { image: "dev", force: true }, "force is not accepted here; expected one of image, stop."],
    ["image_templates", { detail: 1 }, "detail is not accepted here."],
    ["image_stop", { name: "dev" }, "image is required. name is not accepted here; expected one of image, save."],
    ["image_create", { image: "x", start: "no" }, "start must be boolean, not string."],
    ["image_delete", { image: "dev", stop: true }, undefined],
    [
      "image_create",
      { extra: 1, template: 3 },
      "image is required. template must be string, not integer. extra is not accepted here; expected one of category, image, start, template.",
    ],
  ])("%s %j", (name, args, violations) => {
    expect(checkArguments(tool(name), args)).toBe(
      violations === undefined ? undefined : `Invalid arguments for ${name}. ${violations}`,
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

  it("checks against the schema it is given: a start that needs no name, a stop that takes all", () => {
    const start: Pick<Tool, "name" | "inputSchema"> = {
      name: "image_start",
      inputSchema: {
        type: "object",
        properties: { name: { type: "string" }, display: { type: "string", enum: ["headless", "interactive"] } },
        additionalProperties: false,
      },
    };
    const stop: Pick<Tool, "name" | "inputSchema"> = {
      name: "image_stop",
      inputSchema: {
        type: "object",
        properties: { name: { type: "string" }, all: { type: "boolean" } },
        additionalProperties: false,
      },
    };
    expect(checkArguments(start, {})).toBeUndefined();
    expect(checkArguments(stop, {})).toBeUndefined();
    expect(checkArguments(stop, { all: true })).toBeUndefined();
    expect(checkArguments(stop, { all: "yes" })).toBe(
      "Invalid arguments for image_stop. all must be boolean, not string.",
    );
  });
});

/** An error as callTool rejects with: its message, and its kind with what that carries. */
function forwardFailure(message: string, kind: Record<string, unknown>): Error {
  return Object.assign(new Error(message), kind);
}

describe("callFailed", () => {
  const asked: string[] = [];
  const rowIs = (found: ImageInfo | undefined) => async () => {
    asked.push("row");
    return found;
  };
  // Lists no tool, and keeps the tests that pass it off the network.
  const listsNothing = async () => {
    asked.push("tools");
    return [];
  };
  const answerOf = async (error: unknown, found: ImageInfo | undefined = runningRow("p13", { mcp: pinned })) => {
    const answer = await callFailed("p13", "image_evaluate", error, rowIs(found), listsNothing);
    return answer === undefined ? undefined : render(answer);
  };

  it("answers nothing for a cancelled call, and passes the image's own error as it is, without listing", async () => {
    asked.length = 0;
    expect(await answerOf(forwardFailure("MCP request cancelled", { kind: "cancelled" }))).toBeUndefined();
    const invalid = 'MCP error -32602: Invalid method parameter(s). {"code":"1"}';
    expect(await answerOf(forwardFailure(invalid, { kind: "answered", rpcCode: -32602 }))).toBe(invalid);
    expect(asked).toEqual([]);
  });

  it("says a tool the image does not know, and when its MCP is older than the pinned one", async () => {
    const notFound = forwardFailure("MCP error -32601: Method not found", { kind: "answered", rpcCode: -32601 });

    expect(await answerOf(notFound, runningRow("p13", { mcp: { source: "pin", version: "3.7.0" } }))).toBe(
      [
        "Image p13 answered that it has no tool image_evaluate: tool_search finds the tools it has.",
        `Warning: Image p13 holds Pharo MCP 3.7.0, and images are created with ${defaultPharoMcpVersion} now, so its tools may differ from the current ones. Recreating it gives it the current MCP.`,
      ].join("\n"),
    );
    for (const found of [runningRow("p13", { mcp: pinned }), runningRow("p13", { mcp: { source: "script", script: "/abs/x.st" } }), undefined]) {
      expect(await answerOf(notFound, found)).toBe(
        "Image p13 answered that it has no tool image_evaluate: tool_search finds the tools it has.",
      );
    }
  });

  it("names the tool the image lists that the unknown one means, when one alone fits", async () => {
    const notFound = forwardFailure("MCP error -32601: Method not found", { kind: "answered", rpcCode: -32601 });
    const listedBy380 = [
      "class_search",
      "image_evaluate",
      "method_compile",
      "method_search",
      "method_source_search",
      "test_run",
      "tool_search",
    ];
    const listedByMain = ["class_search", "evaluate", "method_compile", "test_run", "tool_search"];
    const listedAt: string[] = [];
    const refusalOf = async (tool: string, listed: readonly string[], found = runningRow("p13", { mcp: pinned })) => {
      const answer = await callFailed("p13", tool, notFound, rowIs(found), async (endpoint) => {
        listedAt.push(endpoint.url);
        return listed.map((name) => ({ name }));
      });
      return answer === undefined ? undefined : render(answer);
    };

    expect(await refusalOf("evaluate", listedBy380)).toBe(
      "Image p13 answered that it has no tool evaluate, but it lists image_evaluate: call that instead.",
    );
    expect(listedAt).toEqual(["http://127.0.0.1:7001/"]);
    expect(await refusalOf("image_evaluate", listedByMain)).toBe(
      "Image p13 answered that it has no tool image_evaluate, but it lists evaluate: call that instead.",
    );
    expect(await refusalOf("evaluate", listedBy380, runningRow("p13", { mcp: { source: "pin", version: "3.7.0" } }))).toBe(
      [
        "Image p13 answered that it has no tool evaluate, but it lists image_evaluate: call that instead.",
        `Warning: Image p13 holds Pharo MCP 3.7.0, and images are created with ${defaultPharoMcpVersion} now, so its tools may differ from the current ones. Recreating it gives it the current MCP.`,
      ].join("\n"),
    );
    // Several fit, none does, the asked name is only part of a listed word
    // (eval, valuate) or not a listed name's last words (image, source), or
    // the image lists the very name it refused: the refusal stays as it was.
    for (const [tool, listed] of [
      ["search", listedBy380],
      ["run_tests", listedBy380],
      ["eval", listedBy380],
      ["valuate", listedBy380],
      ["image", listedBy380],
      ["source", listedBy380],
      ["evaluate", ["evaluate", ...listedBy380]],
      ["evaluate", []],
    ] as const) {
      expect(await refusalOf(tool, listed), tool).toBe(
        `Image p13 answered that it has no tool ${tool}: tool_search finds the tools it has.`,
      );
    }
  });

  it("names no tool when the image cannot be listed", async () => {
    const notFound = forwardFailure("MCP error -32601: Method not found", { kind: "answered", rpcCode: -32601 });
    const listing = async () => {
      asked.push("tools");
      return [{ name: "image_evaluate" }];
    };
    const refusal = "Image p13 answered that it has no tool evaluate: tool_search finds the tools it has.";

    // Stopped since, or not known: there is no endpoint to ask.
    for (const found of [row("p13"), undefined]) {
      asked.length = 0;
      const answer = await callFailed("p13", "evaluate", notFound, rowIs(found), listing);
      expect(answer === undefined ? undefined : render(answer)).toBe(refusal);
      expect(asked).toEqual(["row"]);
    }
    const failed = await callFailed("p13", "evaluate", notFound, rowIs(runningRow("p13", { mcp: pinned })), async () => {
      throw new Error("MCP request timed out after 5000ms");
    });
    expect(failed === undefined ? undefined : render(failed)).toBe(refusal);
  });

  it("asks the image for its tools when given no way to list them", async () => {
    const notFound = forwardFailure("MCP error -32601: Method not found", { kind: "answered", rpcCode: -32601 });
    const image = http.createServer((request, response) => {
      let body = "";
      request.on("data", (chunk: Buffer) => {
        body += chunk.toString("utf8");
      });
      request.on("end", () => {
        const message = JSON.parse(body) as { id?: string; method: string };
        if (message.id === undefined) {
          response.writeHead(202).end();
          return;
        }
        const result =
          message.method === "tools/list"
            ? { tools: [{ name: "image_evaluate", inputSchema: { type: "object" } }] }
            : { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "MCP" } };
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
      });
    });
    await new Promise<void>((resolve) => image.listen(0, "127.0.0.1", resolve));
    try {
      const url = `http://127.0.0.1:${(image.address() as AddressInfo).port}/`;
      const found = runningRow("p13", { mcp: pinned, endpoint: { url, pid: 4242 } });
      const answer = await callFailed("p13", "evaluate", notFound, rowIs(found));
      expect(answer === undefined ? undefined : render(answer)).toBe(
        "Image p13 answered that it has no tool evaluate, but it lists image_evaluate: call that instead.",
      );
    } finally {
      image.closeAllConnections();
      await new Promise((resolve) => image.close(resolve));
    }
  });

  it("says an image that stopped before answering starts as it was last saved, whatever broke", async () => {
    for (const kind of [
      { kind: "closed" },
      { kind: "timeout", waitedMs: 120_000 },
      { kind: "no-handshake", waitedMs: 60_000 },
      { kind: "refused" },
      { kind: "other" },
    ]) {
      expect(await answerOf(forwardFailure("socket hang up", kind), row("p13")), kind.kind).toBe(
        "Image p13 stopped before answering image_evaluate. Start it with image_start; it starts as it was last saved.",
      );
    }
  });

  it("says what became of the call to an image that still runs", async () => {
    expect(
      await answerOf(forwardFailure("MCP initialize timed out after 60000ms", { kind: "no-handshake", waitedMs: 60_000 })),
    ).toBe(
      "Image p13 did not answer within 60 s, so image_evaluate was not sent. It still runs, and may be busy with an earlier call: image_stop kills it without saving, and image_start then starts it as it was last saved.",
    );
    expect(
      await answerOf(forwardFailure("MCP request timed out after 120000ms", { kind: "timeout", waitedMs: 120_000 })),
    ).toBe(
      "Image p13 did not answer image_evaluate within 120 s, and still runs: it may still be working on the call. image_stop kills it without saving, and image_start then starts it as it was last saved.",
    );
    expect(await answerOf(forwardFailure("connect ECONNREFUSED 127.0.0.1:7001", { kind: "refused" }))).toBe(
      "Image p13 runs, but refused the connection for image_evaluate, so the call was not made.",
    );
    expect(await answerOf(forwardFailure("socket hang up", { kind: "closed" }))).toBe(
      "Image p13 closed the connection before answering image_evaluate, and still runs: check whether the call took effect before making it again.",
    );
    expect(await answerOf(forwardFailure("HTTP 500 Internal Server Error", { kind: "other" }))).toBe(
      "Image p13 did not answer image_evaluate: HTTP 500 Internal Server Error. It still runs.",
    );
    expect(await answerOf(new Error("MCP response was not a JSON object."))).toBe(
      "Image p13 did not answer image_evaluate: MCP response was not a JSON object. It still runs.",
    );
  });

  it("says only what broke when the image cannot be listed", async () => {
    const unlisted = async () => {
      throw new Error("ps failed");
    };
    const answer = await callFailed("p13", "image_evaluate", forwardFailure("socket hang up", { kind: "closed" }), unlisted);
    expect(answer === undefined ? undefined : render(answer)).toBe(
      "Image p13 did not answer image_evaluate: socket hang up.",
    );
  });
});
