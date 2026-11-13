import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { storeRoot, tmpRoot } from "../../src/home.js";
import { deleteImage } from "../../src/images/delete.js";
import { stop } from "../../src/images/stop.js";
import {
  failed,
  FakeLauncher,
  tempHome,
  testContext,
  writeEndpoint,
  writeLauncherImage,
} from "../support/fakeLauncher.js";

function setup() {
  const home = tempHome();
  const launcher = new FakeLauncher(home);
  const dir = launcher.imageDir("dev");
  writeLauncherImage(dir, "dev");
  return { home, launcher, dir, imagePath: path.join(dir, "dev.image"), context: testContext(home, launcher) };
}

describe("stop", () => {
  it("is done when nothing runs the image", async () => {
    const { launcher, context } = setup();
    expect(await stop(context, "dev")).toEqual({ name: "dev", killed: [] });
    expect(launcher.called("killProcess")).toEqual([]);
  });

  it("kills every VM on the image file, and only those", async () => {
    const { launcher, dir, imagePath, context } = setup();
    const first = launcher.run(imagePath);
    const second = launcher.run(imagePath, { headless: false });
    writeLauncherImage(launcher.imageDir("plugin-dev"), "plugin-dev");
    const bystander = launcher.run(path.join(launcher.imageDir("plugin-dev"), "plugin-dev.image"));
    writeEndpoint(dir, { port: 7001, pid: first.pid });

    expect(await stop(context, "dev")).toEqual({ name: "dev", killed: [first.pid, second.pid] });
    expect(launcher.called("killProcess")).toEqual([{ pid: first.pid }, { pid: second.pid }]);
    expect(launcher.processes).toEqual([bystander]);
    expect(fs.existsSync(path.join(dir, "plexus", "endpoint.properties"))).toBe(false);
  });

  it("names the VMs a kill did not end", async () => {
    const { launcher, imagePath, context } = setup();
    const vm = launcher.run(imagePath);
    launcher.immortal.add(vm.pid);

    await expect(stop(context, "dev")).rejects.toMatchObject({
      code: "stop-failed",
      message: `Image dev still runs as pid ${vm.pid} after being killed.`,
      details: { pids: [vm.pid] },
    });
    expect(context.clock.now - Date.parse("2026-11-13T12:00:00Z")).toBe(10_000);
  });

  it("says at once why the launcher would not kill a VM", async () => {
    const { launcher, imagePath, context } = setup();
    launcher.nextPid = process.pid;
    launcher.run(imagePath);
    launcher.killProcess = async (input) => {
      launcher.calls.push({ method: "killProcess", input });
      return failed("kill EPERM");
    };

    await expect(stop(context, "dev")).rejects.toMatchObject({
      code: "stop-failed",
      message: `Image dev still runs as pid ${process.pid}.\nKilling pid ${process.pid} failed: Pharo Launcher killProcess failed: kill EPERM`,
      details: { pids: [process.pid] },
    });
    expect(context.clock.now - Date.parse("2026-11-13T12:00:00Z")).toBe(0);
  });

  it("takes a kill that failed on a VM gone meanwhile for one that worked", async () => {
    const { launcher, imagePath, context } = setup();
    launcher.nextPid = 2_147_483_646;
    const vm = launcher.run(imagePath);
    launcher.killProcess = async () => {
      launcher.processes = [];
      return failed(`No matching Pharo process found for ${vm.pid}`);
    };

    expect(await stop(context, "dev")).toEqual({ name: "dev", killed: [vm.pid] });
  });

  it("refuses an image that is not there", async () => {
    const { context } = setup();
    await expect(stop(context, "other")).rejects.toMatchObject({ code: "no-such-image" });
  });
});

describe("delete", () => {
  it("removes the image's directory", async () => {
    const { home, context } = setup();
    expect(await deleteImage(context, "dev")).toEqual({ name: "dev" });
    expect(fs.readdirSync(storeRoot(home))).toEqual([]);
    expect(fs.readdirSync(tmpRoot(home))).toEqual([]);
  });

  it("removes an image whose create ended before it was done", async () => {
    const { home, context } = setup();
    fs.mkdirSync(path.join(storeRoot(home), "half", "plexus"), { recursive: true });
    fs.writeFileSync(
      path.join(storeRoot(home), "half", "plexus", "building"),
      JSON.stringify({ pid: 2_147_483_646, at: new Date(context.now()).toISOString() }),
    );

    await deleteImage(context, "half");
    expect(fs.readdirSync(storeRoot(home))).toEqual(["dev"]);
  });

  it("refuses an image a create is still making", async () => {
    const { dir, context } = setup();
    fs.mkdirSync(path.join(dir, "plexus"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "plexus", "building"),
      JSON.stringify({ pid: process.pid, at: new Date(context.now()).toISOString() }),
    );

    await expect(deleteImage(context, "dev")).rejects.toMatchObject({
      code: "building",
      details: { pid: process.pid },
    });
    expect(fs.existsSync(dir)).toBe(true);
  });

  it("refuses while a VM runs the image", async () => {
    const { launcher, imagePath, dir, context } = setup();
    const vm = launcher.run(imagePath);

    await expect(deleteImage(context, "dev")).rejects.toMatchObject({
      code: "image-running",
      details: { pids: [vm.pid] },
    });
    expect(fs.existsSync(dir)).toBe(true);
  });

  it("refuses while a start is launching it", async () => {
    const { dir, context } = setup();
    fs.mkdirSync(path.join(dir, "plexus"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "plexus", "launch.lock"),
      JSON.stringify({ pid: process.pid, at: new Date(context.now()).toISOString() }),
    );

    await expect(deleteImage(context, "dev")).rejects.toMatchObject({ code: "being-started" });
    expect(fs.existsSync(dir)).toBe(true);
  });

  it("refuses an image that is not there", async () => {
    const { context } = setup();
    await expect(deleteImage(context, "other")).rejects.toMatchObject({ code: "no-such-image" });
  });
});
