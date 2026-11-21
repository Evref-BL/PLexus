import path from "node:path";
import { describe, expect, it } from "vitest";
import { FakeLauncher, imagesWith, tempHome, writeEndpoint, writeLauncherImage } from "../support/fakeLauncher.js";

describe("Images", () => {
  it("answers an image's endpoint only while a VM runs it and wrote one", async () => {
    const home = tempHome();
    const launcher = new FakeLauncher(home);
    const dir = launcher.imageDir("Scope-dev");
    writeLauncherImage(dir, "Scope-dev");
    const images = imagesWith({ home, scope: "Scope", launcher });

    await expect(images.endpoint("dev")).rejects.toMatchObject({
      code: "not-running",
      message: "Image dev is not running. Start it with image_start; it starts as it was last saved.",
    });

    const vm = launcher.run(path.join(dir, "Scope-dev.image"), { script: path.join(dir, "plexus", "start.st") });
    await expect(images.endpoint("dev")).rejects.toMatchObject({
      code: "starting",
      message: `Image dev is starting as pid ${vm.pid}: its MCP server does not answer yet. Call it again once image_list shows it running.`,
      details: { pids: [vm.pid] },
    });

    writeEndpoint(dir, { port: 7001, pid: vm.pid });
    expect(await images.endpoint("dev")).toEqual({ url: "http://127.0.0.1:7001/", pid: vm.pid });
    await expect(images.endpoint("other")).rejects.toMatchObject({
      code: "no-such-image",
      message: "There is no image other. image_list names the images there are; image_create makes one.",
    });
  });

  it("creates, lists, stops and deletes through one scope", async () => {
    const home = tempHome();
    const launcher = new FakeLauncher(home);
    const images = imagesWith({ home, scope: "Scope", launcher });

    await images.create("dev", { template: "Pharo 14.0 - 64bit" });
    expect((await images.list()).map((image) => [image.name, path.basename(image.path)])).toEqual([["dev", "Scope-dev.image"]]);
    expect(await imagesWith({ home, scope: "Other", launcher }).list()).toEqual([]);

    launcher.run(path.join(launcher.imageDir("Scope-dev"), "Scope-dev.image"));
    await expect(images.delete("dev")).rejects.toMatchObject({ code: "image-running" });
    expect((await images.stop("dev")).killed).toHaveLength(1);
    expect(await images.delete("dev")).toEqual({ name: "dev" });
    expect(await images.list()).toEqual([]);
  });
});
