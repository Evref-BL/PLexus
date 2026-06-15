import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildHomeImageCachePlan,
  classifyHomeImageCachePharoMcpSupport,
  defaultPlexusHomePath,
  deriveHomeImageCacheKey,
  flushHomeImageCache,
  homeDependencyRepositoryCachePath,
  homeImageCacheKeyMaterial,
  homeImageCacheProfile,
  inferPharoMajorVersionFromTemplateText,
  listHomeImageCacheManifests,
  materializeProjectImageFromHomeCache,
  planHomeImageCacheFlush,
  readHomeImageCacheManifest,
  releaseHomeImageCacheLock,
  resolvePlexusHomePath,
  tryAcquireHomeImageCacheLock,
  writeHomeImageCacheManifest,
  writeHomeImageCachePreparationScript,
} from "../../src/images/homeImageCache.js";
import type { PharoLauncherMcpToolClient } from "../../src/launcher/pharoLauncherMcpClient.js";
import { parseProjectConfig, type ProjectConfig } from "../../src/config/projectConfig.js";
import type { ProjectImageState } from "../../src/workspace/projectState.js";

const tempDirs: string[] = [];

function rootPath(...segments: string[]): string {
  return path.resolve(path.sep, ...segments);
}

function makeTempDir(prefix: string): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(tempDir);
  return tempDir;
}

function config(overrides: Record<string, unknown> = {}): ProjectConfig {
  return parseProjectConfig({
    id: "project-123",
    name: "my-project",
    images: [
      {
        id: "dev",
        imageName: "MyProject-{workspaceId}-dev",
        active: true,
        create: {
          kind: "template",
          templateName: "Moose 13 64bit",
          templateCategory: "Moose",
        },
        mcp: {
          loadScript: "pharo/load-mcp.st",
        },
        git: {
          transport: "ssh",
        },
      },
    ],
    ...overrides,
  });
}

const imageState: ProjectImageState = {
  id: "dev",
  imageName: "MyProject-worktree-a-dev",
  assignedPort: 7123,
  status: "starting",
};

