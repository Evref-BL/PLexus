import { describe, expect, it } from "vitest";
import { runCli, type CliDependencies } from "../src/commandLine.js";
import { PlexusError } from "../src/errors.js";
import type { ImagesApi } from "../src/mcp/server.js";
import type { ImagesOptions } from "../src/types.js";

function harness(env: NodeJS.ProcessEnv = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const opened: ImagesOptions[] = [];
  const calls: unknown[][] = [];
  const served: ImagesApi[] = [];
  const images: ImagesApi = {
    templates: async () => {
      calls.push(["templates"]);
      return [];
    },
    list: async (name?: string) => {
      calls.push(["list", name]);
      if (name === "gone") {
        throw new PlexusError("no-such-image", "There is no image gone.");
      }
      return [];
    },
    create: async (name, options) => {
      calls.push(["create", name, options]);
      return { name, diskName: name, path: "/x", running: false, pids: [], fromBase: true, seconds: 1 };
    },
    start: async (name, options) => {
      calls.push(["start", name, options]);
      return { name, pids: [1], endpoint: { url: "http://127.0.0.1:1/" }, display: "headless", seconds: 1 };
    },
    stop: async (name) => {
      calls.push(["stop", name]);
      return { name, killed: [] };
    },
    delete: async (name) => {
      calls.push(["delete", name]);
      throw new PlexusError("image-running", "Image dev is running as pid 7. Stop it before deleting it.", { pids: [7] });
    },
  };
  const dependencies: CliDependencies = {
    images: (options) => {
      opened.push(options);
      return images;
    },
    serveMcp: async (served_) => {
      served.push(served_);
    },
  };
  const run = (...argv: string[]) =>
    runCli(argv, { stdout: (text) => out.push(text), stderr: (text) => err.push(text), env }, dependencies);
  return {
    run,
    calls,
    opened,
    served,
    stdout: () => out.join(""),
    printed: () => [...out],
    stderr: () => err.join(""),
  };
}

describe("plexus", () => {
  it("runs each image verb with what its options say", async () => {
    const cli = harness();
    expect(await cli.run("image", "list")).toBe(0);
    expect(await cli.run("image", "list", "dev")).toBe(0);
    expect(await cli.run("image", "templates")).toBe(0);
    expect(
      await cli.run("image", "create", "mcp", "--template", "Pharo 14.0", "--category=Official", "--script", "load.st", "--every-start"),
    ).toBe(0);
    expect(await cli.run("image", "start", "dev", "--display", "interactive", "--timeout", "90")).toBe(0);
    expect(await cli.run("image", "start", "dev")).toBe(0);
    expect(await cli.run("image", "stop", "dev")).toBe(0);

    expect(cli.calls).toEqual([
      ["list", undefined],
      ["list", "dev"],
      ["templates"],
      ["create", "mcp", { template: "Pharo 14.0", category: "Official", script: "load.st", everyStart: true }],
      ["start", "dev", { display: "interactive", timeoutMs: 90_000 }],
      ["start", "dev", {}],
      ["stop", "dev"],
    ]);
    expect(cli.printed().slice(0, 3).map((text) => JSON.parse(text))).toEqual([[], [], []]);
  });

  it("takes the home and the scope from options, else from the environment", async () => {
    const cli = harness({ PLEXUS_HOME: "/env/home", PLEXUS_SCOPE: "EnvScope" });
    await cli.run("image", "list");
    await cli.run("image", "list", "--home", "/flag/home", "--scope=FlagScope");
    expect(cli.opened).toEqual([
      { home: "/env/home", scope: "EnvScope" },
      { home: "/flag/home", scope: "FlagScope" },
    ]);
  });

  it("prints a refusal as JSON on stdout and exits 1", async () => {
    const cli = harness();
    expect(await cli.run("image", "delete", "dev")).toBe(1);
    expect(JSON.parse(cli.stdout())).toEqual({
      ok: false,
      code: "image-running",
      error: "Image dev is running as pid 7. Stop it before deleting it.",
      details: { pids: [7] },
    });

    const again = harness();
    expect(await again.run("image", "list", "gone")).toBe(1);
    expect(JSON.parse(again.stdout())).toEqual({ ok: false, code: "no-such-image", error: "There is no image gone." });
  });

  it("refuses a command line it cannot read, with the command's usage, and exits 2", async () => {
    const cases: Array<[string[], string]> = [
      [["image", "start"], "Missing the image name"],
      [["image", "start", "a", "b"], "Unexpected argument b"],
      [["image", "list", "--project-path", "."], "Unknown option --project-path"],
      [["image", "stop", "dev", "--template", "T"], "Unknown option --template"],
      [["image", "create", "dev"], "create needs --template"],
      [["image", "create", "dev", "--template"], "--template needs a value"],
      [["image", "create", "dev", "--template", "T", "--every-start=yes"], "--every-start takes no value"],
      [["image", "start", "dev", "--display", "fullscreen"], "--display is headless or interactive"],
      [["image", "start", "dev", "--timeout", "soon"], "--timeout is a number of seconds"],
      [["image", "add", "dev"], "Unknown image command add"],
      [["project", "open"], "Unknown command project"],
      [["mcp", "pharo-launcher"], "Unexpected argument pharo-launcher"],
    ];
    for (const [argv, message] of cases) {
      const cli = harness();
      expect(await cli.run(...argv), argv.join(" ")).toBe(2);
      expect(cli.stderr(), argv.join(" ")).toContain(`plexus: ${message}`);
      expect(cli.stdout()).toBe("");
      expect(cli.calls).toEqual([]);
    }
  });

  it("explains itself and each command", async () => {
    const cli = harness();
    expect(await cli.run("--help")).toBe(0);
    expect(cli.stdout()).toContain("plexus image create <name> --template <t>");
    expect(cli.stdout()).toContain("plexus mcp");

    const start = harness();
    expect(await start.run("image", "start", "--help")).toBe(0);
    expect(start.stdout()).toMatch(/^Usage: plexus image start <name> \[--display interactive\] \[--timeout <seconds>\] \[--home <dir>\] \[--scope <prefix>\]/);

    const bare = harness();
    expect(await bare.run()).toBe(2);
    expect(bare.stderr()).toContain("Usage:");
  });

  it("serves MCP in the scope given at launch", async () => {
    const cli = harness({ PLEXUS_SCOPE: "Pharo4Agents" });
    expect(await cli.run("mcp")).toBe(0);
    expect(cli.opened).toEqual([{ scope: "Pharo4Agents" }]);
    expect(cli.served).toHaveLength(1);
  });
});
