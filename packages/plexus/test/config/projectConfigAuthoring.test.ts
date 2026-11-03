import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createProjectConfigFile,
  declareProjectImage,
  defaultProjectImageName,
  projectConfigIdFromName,
  removeProjectImage,
  setProjectImageTemplateCategory,
} from "../../src/config/projectConfigAuthoring.js";
import {
  ProjectConfigError,
  loadProjectConfig,
  projectConfigPath,
  projectImageCreateCleanupPolicy,
  projectMcpLoadPolicy,
} from "../../src/config/projectConfig.js";

const tempDirs: string[] = [];

function makeProject(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "plexus-authoring-"));
  tempDirs.push(directory);
  createProjectConfigFile(directory, { name: "My Project" });
  return directory;
}

function rawConfig(projectRoot: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(projectConfigPath(projectRoot), "utf8"));
}

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("writing plexus.json", () => {
  it("creates a config a project can be loaded from", () => {
    const projectRoot = makeProject();

    expect(loadProjectConfig(projectRoot)).toMatchObject({
      id: "my-project",
      name: "My Project",
      images: [],
    });
  });

  it("derives an id from the name when none is chosen", () => {
    expect(projectConfigIdFromName("Pharo4Agents")).toBe("pharo4agents");
    expect(projectConfigIdFromName("  My Project  ")).toBe("my-project");
    expect(projectConfigIdFromName("///")).toBe("pharo-project");
  });

  it("declares an image with the per-workspace name template", () => {
    const projectRoot = makeProject();

    declareProjectImage(projectRoot, {
      id: "dev",
      templateName: "Pharo 14.0 - 64bit",
      loadScript: "pharo/load-mcp.st",
    });

    const [image] = loadProjectConfig(projectRoot).images;
    expect(image).toMatchObject({
      id: "dev",
      imageName: defaultProjectImageName("dev"),
      mcp: { loadScript: "pharo/load-mcp.st" },
      create: { kind: "template", templateName: "Pharo 14.0 - 64bit" },
    });
  });

  it("writes no key whose value is PLexus's own default", () => {
    // A default copied into every project's file is a default nobody can
    // change again without a migration.
    const projectRoot = makeProject();

    declareProjectImage(projectRoot, {
      id: "dev",
      templateName: "Pharo 14.0 - 64bit",
      loadScript: "pharo/load-mcp.st",
    });

    const [image] = (rawConfig(projectRoot).images as Record<string, unknown>[]);
    expect(image.mcp).not.toHaveProperty("loadPolicy");
    expect(image.create).not.toHaveProperty("cleanupPolicy");

    const [loaded] = loadProjectConfig(projectRoot).images;
    expect(projectMcpLoadPolicy(loaded.mcp)).toBe("ifMissing");
    expect(projectImageCreateCleanupPolicy(loaded.create ?? { kind: "template", templateName: "x" }))
      .toBe("workspace_cleanup_only");
  });

  it("keeps keys PLexus does not read", () => {
    // parseProjectConfig builds a fresh object out of the fields it knows, so
    // an author that saved a parsed config would delete everything a user had
    // added by hand. These edit the file instead.
    const projectRoot = makeProject();
    const config = rawConfig(projectRoot);
    fs.writeFileSync(
      projectConfigPath(projectRoot),
      JSON.stringify({ ...config, teamNote: "do not delete me" }, null, 2),
    );

    declareProjectImage(projectRoot, {
      id: "dev",
      templateName: "Pharo 14.0 - 64bit",
      loadScript: "pharo/load-mcp.st",
    });

    expect(rawConfig(projectRoot).teamNote).toBe("do not delete me");
  });

  it("gives each image its own name, so a second declaration still loads", () => {
    // parseProjectConfig rejects two images whose imageName are equal as
    // written, so a constant default template would make every project
    // single-image. Only {projectName} and {workspaceId} stay placeholders.
    const projectRoot = makeProject();

    declareProjectImage(projectRoot, {
      id: "dev",
      templateName: "Pharo 14.0 - 64bit",
      loadScript: "pharo/load-mcp.st",
    });
    declareProjectImage(projectRoot, {
      id: "ci",
      templateName: "Pharo 13.0 - 64bit",
      loadScript: "pharo/load-mcp.st",
    });

    expect(loadProjectConfig(projectRoot).images.map((image) => image.imageName))
      .toEqual([
        "{projectName}-{workspaceId}-dev",
        "{projectName}-{workspaceId}-ci",
      ]);
  });

  it("refuses a duplicate id and a duplicate image name", () => {
    const projectRoot = makeProject();
    declareProjectImage(projectRoot, {
      id: "dev",
      templateName: "Pharo 14.0 - 64bit",
      loadScript: "pharo/load-mcp.st",
    });

    expect(() =>
      declareProjectImage(projectRoot, {
        id: "dev",
        templateName: "Pharo 13.0 - 64bit",
        loadScript: "pharo/load-mcp.st",
      }),
    ).toThrow(/Image dev is already declared/);

    expect(() =>
      declareProjectImage(projectRoot, {
        id: "other",
        imageName: defaultProjectImageName("dev"),
        templateName: "Pharo 13.0 - 64bit",
        loadScript: "pharo/load-mcp.st",
      }),
    ).toThrow(ProjectConfigError);
  });

  it("records the category a template was found in", () => {
    const projectRoot = makeProject();
    declareProjectImage(projectRoot, {
      id: "dev",
      imageName: "{projectName}-dev",
      templateName: "Pharo 10.0 - 64bit",
      loadScript: "pharo/load-mcp.st",
    });

    setProjectImageTemplateCategory(projectRoot, "dev", "Pharo Mooc");

    expect(loadProjectConfig(projectRoot).images[0].create).toMatchObject({
      templateName: "Pharo 10.0 - 64bit",
      templateCategory: "Pharo Mooc",
    });
    expect(() =>
      setProjectImageTemplateCategory(projectRoot, "gone", "Pharo Mooc"),
    ).toThrow(ProjectConfigError);
  });

  it("removes a declaration and refuses one that is not there", () => {
    const projectRoot = makeProject();
    declareProjectImage(projectRoot, {
      id: "dev",
      templateName: "Pharo 14.0 - 64bit",
      loadScript: "pharo/load-mcp.st",
    });

    expect(removeProjectImage(projectRoot, "dev").images).toEqual([]);
    expect(() => removeProjectImage(projectRoot, "dev")).toThrow(
      /Image dev is not declared in this project/,
    );
  });

  it("refuses an edit that would not load, leaving the file as it was", () => {
    const projectRoot = makeProject();
    const before = fs.readFileSync(projectConfigPath(projectRoot), "utf8");

    expect(() =>
      declareProjectImage(projectRoot, {
        id: "",
        templateName: "Pharo 14.0 - 64bit",
        loadScript: "pharo/load-mcp.st",
      }),
    ).toThrow(ProjectConfigError);

    expect(fs.readFileSync(projectConfigPath(projectRoot), "utf8")).toBe(before);
  });
});
