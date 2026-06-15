import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PharoLauncherMcpToolClient } from "../../src/launcher/pharoLauncherMcpClient.js";
import type { ProjectConfig, ProjectImageConfig } from "../../src/config/projectConfig.js";
import type { ProjectImageState } from "../../src/workspace/projectState.js";
import {
  buildPreparedImageCachePlan,
  copyProjectImageFromPreparedCache,
  generatePreparedImageCacheScript,
  preparedImageCacheName,
  preparedImageLoadStatusPath,
  preparedImageScriptFileName,
  PreparedImageCacheError,
  writePreparedImageCacheScript,
} from "../../src/images/preparedImageCache.js";

const tempDirs: string[] = [];

const config: ProjectConfig = {
  id: "project-123",
  name: "my-project",
  preparedImages: [
    {
      id: "pharo-13-mcp",
      imageName: "MyProject-{projectId}-{cacheId}",
      source: {
        kind: "template",
        profileId: "pharo-13-default",
        templateName: "Pharo 13.0 - 64bit",
        templateCategory: "Official",
      },
      mcp: {
        loadScript: "pharo/load-mcp.st",
        repository: {
          githubUser: "Evref-BL",
          project: "MCP",
          commitish: "main",
          path: "",
          baseline: "MCP",
        },
      },
    },
  ],
  images: [
    {
      id: "dev",
      imageName: "MyProject-{workspaceId}-dev",
      active: true,
      preparedImage: {
        cacheId: "pharo-13-mcp",
        copyMode: "copy-on-open",
      },
      mcp: {
        loadScript: "pharo/load-mcp.st",
      },
    },
  ],
};

const imageConfig = config.images[0] as ProjectImageConfig;
const imageState: ProjectImageState = {
  id: "dev",
  imageName: "MyProject-worktree-a-dev",
  assignedPort: 7123,
  status: "starting",
};

function makeTempDir(prefix: string): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(tempDir);
  return tempDir;
}

class FakeLauncherClient implements PharoLauncherMcpToolClient {
  readonly calls: Array<{
    name: string;
    argumentsValue: Record<string, unknown>;
  }> = [];

