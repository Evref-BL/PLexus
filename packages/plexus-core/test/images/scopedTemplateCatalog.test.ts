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
});
