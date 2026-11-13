import fs from "node:fs";
import path from "node:path";
import type { ImageStartInput } from "@evref-bl/pharo-launcher-mcp/launcher";
import { describe, expect, it } from "vitest";
import { defaultPharoMcpVersion } from "../../src/config/pharoMcpVersion.js";
import { basesRoot, storeRoot, tmpRoot } from "../../src/home.js";
import { baseKey } from "../../src/images/bases.js";
import { create } from "../../src/images/create.js";
import { readProperties } from "../../src/images/store.js";
import { plexusVersion } from "../../src/version.js";
import {
  failed,
  FakeLauncher,
  ok,
  tempHome,
  testContext,
  writeLauncherImage,
} from "../support/fakeLauncher.js";

const template = { name: "Pharo 14.0 - 64bit", category: "Official distributions" };
const options = { template: template.name, category: template.category };
const pin = defaultPharoMcpVersion;
const key = baseKey(template.name, template.category, pin);

function setup(scope?: string) {
  const home = tempHome();
  const launcher = new FakeLauncher(home);
  const context = testContext(home, launcher, scope === undefined ? {} : { scope });
  return { home, launcher, context };
}

/** A base as a build leaves it: the build's metadata, the image renamed. */
function writeBase(home: string, baseName: string, content = "image"): string {
  const dir = path.join(basesRoot(home), baseName);
  writeLauncherImage(dir, "plexus-build-0f0f0f0f", template.name);
  fs.renameSync(path.join(dir, "plexus-build-0f0f0f0f.image"), path.join(dir, "base.image"));
  fs.renameSync(path.join(dir, "plexus-build-0f0f0f0f.changes"), path.join(dir, "base.changes"));
  fs.writeFileSync(path.join(dir, "base.image"), content);
  fs.mkdirSync(path.join(dir, "pharo-local", "iceberg"), { recursive: true });
  fs.writeFileSync(path.join(dir, "pharo-local", "iceberg", "clone.txt"), "clone");
  return dir;
}

function listing(dir: string): string[] {
  try {
    return fs.readdirSync(dir).sort();
  } catch {
    return [];
  }
}

