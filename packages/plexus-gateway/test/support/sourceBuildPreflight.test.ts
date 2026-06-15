import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertFreshSourceBuildForEntrypoint,
  findStaleSourceBuild,
} from "../../src/support/sourceBuildPreflight.js";

const tempDirs: string[] = [];

function tempPackage(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "plexus-gateway-"));
  tempDirs.push(directory);
  fs.mkdirSync(path.join(directory, "src"), { recursive: true });
  fs.mkdirSync(path.join(directory, "dist"), { recursive: true });
  fs.writeFileSync(path.join(directory, "package.json"), "{}", "utf8");
  return directory;
}

function writeFileWithMtime(
  filePath: string,
  contents: string,
  mtime: Date,
): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents, "utf8");
  fs.utimesSync(filePath, mtime, mtime);
}

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("source build preflight", () => {
  it("reports stale dist when source is newer than the entrypoint", () => {
    const packageRoot = tempPackage();
    const distEntrypoint = path.join(packageRoot, "dist", "index.js");
    const sourceFile = path.join(packageRoot, "src", "index.ts");

    writeFileWithMtime(distEntrypoint, "export {};\n", new Date("2026-01-01"));
    writeFileWithMtime(sourceFile, "export {};\n", new Date("2026-01-02"));

    expect(findStaleSourceBuild(distEntrypoint)).toMatchObject({
      packageRoot,
      sourceFile,
      distFile: distEntrypoint,
    });
  });

  it("ignores source test files because they do not affect runtime dist", () => {
    const packageRoot = tempPackage();
    const distEntrypoint = path.join(packageRoot, "dist", "index.js");

    writeFileWithMtime(distEntrypoint, "export {};\n", new Date("2026-01-02"));
    writeFileWithMtime(
      path.join(packageRoot, "src", "index.test.ts"),
      "it('works', () => {});\n",
      new Date("2026-01-03"),
    );

    expect(findStaleSourceBuild(distEntrypoint)).toBeUndefined();
  });

  it("throws with a build command for stale source-backed packages", () => {
    const packageRoot = tempPackage();
    const distEntrypoint = path.join(packageRoot, "dist", "index.js");

    writeFileWithMtime(distEntrypoint, "export {};\n", new Date("2026-01-01"));
    writeFileWithMtime(
      path.join(packageRoot, "src", "server.ts"),
      "export {};\n",
      new Date("2026-01-02"),
    );

    expect(() =>
      assertFreshSourceBuildForEntrypoint(distEntrypoint, {
        packageName: "@evref-bl/plexus-gateway",
        buildCommand: "npm run build",
        env: {},
      }),
    ).toThrow(/npm run build/);
  });

  it("allows an explicit stale-dist bypass", () => {
    const packageRoot = tempPackage();
    const distEntrypoint = path.join(packageRoot, "dist", "index.js");

    writeFileWithMtime(distEntrypoint, "export {};\n", new Date("2026-01-01"));
    writeFileWithMtime(
      path.join(packageRoot, "src", "server.ts"),
      "export {};\n",
      new Date("2026-01-02"),
    );

    expect(() =>
      assertFreshSourceBuildForEntrypoint(distEntrypoint, {
        packageName: "@evref-bl/plexus-gateway",
        buildCommand: "npm run build",
        env: { PLEXUS_ALLOW_STALE_DIST: "true" },
      }),
    ).not.toThrow();
  });
});
