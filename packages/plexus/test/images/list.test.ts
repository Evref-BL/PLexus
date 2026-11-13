import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PlexusError } from "../../src/errors.js";
import { list } from "../../src/images/list.js";
import {
  FakeLauncher,
  tempHome,
  testContext,
  writeEndpoint,
  writeLauncherImage,
} from "../support/fakeLauncher.js";

function store(names: string[]): { home: string; launcher: FakeLauncher } {
  const home = tempHome();
  const launcher = new FakeLauncher(home);
  for (const name of names) {
    writeLauncherImage(launcher.imageDir(name), name);
  }
  return { home, launcher };
}

function imagePath(launcher: FakeLauncher, disk: string): string {
  return path.join(launcher.imageDir(disk), `${disk}.image`);
}

describe("list", () => {
  it("lists the image directories in scope, without the scope", async () => {
    const { home, launcher } = store(["Scope-dev", "Scope-mcp-eval", "Other-dev", "plexus-build-1a2b3c4d"]);
    fs.mkdirSync(launcher.imageDir("Scope-incomplete"), { recursive: true });

    const scoped = await list(testContext(home, launcher, { scope: "Scope" }));
    expect(scoped.map((image) => [image.name, image.diskName])).toEqual([
      ["dev", "Scope-dev"],
      ["mcp-eval", "Scope-mcp-eval"],
    ]);
    expect(scoped[0]).toMatchObject({
      path: imagePath(launcher, "Scope-dev"),
      running: false,
      pids: [],
      template: "Pharo 14.0 - 64bit",
      pharoVersion: "140",
    });
    expect(scoped[0].endpointProblem).toBeUndefined();

    const everything = await list(testContext(home, launcher));
    expect(everything.map((image) => image.name)).toEqual(["Other-dev", "Scope-dev", "Scope-mcp-eval"]);
  });

  it("asks the host once, and not at all for an empty store", async () => {
    const { home, launcher } = store(["a", "b", "c"]);
    await list(testContext(home, launcher));
    expect(launcher.called("listProcesses")).toHaveLength(1);

    const empty = new FakeLauncher(tempHome());
    expect(await list(testContext(empty.home, empty))).toEqual([]);
    expect(empty.called("listProcesses")).toHaveLength(0);
  });

  it("answers the image named, or refuses one that is not there", async () => {
    const { home, launcher } = store(["Scope-dev"]);
    const context = testContext(home, launcher, { scope: "Scope" });

    expect((await list(context, "dev")).map((image) => image.name)).toEqual(["dev"]);
    await expect(list(context, "missing")).rejects.toMatchObject({ code: "no-such-image" });
    await expect(list(context, "bad name")).rejects.toMatchObject({ code: "invalid-name" });
  });

  it("says what it was made from and what it files in at every start", async () => {
    const { home, launcher } = store(["pinned", "scripted"]);
    const plexus = (name: string) => path.join(launcher.imageDir(name), "plexus");
    fs.mkdirSync(plexus("pinned"), { recursive: true });
    fs.writeFileSync(path.join(plexus("pinned"), "created.properties"), "template=T\ncategory=C\nmcp=pin:3.6.0\n");
    fs.mkdirSync(plexus("scripted"), { recursive: true });
    fs.writeFileSync(path.join(plexus("scripted"), "created.properties"), "mcp=script:/work/load=mcp.st\n");
    fs.writeFileSync(path.join(plexus("scripted"), "on-start"), "\n/work/load=mcp.st\n");
    fs.writeFileSync(path.join(plexus("scripted"), "building"), "");

    const [pinned, scripted] = await list(testContext(home, launcher));
    expect(pinned).toMatchObject({ mcp: { source: "pin", version: "3.6.0" } });
    expect(pinned.everyStart).toBeUndefined();
    expect(pinned.building).toBeUndefined();
    expect(scripted).toMatchObject({
      mcp: { source: "script", script: "/work/load=mcp.st" },
      everyStart: "/work/load=mcp.st",
      building: true,
    });
  });

  it("matches a VM on the image file's real path, never on its name", async () => {
    const { home, launcher } = store(["mcp-eval", "plugin-mcp-eval"]);
    const vm = launcher.run(imagePath(launcher, "plugin-mcp-eval"));

    const rows = await list(testContext(home, launcher));
    expect(rows.find((row) => row.name === "plugin-mcp-eval")).toMatchObject({ running: true, pids: [vm.pid] });
    expect(rows.find((row) => row.name === "mcp-eval")).toMatchObject({ running: false, pids: [] });
  });

  it("follows links to the image file, and reads the command line when the path is not given", async () => {
    const { home, launcher } = store(["dev"]);
    const linked = path.join(tempHome(), "linked-home");
    fs.symlinkSync(home, linked, process.platform === "win32" ? "junction" : "dir");
    launcher.processes.push(
      { pid: 11, commandLine: "11 Pharo --headless", imagePath: path.join(linked, "profiles", "images", "dev", "dev.image") },
      { pid: 12, commandLine: `12 Pharo ${imagePath(launcher, "dev")} eval x.st` },
      { pid: 13, commandLine: "13 Pharo dev.image", imagePath: "dev.image" },
    );

    const [row] = await list(testContext(home, launcher));
    expect(row.pids).toEqual([11, 12]);
    expect(row.display).toBe("headless");
  });

  it("says a VM without --headless runs it interactively", async () => {
    const { home, launcher } = store(["dev"]);
    launcher.run(imagePath(launcher, "dev"), { headless: false });
    expect((await list(testContext(home, launcher)))[0].display).toBe("interactive");
  });

  describe("an endpoint", () => {
    async function observe(setup: (launcher: FakeLauncher, dir: string) => void) {
      const { home, launcher } = store(["dev"]);
      setup(launcher, launcher.imageDir("dev"));
      return (await list(testContext(home, launcher)))[0];
    }

    it("is the running image's when the pid it names runs the image", async () => {
      const row = await observe((launcher, dir) => {
        const vm = launcher.run(imagePath(launcher, "dev"));
        writeEndpoint(dir, { port: 7001, pid: vm.pid });
      });
      expect(row.endpoint).toEqual({ url: "http://127.0.0.1:7001/", pid: row.pids[0] });
      expect(row.endpointProblem).toBeUndefined();
    });

    it("is refused when the pid it names runs something else", async () => {
      const row = await observe((launcher, dir) => {
        launcher.run(imagePath(launcher, "dev"));
        writeEndpoint(dir, { port: 7001, pid: 999 });
      });
      expect(row.endpoint).toBeUndefined();
      expect(row.endpointProblem).toBe("the endpoint names pid 999, which does not run this image");
    });

    it("without a pid, belongs to a VM this PLexus launched with the start script", async () => {
      const launchedHere = await observe((launcher, dir) => {
        launcher.run(imagePath(launcher, "dev"), { script: path.join(dir, "plexus", "start.st") });
        writeEndpoint(dir, { port: 7002 });
      });
      expect(launchedHere.endpoint).toEqual({ url: "http://127.0.0.1:7002/" });

      const launchedElsewhere = await observe((launcher, dir) => {
        launcher.run(imagePath(launcher, "dev"), { script: "/old/.plexus/scripts/start-dev.st" });
        writeEndpoint(dir, { port: 7002 });
      });
      expect(launchedElsewhere.endpoint).toBeUndefined();
      expect(launchedElsewhere.endpointProblem).toBe("not started by this PLexus");
    });

    it("is missing until the VM writes it, and refused when malformed", async () => {
      const notYet = await observe((launcher, dir) => {
        launcher.run(imagePath(launcher, "dev"), { script: path.join(dir, "plexus", "start.st") });
      });
      expect(notYet.endpointProblem).toBe("no endpoint written yet");

      // A VM another tool or an older PLexus started will never write one.
      const never = await observe((launcher) => {
        launcher.run(imagePath(launcher, "dev"), { script: "/old/.plexus/scripts/start-dev.st" });
      });
      expect(never.endpointProblem).toBe("not started by this PLexus");

      const malformed = await observe((launcher, dir) => {
        const vm = launcher.run(imagePath(launcher, "dev"));
        fs.mkdirSync(path.join(dir, "plexus"), { recursive: true });
        fs.writeFileSync(path.join(dir, "plexus", "endpoint.properties"), `transport=http\nhost=127.0.0.1\nport=08080\npath=/\npid=${vm.pid}\n`);
      });
      expect(malformed.endpointProblem).toMatch(/^the endpoint file is invalid: MCP endpoint port/);
    });

    it("is not looked at while nothing runs the image", async () => {
      const row = await observe((_launcher, dir) => writeEndpoint(dir, { port: 7001, pid: 1 }));
      expect(row.endpoint).toBeUndefined();
      expect(row.endpointProblem).toBeUndefined();
    });
  });

  it("refuses when the host cannot be asked", async () => {
    const { home, launcher } = store(["dev"]);
    launcher.listProcesses = async () => ({
      ok: false,
      diagnostic: "ps failed",
      parser: { status: "skipped", format: "text" },
      command: { args: [], durationMs: 0, exitCode: 1, timedOut: false },
    });
    const error = await list(testContext(home, launcher)).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PlexusError);
    expect(error).toMatchObject({ code: "launcher-failed", message: "Pharo Launcher listProcesses failed: ps failed" });
  });
});