describe("create without a script", () => {
  it("copies the base for its template, renamed as the image", async () => {
    const { home, launcher, context } = setup("Scope");
    writeBase(home, key);

    const created = await create(context, "dev", { ...options });

    const dir = path.join(storeRoot(home), "Scope-dev");
    expect(created).toMatchObject({
      name: "dev",
      diskName: "Scope-dev",
      path: path.join(dir, "Scope-dev.image"),
      running: false,
      fromBase: true,
      template: template.name,
      pharoVersion: "140",
      mcp: { source: "pin", version: pin },
    });
    expect(typeof created.seconds).toBe("number");
    expect(launcher.calls).toEqual([]);
    expect(listing(dir)).toEqual([
      "Pharo14.0-64bit.sources",
      "Scope-dev.changes",
      "Scope-dev.image",
      "meta-inf.ston",
      "pharo-local",
      "pharo.version",
      "plexus",
    ]);
    expect(fs.readFileSync(path.join(dir, "pharo-local", "iceberg", "clone.txt"), "utf8")).toBe("clone");
    expect(fs.readFileSync(path.join(dir, "meta-inf.ston"), "utf8")).toContain(
      "RelativePath [ 'Scope-dev', 'Scope-dev.image' ]",
    );
    expect(readProperties(path.join(dir, "plexus", "created.properties"))).toMatchObject({
      template: template.name,
      category: template.category,
      mcp: `pin:${pin}`,
      plexus: plexusVersion,
    });
    expect(listing(tmpRoot(home))).toEqual([]);
  });

  it("builds the base first when there is none, then reuses it", async () => {
    const { home, launcher, context } = setup();
    let prepareScript = "";
    launcher.prepareAnswer = (input: ImageStartInput) => {
      prepareScript = fs.readFileSync(input.script!, "utf8");
      fs.writeFileSync(path.join(path.dirname(input.script!), "prepare-status.properties"), "status=ok\r");
      return ok();
    };

    const first = await create(context, "dev", { ...options });

    expect(first.fromBase).toBe(false);
    const [createImage] = launcher.called("createImage") as Array<Record<string, unknown>>;
    expect(createImage).toMatchObject({
      templateName: template.name,
      templateCategory: template.category,
      noLaunch: true,
    });
    const buildName = createImage.newImageName as string;
    expect(buildName).toMatch(/^plexus-build-[0-9a-f]{8}$/);
    expect(launcher.called("startImage")).toEqual([
      {
        imageName: buildName,
        script: path.join(storeRoot(home), buildName, "plexus", "prepare.st"),
        detached: false,
        displayMode: "headless",
        includeRaw: true,
      },
    ]);
    expect(prepareScript).toContain(`commitish: 'v${pin}'`);

    expect(listing(storeRoot(home))).toEqual(["dev"]);
    expect(listing(path.join(basesRoot(home), key))).toEqual([
      "Pharo14.0-64bit.sources",
      "base.changes",
      "base.image",
      "meta-inf.ston",
      "pharo.version",
    ]);
    expect(fs.readFileSync(path.join(storeRoot(home), "dev", "meta-inf.ston"), "utf8")).toContain(
      "RelativePath [ 'dev', 'dev.image' ]",
    );

    const second = await create(context, "other", { ...options });
    expect(second.fromBase).toBe(true);
    expect(launcher.called("createImage")).toHaveLength(1);
  });

  it("takes the category from the template list when none is given", async () => {
    const { home, launcher, context } = setup();
    launcher.templatesByCategory = { "Official distributions": [template.name], Deprecated: ["Pharo 9.0"] };
    launcher.categories = Object.keys(launcher.templatesByCategory);
    writeBase(home, key);

    await create(context, "dev", { template: template.name });
    expect(launcher.called("updateTemplates")).toHaveLength(1);
  });

  it("refuses an ambiguous or unknown template before making anything", async () => {
    const { home, launcher, context } = setup();
    launcher.templatesByCategory = { A: ["Pharo 14.0"], B: ["Pharo 14.0"] };
    launcher.categories = ["A", "B"];

    await expect(create(context, "dev", { template: "Pharo 14.0" })).rejects.toMatchObject({
      code: "ambiguous-template",
      details: { categories: ["A", "B"] },
    });
    await expect(create(context, "dev", { template: "Pharo 99" })).rejects.toMatchObject({
      code: "unknown-template",
    });
    await expect(create(context, "dev", { template: "" })).rejects.toMatchObject({
      code: "unknown-template",
    });
    expect(launcher.called("createImage")).toEqual([]);
    expect(listing(storeRoot(home))).toEqual([]);
  });

  it("refuses a name that is taken, in any state", async () => {
    const { home, context } = setup();
    fs.mkdirSync(path.join(storeRoot(home), "dev"), { recursive: true });
    await expect(create(context, "dev", { ...options })).rejects.toMatchObject({ code: "image-exists" });
  });

  it("removes a build whose preparation failed and says why", async () => {
    const { home, launcher, context } = setup();
    launcher.prepareAnswer = (input) => {
      fs.writeFileSync(
        path.join(path.dirname(input.script!), "prepare-status.properties"),
        "status=failed\rmessage=Error: Could not resolve: BaselineOfMCP\r",
      );
      return failed("exit 1");
    };

    const error = await create(context, "dev", { ...options }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "create-failed" });
    expect((error as Error).message).toContain("Loading MCP failed: Error: Could not resolve: BaselineOfMCP");
    expect(listing(storeRoot(home))).toEqual([]);
    expect(listing(basesRoot(home))).toEqual([]);
  });

  it("says what the VM printed when the preparation ended without a status", async () => {
    const { launcher, context } = setup();
    launcher.prepareAnswer = () => ({
      ...ok(),
      raw: {
        stdout: `Profile-scoped Pharo image launch.\n${"x".repeat(600)}Loaded nothing\n`,
        stderr: "Error: eval failed: MessageNotUnderstood\n",
        format: "text" as const,
      },
    });

    const error = (await create(context, "dev", { ...options }).catch((caught: unknown) => caught)) as Error;
    expect(error).toMatchObject({ code: "create-failed" });
    expect(error.message).toContain(
      "The preparation ended without saying whether MCP loaded.\nIts error output ends with:\nError: eval failed: MessageNotUnderstood\nIts output ends with:\n…",
    );
    expect(error.message).toContain("xLoaded nothing");
    expect(error.message).not.toContain("Profile-scoped");
  });

  it("says what the launcher said when it could not make the image", async () => {
    const { home, launcher, context } = setup();
    launcher.createAnswer = () => failed("Cannot download the template.");

    await expect(create(context, "dev", { ...options })).rejects.toMatchObject({
      code: "create-failed",
      message: expect.stringContaining("Pharo Launcher createImage failed: Cannot download the template."),
    });
    expect(listing(storeRoot(home))).toEqual([]);
  });

  it("uses the base another create finished first", async () => {
    const { home, launcher, context } = setup();
    launcher.prepareAnswer = (input) => {
      fs.writeFileSync(path.join(path.dirname(input.script!), "prepare-status.properties"), "status=ok\r");
      writeBase(home, key, "theirs");
      return ok();
    };

    const created = await create(context, "dev", { ...options });

    expect(created.fromBase).toBe(false);
    expect(fs.readFileSync(path.join(storeRoot(home), "dev", "dev.image"), "utf8")).toBe("theirs");
    expect(listing(storeRoot(home))).toEqual(["dev"]);
    expect(listing(basesRoot(home))).toEqual([key]);
  });

  it("removes the bases of other pins once it built one", async () => {
    const { home, context } = setup();
    writeBase(home, "pharo-13-0-64bit-0a1b2c3d-mcp-3.6.0");
    writeBase(home, `pharo-12-0-64bit-0a1b2c3d-mcp-${pin}`);
    fs.mkdirSync(path.join(basesRoot(home), "notes"));

    await create(context, "dev", { ...options });

    expect(listing(basesRoot(home))).toEqual(
      [key, "notes", `pharo-12-0-64bit-0a1b2c3d-mcp-${pin}`].sort(),
    );
  });
});

