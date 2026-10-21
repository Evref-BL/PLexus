import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { prepareScopedTemplateCatalog } from "../../src/images/scopedTemplateCatalog.js";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(tempDir);
  return tempDir;
}

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("scoped template catalogue bootstrap", () => {
  it("prefers the user's readable Pharo Launcher catalogue before server fallback", async () => {
    const home = makeTempDir("plexus-home-");
    const destination = path.join(makeTempDir("plexus-profile-"), "templates");
    const userCatalog = path.join(
      home,
      "Library",
      "Application Support",
      "Pharo Launcher",
      "templates",
    );
    fs.mkdirSync(userCatalog, { recursive: true });
    fs.writeFileSync(
      path.join(userCatalog, "pharo-13.ston"),
      "STON template catalogue fixture",
      "utf8",
    );

    const result = await prepareScopedTemplateCatalog({
      destinationDirectory: destination,
      networkPolicy: "online",
      env: { HOME: home },
      platform: "darwin",
      fetch: (async () => {
        throw new Error("server fallback should not be fetched");
      }) as typeof fetch,
    });

    expect(result).toMatchObject({
      ok: true,
      action: "seeded",
      source: "user-profile",
      sourcePath: userCatalog,
      refreshTemplateCatalog: true,
    });
    expect(fs.existsSync(path.join(destination, "pharo-13.ston"))).toBe(true);
  });
  it("refreshes a sources list seeded in an earlier Pharo cycle from upstream", async () => {
    const destination = path.join(makeTempDir("plexus-profile-"), "templates");
    fs.mkdirSync(destination, { recursive: true });
    // Seeded a cycle ago: Pharo 14 was the development version back then.
    fs.writeFileSync(
      path.join(destination, "sources.list"),
      "name: 'Pharo 14.0 - 64bit (development version, latest)'",
      "utf8",
    );
    const current = "name: 'Pharo 14.0 - 64bit (next stable)'";
    const fetched: string[] = [];

    const result = await prepareScopedTemplateCatalog({
      destinationDirectory: destination,
      networkPolicy: "online",
      env: { HOME: makeTempDir("plexus-home-") },
      platform: "darwin",
      fetch: (async (input) => {
        fetched.push(String(input));
        return new Response(current, { status: 200 });
      }) as typeof fetch,
    });

    expect(result).toMatchObject({ ok: true, action: "already-present" });
    expect(fetched).toEqual(["https://files.pharo.org/pharo-launcher/sources.list"]);
    expect(fs.readFileSync(path.join(destination, "sources.list"), "utf8")).toBe(current);
  });

  it("keeps the seeded sources list when upstream cannot be reached", async () => {
    const destination = path.join(makeTempDir("plexus-profile-"), "templates");
    fs.mkdirSync(destination, { recursive: true });
    const seeded = "name: 'Pharo 13.0 - 64bit (stable)'";
    fs.writeFileSync(path.join(destination, "sources.list"), seeded, "utf8");

    const result = await prepareScopedTemplateCatalog({
      destinationDirectory: destination,
      networkPolicy: "online",
      env: { HOME: makeTempDir("plexus-home-") },
      platform: "darwin",
      fetch: (async () => {
        throw new Error("offline");
      }) as typeof fetch,
    });

    expect(result).toMatchObject({ ok: true, action: "already-present" });
    expect(fs.readFileSync(path.join(destination, "sources.list"), "utf8")).toBe(seeded);
  });
});
