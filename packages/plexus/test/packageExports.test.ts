import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as publicSurface from "../src/index.js";

// fileURLToPath, not URL.pathname: on Windows the latter is "/C:/..." and
// every path built from it is wrong.
const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8")) as {
  main: string;
  types: string;
  bin: Record<string, string>;
  exports: Record<string, unknown>;
};

/**
 * What a consumer may import, and what semver therefore constrains. A name
 * reaches this list by being promoted deliberately, and taking one away is a
 * breaking change: either way this test is where it gets noticed.
 */
const publicNames = [
  "Images",
  "PlexusError",
  "callTool",
  "defaultPharoMcpVersion",
  "listTools",
  "plexusHome",
];

describe("the published surface", () => {
  it("exports exactly what the contract names", () => {
    expect(Object.keys(publicSurface).sort()).toEqual([...publicNames].sort());
  });

  it("is the root export alone, and one command", () => {
    expect(manifest.main).toBe("./dist/index.js");
    expect(manifest.types).toBe("./dist/index.d.ts");
    expect(manifest.exports).toEqual({
      ".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
      "./package.json": "./package.json",
    });
    expect(manifest.bin).toEqual({ plexus: "dist/cli.js" });
    expect(fs.existsSync(path.join(packageRoot, "src", "cli.ts"))).toBe(true);
  });
});