  async callTool<T = unknown>(
    name: string,
    argumentsValue: Record<string, unknown> = {},
  ): Promise<T> {
    this.calls.push({ name, argumentsValue });
    return { ok: true } as T;
  }
}

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("prepared image cache", () => {
  it("renders project-scoped cache names and file-safe script names", () => {
    expect(
      preparedImageCacheName(config, config.preparedImages![0]),
    ).toBe("MyProject-project-123-pharo-13-mcp");
    expect(preparedImageScriptFileName("pharo-13-mcp")).toBe(
      "prepare-pharo-13-mcp.st",
    );
    expect(() => preparedImageScriptFileName("../cache")).toThrow(
      PreparedImageCacheError,
    );
  });

  it("generates a source-only preparation script with configured MCP loading", () => {
    const projectRoot = path.join("C:", "dev", "code", "git", "my-project");
    const source = generatePreparedImageCacheScript({
      projectRoot,
      preparedImage: config.preparedImages![0],
    });

    expect(source).toContain(
      "Smalltalk globals at: #PLexusPreparedImageCacheId put: 'pharo-13-mcp'.",
    );
    expect(source).toContain(
      "'C:/dev/code/git/my-project/pharo/load-mcp.st' asFileReference",
    );
    expect(source).toContain("githubUser: 'Evref-BL' project: 'MCP'");
    expect(source).toContain("baseline: 'MCP'");
    expect(source).toContain("Smalltalk snapshot: true andQuit: true.");
    expect(source).not.toContain("mcp start.");
    expect(source).not.toContain("Semaphore new wait.");
  });

  it("writes preparation scripts under project-scoped runtime state", () => {
    const projectRoot = makeTempDir("plexus-project-");
    const stateRoot = makeTempDir("plexus-state-");
    const written = writePreparedImageCacheScript({
      projectRoot,
      config,
      cacheId: "pharo-13-mcp",
      stateRoot,
    });

    expect(written.filePath).toBe(
      path.join(
        stateRoot,
        "projects",
        "project-123",
        "prepared-images",
        "prepare-pharo-13-mcp.st",
      ),
    );
    expect(written.loadStatusPath).toBe(
      preparedImageLoadStatusPath({
        projectRoot,
        projectId: "project-123",
        cacheId: "pharo-13-mcp",
        stateRoot,
      }),
    );
    expect(fs.readFileSync(written.filePath, "utf8")).toBe(written.source);
    expect(written.source).toContain(
      `'${written.loadStatusPath.replace(/\\/g, "/")}' asFileReference`,
    );
    expect(written.source).toContain(
      "loadStatusWriter value: 'failed' value: error description.",
    );
  });

  it("builds an approved-runner live operation plan without mutating launcher state", () => {
    const plan = buildPreparedImageCachePlan({
      projectRoot: "/repo/my-project",
      config,
      cacheId: "pharo-13-mcp",
      imageConfig,
      imageState,
    });

    expect(plan).toMatchObject({
      cacheId: "pharo-13-mcp",
      imageName: "MyProject-project-123-pharo-13-mcp",
      createCacheImage: {
        toolName: "pharo_launcher_image_create",
        argumentsValue: {
          newImageName: "MyProject-project-123-pharo-13-mcp",
          templateName: "Pharo 13.0 - 64bit",
          templateCategory: "Official",
          noLaunch: true,
        },
        requiresApproval: true,
      },
      runtimeCopy: {
        toolName: "pharo_launcher_image_copy",
        argumentsValue: {
          imageName: "MyProject-project-123-pharo-13-mcp",
          newImageName: "MyProject-worktree-a-dev",
        },
        requiresApproval: true,
      },
    });
  });

  it("plans one project cache image for distinct workspace runtime image copies", () => {
    const stateA: ProjectImageState = {
      ...imageState,
      imageName: "MyProject-worktree-a-dev",
      assignedPort: 7123,
    };
    const stateB: ProjectImageState = {
      ...imageState,
      imageName: "MyProject-worktree-b-dev",
      assignedPort: 7124,
    };
    const planA = buildPreparedImageCachePlan({
      projectRoot: "/repo/my-project",
      config,
      cacheId: "pharo-13-mcp",
      imageConfig,
      imageState: stateA,
    });
    const planB = buildPreparedImageCachePlan({
      projectRoot: "/repo/my-project",
      config,
      cacheId: "pharo-13-mcp",
      imageConfig,
      imageState: stateB,
    });

    expect(planA.imageName).toBe("MyProject-project-123-pharo-13-mcp");
    expect(planB.imageName).toBe(planA.imageName);
    expect(planA.runtimeCopy.argumentsValue.newImageName).toBe(
      "MyProject-worktree-a-dev",
    );
    expect(planB.runtimeCopy.argumentsValue.newImageName).toBe(
      "MyProject-worktree-b-dev",
    );
  });

  it("requires explicit runner approval before copying a prepared cache image", async () => {
    const client = new FakeLauncherClient();

    await expect(
      copyProjectImageFromPreparedCache({
        client,
        projectRoot: "/repo/my-project",
        config,
        imageConfig,
        imageState,
      }),
    ).rejects.toThrow("requires an approved prepared-image runner");
    expect(client.calls).toEqual([]);

    await copyProjectImageFromPreparedCache({
      client,
      projectRoot: "/repo/my-project",
      config,
      imageConfig,
      imageState,
      approval: {
        approved: true,
        runnerId: "isolated-runner-1",
      },
    });

    expect(client.calls).toEqual([
      {
        name: "pharo_launcher_image_copy",
        argumentsValue: {
          imageName: "MyProject-project-123-pharo-13-mcp",
          newImageName: "MyProject-worktree-a-dev",
        },
      },
    ]);
  });
});
