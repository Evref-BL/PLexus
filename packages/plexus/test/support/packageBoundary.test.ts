import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

interface PackageJson {
  main?: string;
  types?: string;
  exports?: Record<string, unknown>;
}

function packageJson(): PackageJson {
  return JSON.parse(
    fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"),
  ) as PackageJson;
}

describe("core package boundary", () => {
  it("exports the public lifecycle library entry point", () => {
    const manifest = packageJson();

    expect(manifest.main).toBe("./dist/index.js");
    expect(manifest.types).toBe("./dist/index.d.ts");
    expect(manifest.exports).toMatchObject({
      ".": {
        import: "./dist/index.js",
        types: "./dist/index.d.ts",
      },
      "./package.json": "./package.json",
    });
  });
});
