import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as publicSurface from "../src/index.js";

// fileURLToPath, not URL.pathname: on Windows the latter is "/C:/..." and
// every path built from it is wrong.
const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const manifest = JSON.parse(
  fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"),
) as { exports: Record<string, { types: string; import: string } | string> };

/**
 * What a consumer may import, and what semver therefore constrains.
 *
 * This list is the decision, not a record of one: a name reaches it by being
 * promoted deliberately, and this test fails until it is written down. Taking
 * one away is a breaking change, and the failure is where that gets noticed.
 */
const publicNames = [
  "ImageAlreadyRunningError",
  "StopProjectImageError",
  "ProjectConfigError",
  "StartProjectImageError",
  "ProjectStateError",
  "ScopedPharoLauncher",
  "ScopedPharoLauncherError",
  "callScopedPharoLauncherTool",
  "stopProjectImage",
  "createProjectState",
  "createScopedPharoLauncherServer",
  "defaultPharoMcpMetadataKey",
  "defaultPharoMcpSupportedMajorVersions",
  "defaultPharoMcpVersion",
  "defaultPlexusHomeDirectoryName",
  "defaultPlexusHomePath",
  "defaultPlexusStateRoot",
  "defaultProjectRuntimePolicy",
  "defaultWorkspaceId",
  "defaultWorkspaceIdValue",
  "homeDependencyIcebergDirectoryName",
  "homeDependencyRepositoriesDirectoryName",
  "homeDependencyRepositoryCachePath",
  "homeDependencyRepositoryNetworkPolicy",
  "homeImageCacheDirectoryName",
  "homeImageCacheEnabled",
  "homeImageCacheNetworkPolicy",
  "hostPharoProcesses",
  "loadProjectConfig",
  "loadProjectState",
  "startProjectImage",
  "parseProjectConfig",
  "plexusHomeEnvironmentKey",
  "plexusProjectConfigFileName",
  "plexusProjectsStateDirectoryName",
  "plexusStateDirectoryName",
  "plexusWorkspacesStateDirectoryName",
  "processesForImage",
  "processesOnImage",
  "projectConfigId",
  "createProjectConfigFile",
  "declareProjectImage",
  "defaultProjectImageName",
  "projectConfigIdFromName",
  "removeProjectImage",
  "setProjectImageTemplateCategory",
  "projectConfigPath",
  "projectImageCreateCleanupPolicy",
  "projectImageDisplayMode",
  "projectMcpLoadPolicy",
  "projectMcpStartupMode",
  "projectStateDirectoryPath",
  "projectStateFileName",
  "projectStatePath",
  "projectStatePathForConfig",
  "projectStateRootForConfig",
  "projectWorkspacesStateDirectoryPath",
  "renderProjectImageName",
  "resolvePlexusHomePath",
  "resolveProjectRuntimePolicy",
  "runtimeStatusForImages",
  "sanitizeRuntimeId",
  "saveProjectState",
  "scopedImageLeaseOptionsFromEnvironment",
  "scopedPharoLauncherTools",
  "startScopedPharoLauncherServer",
];

describe("the published surface", () => {
  it("exports exactly what the contract names", () => {
    expect(Object.keys(publicSurface).sort()).toEqual([...publicNames].sort());
  });

  it("keeps the internals off the root", async () => {
    const internals = await import("../src/internal.js");
    const leaked = Object.keys(internals).filter(
      (name) => name in publicSurface,
    );
    expect(leaked, "internal names reachable from the package root").toEqual(
      [],
    );
  });

  it("points every subpath at a file that is built", () => {
    for (const [subpath, target] of Object.entries(manifest.exports)) {
      if (subpath === "./package.json") {
        continue;
      }

      const entry = typeof target === "string" ? target : target.import;
      const source = path
        .join(packageRoot, entry.replace(/^\.\/dist\//, "src/"))
        .replace(/\.js$/, ".ts");
      expect(
        fs.existsSync(source),
        `${subpath} points at ${entry}, which no source file builds`,
      ).toBe(true);
    }
  });
});