function fakeLauncherClient() {
  const calls: Array<{ name: string; argumentsValue: Record<string, unknown> }> =
    [];
  const client: PharoLauncherMcpToolClient = {
    async callTool(name, argumentsValue = {}) {
      calls.push({ name, argumentsValue });
      return { ok: true };
    },
  };

  return { client, calls };
}

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("home image cache", () => {
  it("resolves the PLexus home path from environment, config, then user home", () => {
    const homeDirectory = rootPath("Users", "ada");
    expect(defaultPlexusHomePath(homeDirectory)).toBe(
      path.join(homeDirectory, ".plexus"),
    );
    expect(
      resolvePlexusHomePath({
        homeDirectory,
        env: {},
      }),
    ).toBe(path.join(homeDirectory, ".plexus"));
    expect(
      resolvePlexusHomePath({
        config: {
          home: {
            path: rootPath("configured", "plexus-home"),
            imageCache: { enabled: true, networkPolicy: "online" },
          },
        },
        env: {},
      }),
    ).toBe(rootPath("configured", "plexus-home"));
    expect(
      resolvePlexusHomePath({
        config: {
          home: {
            path: rootPath("configured", "plexus-home"),
            imageCache: { enabled: true, networkPolicy: "online" },
          },
        },
        env: {
          PLEXUS_HOME: rootPath("env", "plexus-home"),
        },
      }),
    ).toBe(rootPath("env", "plexus-home"));
    expect(homeDependencyRepositoryCachePath(rootPath("env", "plexus-home"))).toBe(
      rootPath("env", "plexus-home", "repositories", "iceberg"),
    );
  });

  it("derives stable cache keys from template, MCP support, Git, and launcher metadata", () => {
    const projectConfig = config();
    const alternateLoadScriptConfig = config({
      images: [
        {
          id: "dev",
          imageName: "MyProject-{workspaceId}-dev",
          active: true,
          create: {
            kind: "template",
            templateName: "Moose 13 64bit",
            templateCategory: "Moose",
          },
          mcp: {
            loadScript: "/tmp/generated/load-mcp.st",
          },
          git: {
            transport: "ssh",
          },
        },
      ],
    });
    const source = {
      kind: "template" as const,
      templateName: "Moose 13 64bit",
      templateCategory: "Moose",
    };
    const material = homeImageCacheKeyMaterial({
      config: projectConfig,
      source,
      mcp: projectConfig.images[0]!.mcp,
      git: projectConfig.images[0]!.git,
      templateMetadata: {
        identity: {
          source: "template-file",
          name: "Moose 13 64bit",
          pharoVersion: "130",
        },
        architecture: "64",
        pharoVersion: "130",
      },
    });

    expect(material.pharoMcp.support).toMatchObject({
      status: "supported",
      actualMajorVersion: 13,
    });
    expect(material.projectCachePolicy).toEqual({
      pharoMcpPreparation: "load-when-supported",
      pharoMcpStartupMode: "required",
    });
    expect(deriveHomeImageCacheKey(material)).toMatch(/^[a-f0-9]{64}$/);
    expect(deriveHomeImageCacheKey(material)).toBe(
      deriveHomeImageCacheKey({
        ...material,
        source: { ...source },
      }),
    );
    expect(
      deriveHomeImageCacheKey(homeImageCacheKeyMaterial({
        config: alternateLoadScriptConfig,
        source,
        mcp: alternateLoadScriptConfig.images[0]!.mcp,
        git: alternateLoadScriptConfig.images[0]!.git,
        templateMetadata: {
          identity: {
            source: "template-file",
            name: "Moose 13 64bit",
            pharoVersion: "130",
          },
          architecture: "64",
          pharoVersion: "130",
        },
      })),
    ).toBe(deriveHomeImageCacheKey(material));
    expect(
      deriveHomeImageCacheKey({
        ...material,
        git: { transport: "https" },
      }),
    ).not.toBe(deriveHomeImageCacheKey(material));
    expect(
      deriveHomeImageCacheKey({
        ...material,
        projectCachePolicy: {
          pharoMcpPreparation: "disabled",
          pharoMcpStartupMode: "disabled",
        },
      }),
    ).not.toBe(deriveHomeImageCacheKey(material));
  });

  it("classifies Moose templates by their underlying Pharo version", () => {
    expect(inferPharoMajorVersionFromTemplateText("Moose 13 64bit")).toBe(13);
    expect(inferPharoMajorVersionFromTemplateText("130")).toBe(13);
    expect(
      classifyHomeImageCachePharoMcpSupport({
        config: config({
          runtime: {
            pharoMcp: {
              metadataKey: "io.github.evref-bl/pharo",
              supportedMajorVersions: [12, 13, 14],
            },
          },
        }),
        source: {
          kind: "template",
          templateName: "Moose 13 64bit",
        },
      }),
    ).toMatchObject({
      status: "supported",
      actualMajorVersion: 13,
    });
    expect(
      classifyHomeImageCachePharoMcpSupport({
        config: config(),
        source: {
          kind: "template",
          templateName: "Pharo 11.0 - 64bit",
        },
      }),
    ).toMatchObject({
      status: "unsupported",
      actualMajorVersion: 11,
    });
  });

  it("plans a cache miss with create, headless prepare, and cross-profile runtime copy operations", () => {
    const projectRoot = makeTempDir("plexus-project-");
    const stateRoot = makeTempDir("plexus-state-");
    const homeDirectory = makeTempDir("plexus-user-home-");
    const plan = buildHomeImageCachePlan({
      projectRoot,
      stateRoot,
      config: config(),
      imageConfig: config().images[0]!,
      imageState,
      workspaceId: "worktree-a",
      targetId: "project-123--worktree-a",
      homeDirectory,
      now: () => new Date("2026-05-19T10:00:00.000Z"),
    });

    expect(plan.status).toBe("miss");
    expect(plan.homePath).toBe(path.join(homeDirectory, ".plexus"));
    expect(plan.refreshTemplateCatalog).toMatchObject({
      toolName: "pharo_launcher_template_update",
      argumentsValue: {},
      requiresApproval: true,
    });
    expect(plan.createCacheImage).toMatchObject({
      toolName: "pharo_launcher_image_create",
      argumentsValue: {
        newImageName: plan.cacheImageName,
        templateName: "Moose 13 64bit",
        templateCategory: "Moose",
        noLaunch: true,
      },
      requiresApproval: true,
    });
    expect(plan.prepareCacheImage).toMatchObject({
      toolName: "pharo_launcher_image_launch",
      argumentsValue: {
        imageName: plan.cacheImageName,
        detached: false,
        displayMode: "headless",
        script: plan.expectedManifest.paths.preparationScriptPath,
      },
      requiresApproval: true,
    });
    expect(plan.runtimeCopy).toMatchObject({
      toolName: "pharo_launcher_image_copy_between_profiles",
      argumentsValue: {
        sourceProfile: homeImageCacheProfile(plan.homePath),
        destinationImageName: "MyProject-worktree-a-dev",
        sourceImageName: plan.cacheImageName,
      },
      requiresApproval: true,
    });
    expect(
      (
        plan.runtimeCopy!.argumentsValue.destinationProfile as {
          stateRoot: string;
        }
      ).stateRoot,
    ).toBe(
      path.join(
        stateRoot,
        "profiles",
        "pharo-launcher-mcp",
        "project-123",
      ),
    );
  });

  it("writes preparation scripts and manifests under the home cache entry", () => {
    const projectRoot = makeTempDir("plexus-project-");
    const homeDirectory = makeTempDir("plexus-user-home-");
    const plan = buildHomeImageCachePlan({
      projectRoot,
      config: config(),
      imageConfig: config().images[0]!,
      homeDirectory,
      now: () => new Date("2026-05-19T10:00:00.000Z"),
    });

    const script = writeHomeImageCachePreparationScript(plan);
    expect(script.filePath).toBe(plan.expectedManifest.paths.preparationScriptPath);
    expect(script.source).toContain(
      "Smalltalk globals at: #PLexusHomeImageCacheKey",
    );
    expect(script.source).toContain(
      `'${path.join(projectRoot, "pharo", "load-mcp.st").replace(/\\/g, "/")}' asFileReference`,
    );
    expect(script.source).toContain(
      `'${plan.expectedManifest.paths.preparationStatusPath.replace(/\\/g, "/")}' asFileReference`,
    );
    expect(script.source).toContain(
      "preparationStatusWriter value: 'failed' value: error description.",
    );
    expect(script.source).toContain("Smalltalk snapshot: true andQuit: true.");

    writeHomeImageCacheManifest(plan.expectedManifest);
    expect(readHomeImageCacheManifest(plan.manifestPath)).toMatchObject({
      status: "ok",
      manifest: {
        key: plan.key,
        cacheImageName: plan.cacheImageName,
      },
    });
    expect(listHomeImageCacheManifests(plan.cacheRoot)).toHaveLength(1);
  });

  it("treats a valid manifest as a cache hit and a lock as in-progress", () => {
    const projectRoot = makeTempDir("plexus-project-");
    const homeDirectory = makeTempDir("plexus-user-home-");
    const initial = buildHomeImageCachePlan({
      projectRoot,
      config: config(),
      imageConfig: config().images[0]!,
      homeDirectory,
    });
    writeHomeImageCacheManifest({
      ...initial.expectedManifest,
      pharoMcp: {
        ...initial.expectedManifest.pharoMcp,
        preparationStatus: "prepared",
      },
    });

    const hit = buildHomeImageCachePlan({
      projectRoot,
      config: config(),
      imageConfig: config().images[0]!,
      homeDirectory,
    });
    expect(hit.status).toBe("hit");
    expect(hit.createCacheImage).toBeUndefined();

    fs.rmSync(initial.entryDirectory, { recursive: true, force: true });
    expect(
      tryAcquireHomeImageCacheLock({
        lockPath: initial.lockPath,
        key: initial.key,
        owner: "runner-1",
        now: () => new Date("2026-05-19T10:00:00.000Z"),
      }),
    ).toMatchObject({ acquired: true });
    const inProgress = buildHomeImageCachePlan({
      projectRoot,
      config: config(),
      imageConfig: config().images[0]!,
      homeDirectory,
    });
    expect(inProgress.status).toBe("in-progress");
    expect(inProgress.createCacheImage).toBeUndefined();
    releaseHomeImageCacheLock(initial.lockPath);
  });

  it("skips Pharo MCP preparation for unsupported Pharo versions", () => {
    const projectRoot = makeTempDir("plexus-project-");
    const plan = buildHomeImageCachePlan({
      projectRoot,
      homeDirectory: makeTempDir("plexus-user-home-"),
      config: config({
        images: [
          {
            id: "legacy",
            imageName: "Legacy-{workspaceId}",
            active: true,
            create: {
              kind: "template",
              templateName: "Pharo 11.0 - 64bit",
            },
            mcp: {
              loadScript: "pharo/load-mcp.st",
            },
          },
        ],
      }),
      imageConfig: config({
        images: [
          {
            id: "legacy",
            imageName: "Legacy-{workspaceId}",
            active: true,
            create: {
              kind: "template",
              templateName: "Pharo 11.0 - 64bit",
            },
            mcp: {
              loadScript: "pharo/load-mcp.st",
            },
          },
        ],
      }).images[0]!,
    });

    expect(plan.support).toMatchObject({
      status: "unsupported",
      actualMajorVersion: 11,
    });
    expect(plan.prepareCacheImage).toBeUndefined();
    expect(plan.expectedManifest.pharoMcp.preparationStatus).toBe("skipped");
  });

  it("keeps local-only cache hits copyable without preparing a cache entry", () => {
    const projectRoot = makeTempDir("plexus-project-");
    const homeDirectory = makeTempDir("plexus-user-home-");
    const projectConfig = config({
      home: {
        imageCache: {
          enabled: true,
          networkPolicy: "local-only",
        },
      },
    });
    const initial = buildHomeImageCachePlan({
      projectRoot,
      config: projectConfig,
      imageConfig: projectConfig.images[0]!,
      imageState,
      workspaceId: "worktree-a",
      targetId: "project-123--worktree-a",
      homeDirectory,
    });
    writeHomeImageCacheManifest({
      ...initial.expectedManifest,
      pharoMcp: {
        ...initial.expectedManifest.pharoMcp,
        preparationStatus: "prepared",
      },
    });

    const hit = buildHomeImageCachePlan({
      projectRoot,
      config: projectConfig,
      imageConfig: projectConfig.images[0]!,
      imageState,
      workspaceId: "worktree-a",
      targetId: "project-123--worktree-a",
      homeDirectory,
    });

    expect(hit.status).toBe("hit");
    expect(hit.networkPolicy).toBe("local-only");
    expect(hit.offlineReadiness).toMatchObject({
      status: "ready",
      missingInputs: [],
    });
    expect(hit.refreshTemplateCatalog).toBeUndefined();
    expect(hit.createCacheImage).toBeUndefined();
    expect(hit.prepareCacheImage).toBeUndefined();
    expect(hit.runtimeCopy).toMatchObject({
      toolName: "pharo_launcher_image_copy_between_profiles",
    });
  });

  it("blocks local-only cache misses until local prerequisites are proven", () => {
    const projectRoot = makeTempDir("plexus-project-");
    const homeDirectory = makeTempDir("plexus-user-home-");
    const projectConfig = config({
      home: {
        imageCache: {
          enabled: true,
          networkPolicy: "local-only",
        },
      },
    });

    const plan = buildHomeImageCachePlan({
      projectRoot,
      config: projectConfig,
      imageConfig: projectConfig.images[0]!,
      imageState,
      workspaceId: "worktree-a",
      targetId: "project-123--worktree-a",
      homeDirectory,
    });

    expect(plan.status).toBe("miss");
    expect(plan.offlineReadiness.status).toBe("missing");
    expect(plan.offlineReadiness.missingInputs).toEqual([
      "templateSource",
      "baseImage",
      "vm",
      "pharoMcpLoadScript",
      "pharoMcpDependencies",
    ]);
    expect(plan.refreshTemplateCatalog).toBeUndefined();
    expect(plan.createCacheImage).toBeUndefined();
    expect(plan.prepareCacheImage).toBeUndefined();
    expect(plan.runtimeCopy).toBeUndefined();
    expect(plan.diagnostics).toEqual(
      expect.arrayContaining([
        "The Pharo MCP load script is missing for local-only home image cache preparation.",
        "The selected Pharo base image artifact has not been proven local for local-only home image cache preparation.",
      ]),
    );
  });

  it("does not require Pharo MCP inputs or preparation when startup is disabled", () => {
    const projectRoot = makeTempDir("plexus-project-");
    const projectConfig = config({
      home: {
        imageCache: {
          enabled: true,
          networkPolicy: "local-only",
        },
      },
      images: [
        {
          id: "plain",
          imageName: "MyProject-{workspaceId}-plain",
          active: true,
          create: {
            kind: "template",
            templateName: "Moose 13 64bit",
            templateCategory: "Moose",
          },
          mcp: {
            loadScript: "pharo/missing-load-mcp.st",
            startupMode: "disabled",
          },
        },
      ],
    });

    const plan = buildHomeImageCachePlan({
      projectRoot,
      config: projectConfig,
      imageConfig: projectConfig.images[0]!,
      imageState: {
        id: "plain",
        imageName: "MyProject-worktree-a-plain",
        status: "starting",
      },
      workspaceId: "worktree-a",
      targetId: "project-123--worktree-a",
      homeDirectory: makeTempDir("plexus-user-home-"),
      templateMetadata: {
        pharoVersion: "130",
        sourceFile: {
          path: "/home-cache/templates/moose-13.ston",
          sha256: "abc123",
        },
      },
      localInputs: {
        baseImage: "available",
        vm: "available",
      },
    });

    expect(plan.offlineReadiness).toMatchObject({
      status: "ready",
      missingInputs: [],
    });
    expect(plan.expectedManifest.pharoMcp.preparationStatus).toBe("skipped");
    expect(plan.keyMaterial.projectCachePolicy).toEqual({
      pharoMcpPreparation: "disabled",
      pharoMcpStartupMode: "disabled",
    });
    expect(plan.prepareCacheImage).toBeUndefined();
    expect(plan.createCacheImage).toMatchObject({
      toolName: "pharo_launcher_image_create",
    });
    expect(plan.runtimeCopy).toMatchObject({
      toolName: "pharo_launcher_image_copy_between_profiles",
    });
  });

  it("plans local-only cache misses from proven local template, image, VM, and MCP inputs", () => {
    const projectRoot = makeTempDir("plexus-project-");
    const homeDirectory = makeTempDir("plexus-user-home-");
    const loadScriptPath = path.join(projectRoot, "pharo", "load-mcp.st");
    fs.mkdirSync(path.dirname(loadScriptPath), { recursive: true });
    fs.writeFileSync(loadScriptPath, "\"local MCP load\"\n", "utf8");
    const projectConfig = config({
      home: {
        imageCache: {
          enabled: true,
          networkPolicy: "local-only",
        },
      },
    });

    const plan = buildHomeImageCachePlan({
      projectRoot,
      config: projectConfig,
      imageConfig: projectConfig.images[0]!,
      imageState,
      workspaceId: "worktree-a",
      targetId: "project-123--worktree-a",
      homeDirectory,
      templateMetadata: {
        pharoVersion: "130",
        sourceFile: {
          path: "/home-cache/templates/pharo-13.ston",
          sha256: "abc123",
        },
      },
      localInputs: {
        baseImage: "available",
        vm: "available",
        pharoMcpDependencies: "available",
      },
    });

    expect(plan.status).toBe("miss");
    expect(plan.offlineReadiness).toMatchObject({
      status: "ready",
      missingInputs: [],
    });
    expect(plan.refreshTemplateCatalog).toBeUndefined();
    expect(plan.createCacheImage).toMatchObject({
      toolName: "pharo_launcher_image_create",
    });
    expect(plan.prepareCacheImage).toMatchObject({
      toolName: "pharo_launcher_image_launch",
    });
    expect(plan.runtimeCopy).toMatchObject({
      toolName: "pharo_launcher_image_copy_between_profiles",
    });
    expect(plan.diagnostics).toContain(
      "PLexus home image cache is in local-only mode; template catalog refresh will be skipped.",
    );
  });

  it("can be disabled and can flush owned cache entries and locks", () => {
    const projectRoot = makeTempDir("plexus-project-");
    const homeDirectory = makeTempDir("plexus-user-home-");
    const disabledConfig = config({
      home: {
        imageCache: {
          enabled: false,
          networkPolicy: "online",
        },
      },
    });
    const disabled = buildHomeImageCachePlan({
      projectRoot,
      config: disabledConfig,
      imageConfig: disabledConfig.images[0]!,
      homeDirectory,
    });
    expect(disabled.status).toBe("disabled");
    expect(disabled.createCacheImage).toBeUndefined();

    const enabled = buildHomeImageCachePlan({
      projectRoot,
      config: config(),
      imageConfig: config().images[0]!,
      homeDirectory,
    });
    writeHomeImageCacheManifest(enabled.expectedManifest);
    expect(
      tryAcquireHomeImageCacheLock({
        lockPath: enabled.lockPath,
        key: enabled.key,
        owner: "runner-1",
      }),
    ).toMatchObject({ acquired: true });

    const flushPlan = planHomeImageCacheFlush({
      config: config(),
      homeDirectory,
      key: enabled.key,
    });
    expect(flushPlan.entries).toEqual([
      expect.objectContaining({
        key: enabled.key,
        exists: true,
      }),
    ]);
    flushHomeImageCache(flushPlan);
    expect(fs.existsSync(enabled.entryDirectory)).toBe(false);
    expect(fs.existsSync(enabled.lockPath)).toBe(false);
  });

  it("executes a cache miss by creating, preparing, manifesting, and copying the runtime image", async () => {
    const projectRoot = makeTempDir("plexus-project-");
    const homeDirectory = makeTempDir("plexus-user-home-");
    const projectConfig = config();
    const home = fakeLauncherClient();
    const runtime = fakeLauncherClient();

    const result = await materializeProjectImageFromHomeCache({
      runtimeClient: runtime.client,
      homeClient: home.client,
      projectRoot,
      config: projectConfig,
      imageConfig: projectConfig.images[0]!,
      imageState,
      workspaceId: "worktree-a",
      targetId: "project-123--worktree-a",
      homeDirectory,
      approval: {
        approved: true,
        runnerId: "runner-1",
      },
      now: () => new Date("2026-05-19T10:00:00.000Z"),
    });

    expect(result?.plan.status).toBe("miss");
    expect(result?.operations.map((operation) => operation.toolName)).toEqual([
      "pharo_launcher_template_update",
      "pharo_launcher_image_create",
      "pharo_launcher_image_launch",
      "pharo_launcher_image_copy_between_profiles",
    ]);
    expect(home.calls.map((call) => call.name)).toEqual([
      "pharo_launcher_template_update",
      "pharo_launcher_image_create",
      "pharo_launcher_image_launch",
    ]);
    expect(runtime.calls).toEqual([
      {
        name: "pharo_launcher_image_copy_between_profiles",
        argumentsValue: expect.objectContaining({
          sourceImageName: result!.plan.cacheImageName,
          destinationImageName: "MyProject-worktree-a-dev",
        }),
      },
    ]);
    expect(readHomeImageCacheManifest(result!.plan.manifestPath)).toMatchObject({
      status: "ok",
      manifest: {
        key: result!.plan.key,
        pharoMcp: {
          preparationStatus: "prepared",
        },
      },
    });
    expect(fs.existsSync(result!.plan.lockPath)).toBe(false);
  });

  it("fails local-only materialization before launcher mutation when local inputs are missing", async () => {
    const projectRoot = makeTempDir("plexus-project-");
    const homeDirectory = makeTempDir("plexus-user-home-");
    const projectConfig = config({
      home: {
        imageCache: {
          enabled: true,
          networkPolicy: "local-only",
        },
      },
    });
    const home = fakeLauncherClient();
    const runtime = fakeLauncherClient();

    await expect(
      materializeProjectImageFromHomeCache({
        runtimeClient: runtime.client,
        homeClient: home.client,
        projectRoot,
        config: projectConfig,
        imageConfig: projectConfig.images[0]!,
        imageState,
        workspaceId: "worktree-a",
        targetId: "project-123--worktree-a",
        homeDirectory,
        approval: {
          approved: true,
          runnerId: "runner-1",
        },
      }),
    ).rejects.toThrow("Home image cache local-only preparation is missing required local inputs");

    expect(home.calls).toEqual([]);
    expect(runtime.calls).toEqual([]);
  });

  it("executes a local-only cache miss without refreshing the template catalog", async () => {
    const projectRoot = makeTempDir("plexus-project-");
    const homeDirectory = makeTempDir("plexus-user-home-");
    const loadScriptPath = path.join(projectRoot, "pharo", "load-mcp.st");
    fs.mkdirSync(path.dirname(loadScriptPath), { recursive: true });
    fs.writeFileSync(loadScriptPath, "\"local MCP load\"\n", "utf8");
    const projectConfig = config({
      home: {
        imageCache: {
          enabled: true,
          networkPolicy: "local-only",
        },
      },
    });
    const home = fakeLauncherClient();
    const runtime = fakeLauncherClient();

    const result = await materializeProjectImageFromHomeCache({
      runtimeClient: runtime.client,
      homeClient: home.client,
      projectRoot,
      config: projectConfig,
      imageConfig: projectConfig.images[0]!,
      imageState,
      workspaceId: "worktree-a",
      targetId: "project-123--worktree-a",
      homeDirectory,
      templateMetadata: {
        pharoVersion: "130",
        sourceFile: {
          path: "/home-cache/templates/pharo-13.ston",
          sha256: "abc123",
        },
      },
      localInputs: {
        baseImage: "available",
        vm: "available",
        pharoMcpDependencies: "available",
      },
      approval: {
        approved: true,
        runnerId: "runner-1",
      },
      now: () => new Date("2026-05-19T10:00:00.000Z"),
    });

    expect(result?.operations.map((operation) => operation.toolName)).toEqual([
      "pharo_launcher_image_create",
      "pharo_launcher_image_launch",
      "pharo_launcher_image_copy_between_profiles",
    ]);
    expect(home.calls.map((call) => call.name)).toEqual([
      "pharo_launcher_image_create",
      "pharo_launcher_image_launch",
    ]);
    expect(runtime.calls.map((call) => call.name)).toEqual([
      "pharo_launcher_image_copy_between_profiles",
    ]);
  });

  it("records image-side home cache preparation failures in the manifest", async () => {
    const projectRoot = makeTempDir("plexus-project-");
    const homeDirectory = makeTempDir("plexus-user-home-");
    const projectConfig = config();
    const statusMessage = "Metacello could not load BaselineOfMCP";
    const homeCalls: Array<{
      name: string;
      argumentsValue: Record<string, unknown>;
    }> = [];
    const homeClient: PharoLauncherMcpToolClient = {
      async callTool(name, argumentsValue = {}) {
        homeCalls.push({ name, argumentsValue });
        if (name === "pharo_launcher_image_launch") {
          const scriptPath = argumentsValue.script as string;
          fs.writeFileSync(
            path.join(path.dirname(scriptPath), "preparation-status.properties"),
            [
              "status=failed",
              "cacheKey=abc123",
              "source=metacello",
              "loadScript=/repo/pharo/load-mcp.st",
              "repository=github://Evref-BL/MCP:main/src",
              "baseline=MCP",
              `message=${statusMessage}`,
              "",
            ].join("\r"),
            "utf8",
          );
          return { ok: false };
        }

        return { ok: true };
      },
    };
    const runtime = fakeLauncherClient();

    await expect(
      materializeProjectImageFromHomeCache({
        runtimeClient: runtime.client,
        homeClient,
        projectRoot,
        config: projectConfig,
        imageConfig: projectConfig.images[0]!,
        imageState,
        workspaceId: "worktree-a",
        targetId: "project-123--worktree-a",
        homeDirectory,
        approval: {
          approved: true,
          runnerId: "runner-1",
        },
        now: () => new Date("2026-05-19T10:00:00.000Z"),
      }),
    ).rejects.toThrow("pharo_launcher_image_launch returned ok: false");

    expect(homeCalls.map((call) => call.name)).toEqual([
      "pharo_launcher_template_update",
      "pharo_launcher_image_create",
      "pharo_launcher_image_launch",
    ]);
    expect(runtime.calls).toEqual([]);
    const plan = buildHomeImageCachePlan({
      projectRoot,
      config: projectConfig,
      imageConfig: projectConfig.images[0]!,
      imageState,
      workspaceId: "worktree-a",
      targetId: "project-123--worktree-a",
      homeDirectory,
    });
    expect(readHomeImageCacheManifest(plan.manifestPath)).toMatchObject({
      status: "ok",
      manifest: {
        pharoMcp: {
          preparationStatus: "failed",
          diagnostics: [
            `Home image cache Pharo MCP preparation failed: ${statusMessage}`,
          ],
        },
      },
    });
    expect(fs.existsSync(plan.lockPath)).toBe(false);
  });

  it("executes a cache hit by copying from the existing home cache image", async () => {
    const projectRoot = makeTempDir("plexus-project-");
    const homeDirectory = makeTempDir("plexus-user-home-");
    const projectConfig = config();
    const initial = buildHomeImageCachePlan({
      projectRoot,
      config: projectConfig,
      imageConfig: projectConfig.images[0]!,
      imageState,
      workspaceId: "worktree-a",
      targetId: "project-123--worktree-a",
      homeDirectory,
    });
    writeHomeImageCacheManifest({
      ...initial.expectedManifest,
      pharoMcp: {
        ...initial.expectedManifest.pharoMcp,
        preparationStatus: "prepared",
      },
    });
    const home = fakeLauncherClient();
    const runtime = fakeLauncherClient();

    const result = await materializeProjectImageFromHomeCache({
      runtimeClient: runtime.client,
      homeClient: home.client,
      projectRoot,
      config: projectConfig,
      imageConfig: projectConfig.images[0]!,
      imageState,
      workspaceId: "worktree-a",
      targetId: "project-123--worktree-a",
      homeDirectory,
      approval: {
        approved: true,
        runnerId: "runner-1",
      },
    });

    expect(result?.plan.status).toBe("hit");
    expect(home.calls).toEqual([]);
    expect(runtime.calls.map((call) => call.name)).toEqual([
      "pharo_launcher_image_copy_between_profiles",
    ]);
  });
});