describe("create with a script", () => {
  function script(home: string): string {
    const file = path.join(home, "load-mcp.st");
    fs.writeFileSync(file, "Metacello new load.");
    return file;
  }

  it("builds the image where it stays and files the script in once", async () => {
    const { home, launcher, context } = setup("Scope");
    const loader = script(home);
    let buildingWhilePreparing = false;
    let prepareScript = "";
    launcher.prepareAnswer = (input) => {
      const plexus = path.dirname(input.script!);
      buildingWhilePreparing = fs.existsSync(path.join(plexus, "building"));
      prepareScript = fs.readFileSync(input.script!, "utf8");
      fs.writeFileSync(path.join(plexus, "prepare-status.properties"), "status=ok\r");
      return ok();
    };

    const created = await create(context, "mcp", { ...options, script: loader });

    expect(launcher.called("createImage")).toEqual([
      expect.objectContaining({ newImageName: "Scope-mcp", noLaunch: true }),
    ]);
    expect(buildingWhilePreparing).toBe(true);
    expect(prepareScript).toContain(`'${loader.replace(/\\/g, "/")}' asFileReference fileIn.`);
    expect(prepareScript).not.toContain("Metacello new\n");
    expect(created).toMatchObject({ name: "mcp", fromBase: false, mcp: { source: "script", script: loader } });
    expect(created.building).toBeUndefined();
    expect(created.everyStart).toBeUndefined();
    expect(listing(path.join(storeRoot(home), "Scope-mcp", "plexus"))).toEqual(["created.properties"]);
    expect(listing(basesRoot(home))).toEqual([]);
  });

  it("records the script for every start when asked", async () => {
    const { home, context } = setup();
    const loader = script(home);

    const created = await create(context, "mcp", { ...options, script: loader, everyStart: true });

    expect(created.everyStart).toBe(loader);
    expect(fs.readFileSync(path.join(storeRoot(home), "mcp", "plexus", "on-start"), "utf8")).toBe(`${loader}\n`);
  });

  it("removes the image when the script fails", async () => {
    const { home, launcher, context } = setup();
    launcher.prepareAnswer = (input) => {
      fs.writeFileSync(
        path.join(path.dirname(input.script!), "prepare-status.properties"),
        "status=failed\rmessage=SyntaxErrorNotification\r",
      );
      return failed("exit 1");
    };

    await expect(create(context, "mcp", { ...options, script: script(home) })).rejects.toMatchObject({
      code: "create-failed",
      message: expect.stringContaining("SyntaxErrorNotification"),
    });
    expect(listing(storeRoot(home))).toEqual([]);
  });

  it("refuses a script that is not there, and every-start without one", async () => {
    const { home, context } = setup();
    await expect(
      create(context, "mcp", { ...options, script: path.join(home, "missing.st") }),
    ).rejects.toMatchObject({ code: "script-not-found" });
    await expect(create(context, "mcp", { ...options, everyStart: true })).rejects.toMatchObject({
      code: "script-not-found",
      message: "everyStart needs a script.",
    });
  });
});

describe("the base key", () => {
  it("names the template, its category and the pin", () => {
    expect(baseKey("Pharo 14.0 - 64bit (development version, latest)", "Official distributions", "3.7.0")).toMatch(
      /^pharo-14-0-64bit-development-version-lat-[0-9a-f]{8}-mcp-3\.7\.0$/,
    );
    expect(baseKey("T", "A", "1.0.0")).not.toBe(baseKey("T", "B", "1.0.0"));
    expect(baseKey("x".repeat(80), "A", "1.0.0").split("-")[0]).toHaveLength(40);
  });
});
