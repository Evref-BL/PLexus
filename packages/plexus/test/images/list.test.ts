import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PlexusError } from "../../src/errors.js";
import { answeringFromEndpoints, list } from "../../src/images/list.js";
import {
  FakeLauncher,
  imagesWith,
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
  it("says whether each image records its calls: running, as its start said, else as its create did", async () => {
    const { home, launcher } = store(["running", "stopped", "older"]);
    const plexus = (name: string) => path.join(launcher.imageDir(name), "plexus");
    for (const name of ["running", "stopped"]) {
      fs.mkdirSync(plexus(name), { recursive: true });
      fs.writeFileSync(
        path.join(plexus(name), "created.properties"),
        "mcp=pin:4.2.1\ntelemetry=off\ntelemetry.reason=base-failed\ntelemetry.detail=offline\n",
      );
    }
    const vm = launcher.run(imagePath(launcher, "running"), { script: path.join(plexus("running"), "start.st") });
    writeEndpoint(launcher.imageDir("running"), { port: 7001, pid: vm.pid, more: ["telemetry=on"] });

    const [older, running, stopped] = await list(testContext(home, launcher));
    expect(running.telemetry).toEqual({ on: true });
    expect(stopped.telemetry).toEqual({ on: false, reason: "base-failed", detail: "offline" });
    expect(older).not.toHaveProperty("telemetry");
  });

  it("lists the image directories in scope, without the scope", async () => {
    const { home, launcher } = store(["Scope-dev", "Scope-mcp-eval", "Other-dev", "plexus-build-1a2b3c4d"]);
    fs.mkdirSync(launcher.imageDir("Scope-incomplete"), { recursive: true });

    const scoped = await list(testContext(home, launcher, { scope: "Scope" }));
    expect(scoped.map((image) => [image.name, image.path])).toEqual([
      ["dev", imagePath(launcher, "Scope-dev")],
      ["mcp-eval", imagePath(launcher, "Scope-mcp-eval")],
    ]);
    expect(scoped[0]).toMatchObject({
      state: "stopped",
      running: false,
      pids: [],
      template: "Pharo 14.0 - 64bit",
      pharoVersion: "14.0",
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
    expect(pinned).toMatchObject({ state: "stopped", mcp: { source: "pin", version: "3.6.0" } });
    expect(scripted).toMatchObject({
      state: "creating",
      mcp: { source: "script", script: "/work/load=mcp.st", everyStart: true },
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
      expect(row.state).toBe("running");
      expect(row.endpointProblem).toBeUndefined();
    });

    it("is refused when the pid it names runs something else", async () => {
      const row = await observe((launcher, dir) => {
        launcher.run(imagePath(launcher, "dev"));
        writeEndpoint(dir, { port: 7001, pid: 999 });
      });
      expect(row.endpoint).toBeUndefined();
      expect(row.state).toBe("unreachable");
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
      expect(notYet.state).toBe("starting");
      expect(notYet.endpointProblem).toBeUndefined();

      // A VM another tool or an older PLexus started will never write one.
      const never = await observe((launcher) => {
        launcher.run(imagePath(launcher, "dev"), { script: "/old/.plexus/scripts/start-dev.st" });
      });
      expect(never.state).toBe("unreachable");
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
      expect(row.state).toBe("stopped");
      expect(row.endpoint).toBeUndefined();
      expect(row.endpointProblem).toBeUndefined();
    });
  });

  describe("where a forwarded call goes, from the endpoint files alone", () => {
    /** A store whose image dev runs as a live process: this test's own. */
    function answeringDev(names = ["dev"]) {
      const { home, launcher } = store(names);
      launcher.nextPid = process.pid;
      launcher.run(imagePath(launcher, "dev"), { script: path.join(launcher.imageDir("dev"), "plexus", "start.st") });
      writeEndpoint(launcher.imageDir("dev"), { port: 7001, pid: process.pid });
      return { home, launcher, context: testContext(home, launcher) };
    }
    const dev = { name: "dev", endpoint: { url: "http://127.0.0.1:7001/", pid: process.pid } };

    it("is the image whose VM an earlier look saw, while it runs, without asking the host", () => {
      const { launcher, context } = answeringDev(["dev", "idle"]);
      const seen = new Map([["dev", process.pid]]);

      expect(answeringFromEndpoints(context, seen, "dev")).toEqual(dev);
      expect(answeringFromEndpoints(context, seen)).toEqual(dev);
      expect(launcher.called("listProcesses")).toHaveLength(0);
    });

    it("is left to a full look for a VM no look saw, a VM gone, another image answering, or an image being made", () => {
      const { launcher, context } = answeringDev(["dev", "other"]);
      expect(answeringFromEndpoints(context, new Map(), "dev")).toBeUndefined();

      const seen = new Map([["dev", process.pid]]);
      writeEndpoint(launcher.imageDir("other"), { port: 7002, pid: process.ppid });
      expect(answeringFromEndpoints(context, seen)).toBeUndefined();
      expect(answeringFromEndpoints(context, seen, "dev")).toEqual(dev);

      fs.writeFileSync(path.join(launcher.imageDir("dev"), "plexus", "building"), "");
      expect(answeringFromEndpoints(context, seen, "dev")).toBeUndefined();
      fs.rmSync(path.join(launcher.imageDir("dev"), "plexus", "building"));

      const gone = spawnSync(process.execPath, ["-e", ""]).pid;
      writeEndpoint(launcher.imageDir("dev"), { port: 7001, pid: gone });
      seen.set("dev", gone);
      expect(answeringFromEndpoints(context, seen, "dev")).toBeUndefined();
      expect(answeringFromEndpoints(context, seen, "missing")).toBeUndefined();
    });

    it("trusts only a VM a look of the same Images saw answering", async () => {
      const { home, launcher } = answeringDev();
      const images = imagesWith({ home, launcher });
      expect(images.answering("dev")).toBeUndefined();

      await images.list();
      expect(images.answering("dev")).toEqual(dev);
      expect(images.answering()).toEqual(dev);

      launcher.processes = [];
      await images.list("dev");
      expect(images.answering("dev")).toBeUndefined();
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
