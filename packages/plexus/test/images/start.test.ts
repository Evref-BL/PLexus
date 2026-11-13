import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { startScript } from "../../src/images/scripts.js";
import { start } from "../../src/images/start.js";
import type { Endpoint } from "../../src/types.js";
import {
  failed,
  FakeLauncher,
  launched,
  tempHome,
  testContext,
  writeEndpoint,
  writeLauncherImage,
} from "../support/fakeLauncher.js";

function setup(overrides: Parameters<typeof testContext>[2] = {}) {
  const home = tempHome();
  const launcher = new FakeLauncher(home);
  writeLauncherImage(launcher.imageDir("Scope-dev"), "Scope-dev");
  const dir = launcher.imageDir("Scope-dev");
  const context = testContext(home, launcher, { scope: "Scope", ...overrides });
  return {
    home,
    launcher,
    dir,
    plexus: path.join(dir, "plexus"),
    imagePath: path.join(dir, "Scope-dev.image"),
    context,
  };
}

describe("start", () => {
  it("launches the image with the start script and answers once its server does", async () => {
    const pinged: Endpoint[] = [];
    const { launcher, plexus, context } = setup({
      ping: async (endpoint) => {
        pinged.push(endpoint);
        return true;
      },
    });
    fs.mkdirSync(plexus, { recursive: true });
    fs.writeFileSync(path.join(plexus, "start-status.properties"), "status=failed\rmessage=last time\r");
    fs.writeFileSync(path.join(plexus, "endpoint.properties"), "port=1\r");

    const started = await start(context, "dev");

    const [vm] = launcher.processes;
    expect(started).toEqual({
      name: "dev",
      pids: [vm.pid],
      endpoint: { url: "http://127.0.0.1:7001/", pid: vm.pid },
      display: "headless",
      seconds: 0,
    });
    expect(pinged).toEqual([started.endpoint]);
    expect(launcher.called("startImage")).toEqual([
      {
        imageName: "Scope-dev",
        detached: true,
        displayMode: "headless",
        script: path.join(plexus, "start.st"),
        includeRaw: true,
      },
    ]);
    expect(fs.readFileSync(path.join(plexus, "start.st"), "utf8")).toBe(startScript);
    expect(fs.existsSync(path.join(plexus, "launch.lock"))).toBe(false);
    expect(fs.existsSync(path.join(plexus, "start-status.properties"))).toBe(false);
  });

  it("starts it interactively when asked", async () => {
    const { launcher, context } = setup();
    expect((await start(context, "dev", { display: "interactive" })).display).toBe("interactive");
    expect(launcher.called("startImage")[0]).toMatchObject({ displayMode: "interactive" });
  });

  it("waits while the server does not answer yet", async () => {
    let answers = 0;
    const { context } = setup({ ping: async () => ++answers >= 3 });
    const started = await start(context, "dev");
    expect(answers).toBe(3);
    expect(started.seconds).toBe(0.5);
  });

  it("fails as soon as the image reports a failure, and kills its VM", async () => {
    const { home, launcher, plexus, imagePath, context } = setup();
    launcher.launchAnswer = () => {
      const vm = launcher.run(imagePath);
      fs.writeFileSync(
        path.join(plexus, "start-status.properties"),
        "status=failed\rmessage=Error: MCP is not in the image.\r",
      );
      return launched(vm.pid, home);
    };

    await expect(start(context, "dev")).rejects.toMatchObject({
      code: "start-failed",
      message: expect.stringContaining("Image dev failed to start: Error: MCP is not in the image."),
    });
    expect(launcher.called("killProcess")).toHaveLength(1);
    expect(launcher.processes).toEqual([]);
  });

  it("fails when the VM exits, naming its logs and how to renew a VM that cannot run", async () => {
    const { home, launcher, imagePath, context } = setup({
      ping: async () => {
        launcher.processes = [];
        return false;
      },
    });
    const logs = path.join(home, "profiles", "logs");
    fs.mkdirSync(logs, { recursive: true });
    fs.writeFileSync(path.join(logs, "launch.err.log"), "allocateHeap: Could not allocate codeZone\nVM Error Fri Nov 13\n");
    launcher.launchAnswer = () => {
      const vm = launcher.run(imagePath);
      writeEndpoint(path.dirname(imagePath), { port: 7001, pid: vm.pid });
      return launched(vm.pid, home);
    };

    const error = (await start(context, "dev").catch((caught: unknown) => caught)) as Error;
    expect(error).toMatchObject({ code: "start-failed" });
    expect(error.message).toContain("Image dev exited during start.");
    expect(error.message).toContain(`Launcher logs: ${path.join(logs, "launch.out.log")}, ${path.join(logs, "launch.err.log")}`);
    expect(error.message).toContain("Remove /vms/140-x64 and start again");
  });

  it("fails when no VM appears at all, and kills the one the launcher said it started", async () => {
    const { home, launcher, context } = setup();
    // A pid that runs, as the VM's would while the process list shows it on
    // no image; the fake launcher only records the kill.
    launcher.launchAnswer = () => launched(process.pid, home);

    await expect(start(context, "dev")).rejects.toMatchObject({
      code: "start-failed",
      message: expect.stringContaining("Image dev exited during start."),
    });
    expect(context.clock.now - Date.parse("2026-11-13T12:00:00Z")).toBe(30_000);
    expect(launcher.called("killProcess")).toEqual([{ pid: process.pid }]);
  });

  it("kills nothing when the VM the launcher started is gone", async () => {
    const { home, launcher, context } = setup();
    launcher.launchAnswer = () => launched(2_147_483_646, home);

    await expect(start(context, "dev")).rejects.toMatchObject({ code: "start-failed" });
    expect(launcher.called("killProcess")).toEqual([]);
  });

  it("says why a VM it gave up on could not be killed", async () => {
    const { launcher, context } = setup({ ping: async () => false });
    launcher.nextPid = process.pid;
    launcher.killProcess = async (input) => {
      launcher.calls.push({ method: "killProcess", input });
      return failed("kill EPERM");
    };

    const error = (await start(context, "dev", { timeoutMs: 60_000 }).catch((caught: unknown) => caught)) as Error;
    expect(error).toMatchObject({ code: "start-failed" });
    expect(error.message).toContain("Image dev did not answer within 60 s.");
    expect(error.message).toContain(`Killing pid ${process.pid} failed: Pharo Launcher killProcess failed: kill EPERM`);
    expect(launcher.called("killProcess")).toEqual([{ pid: process.pid }]);
  });

  it("gives up after the timeout and kills the VM", async () => {
    const { launcher, context } = setup({ ping: async () => false });

    await expect(start(context, "dev", { timeoutMs: 60_000 })).rejects.toMatchObject({
      code: "start-failed",
      message: expect.stringContaining("Image dev did not answer within 60 s."),
    });
    expect(launcher.processes).toEqual([]);
  });

  it("says what the launcher said when it could not launch", async () => {
    const { launcher, context } = setup();
    launcher.launchAnswer = () => failed("Profile-scoped image launch could not find image file.");

    await expect(start(context, "dev")).rejects.toMatchObject({
      code: "start-failed",
      message: "Pharo Launcher startImage failed: Profile-scoped image launch could not find image file.",
    });
  });

  it("refuses an image a VM already runs, naming it", async () => {
    const { launcher, dir, imagePath, context } = setup();
    const vm = launcher.run(imagePath);
    writeEndpoint(dir, { port: 7001, pid: vm.pid });

    await expect(start(context, "dev")).rejects.toMatchObject({
      code: "image-running",
      message: expect.stringContaining(`already running as pid ${vm.pid}`),
      details: { pids: [vm.pid], endpoint: { url: "http://127.0.0.1:7001/", pid: vm.pid } },
    });
    expect(launcher.called("startImage")).toEqual([]);
  });

  it("refuses while another start holds the launch lock", async () => {
    const { launcher, plexus, context } = setup();
    fs.mkdirSync(plexus, { recursive: true });
    fs.writeFileSync(
      path.join(plexus, "launch.lock"),
      JSON.stringify({ pid: process.pid, at: new Date(context.now()).toISOString() }),
    );

    await expect(start(context, "dev")).rejects.toMatchObject({
      code: "being-started",
      details: { pid: process.pid },
    });
    expect(launcher.called("startImage")).toEqual([]);
    expect(fs.existsSync(path.join(plexus, "launch.lock"))).toBe(true);
  });

  it("takes over a lock whose holder died or has run out of time", async () => {
    for (const lock of [
      { pid: 2_147_483_646, at: "2026-11-13T12:00:00Z" },
      { pid: process.pid, at: "2026-11-13T11:00:00Z" },
      "never written",
    ]) {
      const { plexus, context } = setup();
      fs.mkdirSync(plexus, { recursive: true });
      const file = path.join(plexus, "launch.lock");
      fs.writeFileSync(file, typeof lock === "string" ? lock : JSON.stringify(lock));
      const minuteAgo = new Date(context.now() - 60_000);
      fs.utimesSync(file, minuteAgo, minuteAgo);

      await expect(start(context, "dev")).resolves.toMatchObject({ name: "dev" });
      expect(fs.readdirSync(plexus).filter((entry) => entry.startsWith("launch.lock"))).toEqual([]);
    }
  });

  it("takes a lock it cannot read yet for one its creator is still writing", async () => {
    const { launcher, plexus, context } = setup();
    fs.mkdirSync(plexus, { recursive: true });
    fs.writeFileSync(path.join(plexus, "launch.lock"), "");
    const now = new Date(context.now());
    fs.utimesSync(path.join(plexus, "launch.lock"), now, now);

    await expect(start(context, "dev")).rejects.toMatchObject({ code: "being-started" });
    expect(launcher.called("startImage")).toEqual([]);
  });

  it("looks for a VM on the image only once it holds the launch lock", async () => {
    const { launcher, plexus, context } = setup();
    const locked: boolean[] = [];
    const listProcesses = launcher.listProcesses.bind(launcher);
    launcher.listProcesses = async () => {
      locked.push(fs.existsSync(path.join(plexus, "launch.lock")));
      return listProcesses();
    };

    await start(context, "dev");
    expect(locked[0]).toBe(true);
  });

  it("refuses an image that is not there, or still being created", async () => {
    const { plexus, context } = setup();
    await expect(start(context, "other")).rejects.toMatchObject({ code: "no-such-image" });

    fs.mkdirSync(plexus, { recursive: true });
    fs.writeFileSync(path.join(plexus, "building"), "");
    await expect(start(context, "dev")).rejects.toMatchObject({ code: "building" });
  });
});
