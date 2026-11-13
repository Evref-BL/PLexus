import path from "node:path";
import { describe, expect, it } from "vitest";
import { Images } from "../../src/index.js";
import { FakeLauncher, tempHome, writeEndpoint, writeLauncherImage } from "../support/fakeLauncher.js";

describe("Images", () => {
  it("answers an image's endpoint only while a VM runs it and wrote one", async () => {
    const home = tempHome();
    const launcher = new FakeLauncher(home);
    const dir = launcher.imageDir("Scope-dev");
    writeLauncherImage(dir, "Scope-dev");
    const images = new Images({ home, scope: "Scope", launcher });

    await expect(images.endpoint("dev")).rejects.toMatchObject({ code: "not-running" });

    const vm = launcher.run(path.join(dir, "Scope-dev.image"), { script: path.join(dir, "plexus", "start.st") });
    await expect(images.endpoint("dev")).rejects.toMatchObject({
      code: "no-endpoint",
      message: "Image dev runs, but has no endpoint to forward to: no endpoint written yet.",
      details: { pids: [vm.pid] },
    });

    writeEndpoint(dir, { port: 7001, pid: vm.pid });
    expect(await images.endpoint("dev")).toEqual({ url: "http://127.0.0.1:7001/", pid: vm.pid });
    await expect(images.endpoint("other")).rejects.toMatchObject({ code: "no-such-image" });
  });

  it("creates, lists, stops and deletes through one scope", async () => {
    const home = tempHome();
    const launcher = new FakeLauncher(home);
    const images = new Images({ home, scope: "Scope", launcher });

    await images.create("dev", { template: "Pharo 14.0 - 64bit" });
    expect((await images.list()).map((image) => [image.name, image.diskName])).toEqual([["dev", "Scope-dev"]]);
    expect(await new Images({ home, scope: "Other", launcher }).list()).toEqual([]);

    launcher.run(path.join(launcher.imageDir("Scope-dev"), "Scope-dev.image"));
    await expect(images.delete("dev")).rejects.toMatchObject({ code: "image-running" });
    expect((await images.stop("dev")).killed).toHaveLength(1);
    expect(await images.delete("dev")).toEqual({ name: "dev" });
    expect(await images.list()).toEqual([]);
  });
});
