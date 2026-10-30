import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  PharoLauncherMcpToolError,
  type PharoLauncherMcpToolClient,
} from "../../src/launcher/pharoLauncherMcpClient.js";
import type {
  ProjectLifecycleRouteRegistration,
  ProjectLifecycleRouteRegistry,
} from "../../src/lifecycle/projectLifecycle.js";
import { imageMcpEndpointHandoffPath } from "../../src/gateway/projectImageMcpEndpoint.js";
import {
  loadProjectState,
  projectStatePathForConfig,
  saveProjectState,
  type ProjectImageLeaseState,
  type ProjectState,
} from "../../src/workspace/projectState.js";
import { resolvePlexusHomePath } from "../../src/config/plexusHome.js";
import { describePharoLauncherMcpProfile } from "../../src/launcher/pharoLauncherProfile.js";
import { loadProjectConfig } from "../../src/config/projectConfig.js";
import {
  ScopedPharoLauncher,
  createScopedPharoLauncherServer,
  scopedImageLeaseOptionsFromEnvironment,
  scopedPharoLauncherTools,
} from "../../src/launcher/scopedPharoLauncherServer.js";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(tempDir);
  return tempDir;
}

function projectConfig(overrides: Record<string, unknown> = {}) {
  return {
    id: "project-123",
    name: "my-project",
    images: [
      {
        id: "dev",
        imageName: "MyProject-{workspaceId}-dev",
        mcp: {
          port: 7123,
          loadScript: "pharo/load-mcp.st",
        },
        create: {
          kind: "template",
          profileId: "pharo-13-default",
          templateName: "Pharo 13.0 - 64bit",
          templateCategory: "Official",
          role: "development",
          cleanupPolicy: "workspace_cleanup_only",
        },
      },
    ],
    ...overrides,
  };
}

function writeProjectConfig(
  projectRoot: string,
  overrides: Record<string, unknown> = {},
): void {
  fs.writeFileSync(
    path.join(projectRoot, "plexus.json"),
    JSON.stringify(projectConfig(overrides), null, 2),
    "utf8",
  );
}

function statePath(projectRoot: string, stateRoot: string): string {
  return projectStatePathForConfig({
    projectRoot,
    config: projectConfig(),
    workspaceId: "worktree-a",
    stateRoot,
  });
}

function configOnDisk(projectRoot: string) {
  try {
    return loadProjectConfig(projectRoot);
  } catch {
    return projectConfig();
  }
}

function launcherImageDirectory(
  projectRoot: string,
  stateRoot: string,
  imageName: string,
): string {
  return path.join(
    describePharoLauncherMcpProfile({
      projectRoot,
      config: configOnDisk(projectRoot),
      workspaceId: "worktree-a",
      stateRoot,
    }).imagesDir,
    imageName,
  );
}

function materializeLauncherImage(
  projectRoot: string,
  stateRoot: string,
): void {
  fs.mkdirSync(
    launcherImageDirectory(projectRoot, stateRoot, "MyProject-worktree-a-dev"),
    { recursive: true },
  );
}

function writeEndpointHandoff(projectRoot: string, stateRoot: string): void {
  const filePath = imageMcpEndpointHandoffPath({
    projectRoot,
    projectId: "project-123",
    workspaceId: "worktree-a",
    stateRoot,
    imageId: "dev",
  });
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    "transport=http\nhost=127.0.0.1\nport=7123\npath=/\n",
    "utf8",
  );
}

function removeEndpointHandoff(projectRoot: string, stateRoot: string): void {
  fs.rmSync(
    imageMcpEndpointHandoffPath({
      projectRoot,
      projectId: "project-123",
      workspaceId: "worktree-a",
      stateRoot,
      imageId: "dev",
    }),
    { force: true },
  );
}

/** Make the host agree that the image exists and its MCP answers. */
function liveImage(projectRoot: string, stateRoot: string) {
  materializeLauncherImage(projectRoot, stateRoot);
  writeEndpointHandoff(projectRoot, stateRoot);
  return { isPidAlive: () => true, isPortListening: async () => true };
}

function runningState(): ProjectState {
  return {
    projectId: "project-123",
    projectName: "my-project",
    workspaceId: "worktree-a",
    runtimeStatus: "running",
    updatedAt: "2026-05-18T10:00:00.000Z",
    images: [
      {
        id: "dev",
        imageName: "MyProject-worktree-a-dev",
        pid: 1234,
        status: "running",
      },
    ],
  };
}

function stoppedState(): ProjectState {
  return {
    ...runningState(),
    runtimeStatus: "idle",
    updatedAt: "2026-05-18T12:00:00.000Z",
    images: [
      {
        id: "dev",
        imageName: "MyProject-worktree-a-dev",
        status: "stopped",
      },
    ],
  };
}

function imageLease(
  overrides: Partial<ProjectImageLeaseState> = {},
): ProjectImageLeaseState {
  return {
    ownerId: "workspace-a",
    ownerKind: "workspace",
    mode: "mutable",
    purpose: "Investigate issue 24",
    createdAt: "2026-05-18T09:00:00.000Z",
    heartbeatAt: "2026-05-18T09:30:00.000Z",
    ...overrides,
  };
}

function fakeLauncherClient(host?: {
  projectRoot: string;
  stateRoot: string;
}) {
  const calls: Array<{ name: string; argumentsValue: Record<string, unknown> }> =
    [];
  const client: PharoLauncherMcpToolClient = {
    async callTool(name, argumentsValue) {
      calls.push({ name, argumentsValue });
      if (host && (name.includes("create") || name.includes("copy"))) {
        materializeLauncherImage(host.projectRoot, host.stateRoot);
      }
      if (host && name.includes("delete")) {
        fs.rmSync(
          launcherImageDirectory(
            host.projectRoot,
            host.stateRoot,
            "MyProject-worktree-a-dev",
          ),
          { recursive: true, force: true },
        );
      }
      return { ok: true };
    },
  };

  return { client, calls };
}

function recordingRouteRegistry(
  registrations: ProjectLifecycleRouteRegistration[],
): ProjectLifecycleRouteRegistry {
  return {
    registerProjectRoute(input) {
      registrations.push(input);
    },
    unregisterProjectRoute() {},
  };
}

beforeEach(() => {
  temporaryPlexusHome();
});

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});


// The launcher profile is shared below the PLexus home, so isolate it per test.
function temporaryPlexusHome(): string {
  const plexusHome = makeTempDir("plexus-home-");
  const previous = process.env.PLEXUS_HOME;
  process.env.PLEXUS_HOME = plexusHome;
  restorePlexusHome = () => {
    if (previous === undefined) {
      delete process.env.PLEXUS_HOME;
    } else {
      process.env.PLEXUS_HOME = previous;
    }
  };
  return plexusHome;
}

let restorePlexusHome: (() => void) | undefined;

afterEach(() => {
  restorePlexusHome?.();
  restorePlexusHome = undefined;
});

describe("scoped pharo launcher facade", () => {
  it("reads image lease ownership from scoped launcher environment", () => {
    expect(
      scopedImageLeaseOptionsFromEnvironment({
        PLEXUS_IMAGE_LEASE_OWNER_ID: "workspace-456",
        PLEXUS_IMAGE_LEASE_OWNER_KIND: "workspace",
        PLEXUS_IMAGE_LEASE_PURPOSE: "Work on issue 24",
        PLEXUS_IMAGE_LEASE_REPOSITORY_PATH: "/worktrees/project-a",
        PLEXUS_IMAGE_LEASE_BRANCH: "feature/project-a-24",
        PLEXUS_IMAGE_LEASE_TTL_MS: "3600000",
        PLEXUS_IMAGE_LEASE_CLEANUP_COMMAND:
          "plexus project close /worktrees/project-a",
      }),
    ).toEqual({
      ownerId: "workspace-456",
      ownerKind: "workspace",
      purpose: "Work on issue 24",
      repositoryPath: "/worktrees/project-a",
      branch: "feature/project-a-24",
      ttlMs: 3_600_000,
      cleanupCommand: "plexus project close /worktrees/project-a",
    });
  });

  it("refuses to delete an image that is running", async () => {
    const projectRoot = makeTempDir("plexus-project-");
    const stateRoot = makeTempDir("plexus-state-");
    writeProjectConfig(projectRoot);
    saveProjectState(statePath(projectRoot, stateRoot), runningState());

    await expect(
      new ScopedPharoLauncher({
        projectRoot,
        stateRoot,
        workspaceId: "worktree-a",
        isPidAlive: () => true,
        isPortListening: async () => true,
      }).deleteImage("dev"),
    ).rejects.toThrow(/stop it with pharo_launcher_image_stop/);
  });

  it("drops the runtime record of an image the launcher never made", async () => {
    const projectRoot = makeTempDir("plexus-project-");
    const stateRoot = makeTempDir("plexus-state-");
    writeProjectConfig(projectRoot);
    // A record with nothing behind it: the case project cleanup could not
    // reach, because it enumerated from the record it had already deleted.
    saveProjectState(statePath(projectRoot, stateRoot), runningState());

    const result = await new ScopedPharoLauncher({
      projectRoot,
      stateRoot,
      workspaceId: "worktree-a",
      isPidAlive: () => false,
      isPortListening: async () => false,
    }).deleteImage("dev");

    expect(result.deleted).toEqual({
      imageId: "dev",
      launcherImage: false,
      runtimeRecord: true,
    });
    expect(
      loadProjectState(statePath(projectRoot, stateRoot))?.images,
    ).toEqual([]);
  });

  it("reports scoped image listings without raw launcher mutation handles", async () => {
    const projectRoot = makeTempDir("plexus-project-");
    const stateRoot = makeTempDir("plexus-state-");
    writeProjectConfig(projectRoot);
    saveProjectState(statePath(projectRoot, stateRoot), runningState());

    const result = await new ScopedPharoLauncher({
      projectRoot,
      stateRoot,
      workspaceId: "worktree-a",
      isPidAlive: () => false,
      isPortListening: async () => false,
    }).listImages();

    expect(result).toMatchObject({
      scope: {
        projectId: "project-123",
        projectName: "my-project",
        workspaceId: "worktree-a",
      },
      launcherProfile: {
        ownership: "plexus-owned",
        mode: "project-owned",
      },
      images: [
        {
          imageId: "dev",
          // The record says running; no image file exists, so the row says so.
          status: "absent",
        },
      ],
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("MyProject-worktree-a-dev");
    expect(serialized).not.toContain("7123");
    expect(serialized).not.toContain("1234");
    expect(serialized).not.toContain(stateRoot);
  });

  it("observes image status on the host instead of reading the record", async () => {
    const projectRoot = makeTempDir("plexus-project-");
    const stateRoot = makeTempDir("plexus-state-");
    writeProjectConfig(projectRoot);
    // The record claims the image is running, and it is the only thing that
    // does: nothing has been created and nothing is listening.
    saveProjectState(statePath(projectRoot, stateRoot), runningState());

    const observe = async (
      options: Partial<ConstructorParameters<typeof ScopedPharoLauncher>[0]>,
    ) =>
      (
        await new ScopedPharoLauncher({
          projectRoot,
          stateRoot,
          workspaceId: "worktree-a",
          isPidAlive: () => false,
          isPortListening: async () => false,
          ...options,
        }).listImages()
      ).images[0];

    expect(await observe({})).toMatchObject({
      status: "absent",
      runtime: {
        materialized: false,
        process: { alive: false },
        endpoint: { handoff: "missing", listening: false },
      },
    });

    materializeLauncherImage(projectRoot, stateRoot);
    expect(await observe({})).toMatchObject({
      status: "stopped",
      runtime: { materialized: true },
    });

    expect(await observe({ isPidAlive: () => true })).toMatchObject({
      status: "starting",
      runtime: { process: { alive: true } },
    });

    writeEndpointHandoff(projectRoot, stateRoot);
    expect(await observe({ isPortListening: async () => true })).toMatchObject({
      status: "running",
      runtime: {
        endpoint: {
          handoff: "valid",
          listening: true,
          url: "http://127.0.0.1:7123/",
        },
      },
    });
  });

  it("reports image lease metadata from scoped runtime state", async () => {
    const projectRoot = makeTempDir("plexus-project-");
    const stateRoot = makeTempDir("plexus-state-");
    writeProjectConfig(projectRoot);
    saveProjectState(statePath(projectRoot, stateRoot), {
      ...runningState(),
      images: [
        {
          ...runningState().images[0],
          lease: imageLease({
            repositoryPath: "/worktrees/project-a",
            branch: "feature/project-a-24",
            cleanupCommand: "plexus project close /worktrees/project-a",
          }),
        },
      ],
    });

    const result = await new ScopedPharoLauncher({
      projectRoot,
      stateRoot,
      workspaceId: "worktree-a",
      isPidAlive: () => false,
      isPortListening: async () => false,
    }).listImages();

    expect(result.images[0]).toMatchObject({
      imageId: "dev",
      lease: {
        ownerId: "workspace-a",
        ownerKind: "workspace",
        mode: "mutable",
        purpose: "Investigate issue 24",
        repositoryPath: "/worktrees/project-a",
        branch: "feature/project-a-24",
        cleanupCommand: "plexus project close /worktrees/project-a",
      },
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("MyProject-worktree-a-dev");
    expect(serialized).not.toContain("7123");
    expect(serialized).not.toContain("1234");
    expect(serialized).not.toContain(stateRoot);
  });

  it("exposes a scoped create tool without raw image-name inputs", () => {
    expect(scopedPharoLauncherTools.map((tool) => tool.name)).toEqual([
      "pharo_launcher_image_list",
      "pharo_launcher_image_info",
      "pharo_launcher_template_list",
      "pharo_launcher_template_category_list",
      "pharo_launcher_image_create",
      "pharo_launcher_image_start",
      "pharo_launcher_image_open_interactive",
      "pharo_launcher_image_show",
      "pharo_launcher_image_hide",
      "pharo_launcher_image_stop",
      "pharo_launcher_image_delete",
      "pharo_launcher_image_reset",
    ]);
    expect(
      scopedPharoLauncherTools.find(
        (tool) => tool.name === "pharo_launcher_image_create",
      ),
    ).toMatchObject({
      inputSchema: {
        properties: {
          imageId: { type: "string" },
          profileId: { type: "string" },
        },
        required: ["imageId"],
        additionalProperties: false,
      },
    });
    expect(
      JSON.stringify(
        scopedPharoLauncherTools.find(
          (tool) => tool.name === "pharo_launcher_image_create",
        ),
      ),
    ).not.toContain("newImageName");
    expect(
      scopedPharoLauncherTools.find(
        (tool) => tool.name === "pharo_launcher_image_start",
      ),
    ).toMatchObject({
      inputSchema: {
        properties: {
          imageId: { type: "string" },
          displayMode: {
            type: "string",
            enum: ["headless", "interactive"],
          },
        },
      },
    });
    expect(
      scopedPharoLauncherTools.find(
        (tool) => tool.name === "pharo_launcher_image_reset",
      ),
    ).toMatchObject({
      inputSchema: {
        properties: {
          imageId: { type: "string" },
          confirm: { type: "boolean" },
          start: { type: "boolean" },
          displayMode: {
            type: "string",
            enum: ["headless", "interactive"],
          },
        },
        required: ["imageId", "confirm"],
        additionalProperties: false,
      },
    });
  });

  it("lists the templates available to the project scope", async () => {
    const plexusHome = temporaryPlexusHome();
    const projectRoot = makeTempDir("plexus-project-");
    const stateRoot = makeTempDir("plexus-state-");
    const calls: Array<{ name: string; argumentsValue: Record<string, unknown> }> =
      [];
    const client: PharoLauncherMcpToolClient = {
      async callTool(name, argumentsValue) {
        calls.push({ name, argumentsValue: argumentsValue ?? {} });
        return name === "pharo_launcher_template_list"
          ? { ok: true, data: [{ name: "Pharo 13.0 - 64bit", category: "Official" }] }
          : { ok: true };
      },
    };
    writeProjectConfig(projectRoot);

    const result = await new ScopedPharoLauncher({
      projectRoot,
      stateRoot,
      workspaceId: "worktree-a",
      fetch: (async () =>
        new Response("https://files.example.test/pharo/pharo-13.ston\n", {
          status: 200,
        })) as typeof fetch,
      pharoLauncherMcpClient: client,
    }).listTemplates("Official");

    expect(result.templates).toEqual([
      { name: "Pharo 13.0 - 64bit", category: "Official" },
    ]);
    expect(result.scope).toMatchObject({ workspaceId: "worktree-a" });
    expect(
      calls.find((call) => call.name === "pharo_launcher_template_list"),
    ).toEqual({
      name: "pharo_launcher_template_list",
      argumentsValue: { templateCategory: "Official" },
    });
  });

  it("lists template categories without a category filter", async () => {
    const plexusHome = temporaryPlexusHome();
    const projectRoot = makeTempDir("plexus-project-");
    const stateRoot = makeTempDir("plexus-state-");
    const { client, calls } = fakeLauncherClient();
    writeProjectConfig(projectRoot);

    await new ScopedPharoLauncher({
      projectRoot,
      stateRoot,
      workspaceId: "worktree-a",
      fetch: (async () =>
        new Response("https://files.example.test/pharo/pharo-13.ston\n", {
          status: 200,
        })) as typeof fetch,
      pharoLauncherMcpClient: client,
    }).listTemplateCategories();

    expect(
      calls.find((call) => call.name === "pharo_launcher_template_category_list"),
    ).toEqual({
      name: "pharo_launcher_template_category_list",
      argumentsValue: {},
    });
  });

  it("walks every category so a template outside the default group is found", async () => {
    const plexusHome = temporaryPlexusHome();
    const projectRoot = makeTempDir("plexus-project-");
    const stateRoot = makeTempDir("plexus-state-");
    const asked: string[] = [];
    const sourcesList = `OrderedCollection [
	PhLTemplateSource {
		#type : #URLGroup,
		#name : 'Official distributions',
		#templates : [ ]
	},
	PhLTemplateSource {
		#type : #URLGroup,
		#name : 'Deprecated distributions',
		#templates : [ ]
	}
]
`;
    const client: PharoLauncherMcpToolClient = {
      async callTool(name, argumentsValue) {
        if (name === "pharo_launcher_template_list") {
          const category = String((argumentsValue ?? {}).templateCategory);
          asked.push(category);
          return {
            ok: true,
            data:
              category === "Deprecated distributions"
                ? [{ name: "Pharo 12.0 - 64bit" }]
                : [{ name: "Pharo 14.0 - 64bit (next stable)" }],
          };
        }
        return { ok: true };
      },
    };
    writeProjectConfig(projectRoot);

    const result = await new ScopedPharoLauncher({
      projectRoot,
      stateRoot,
      workspaceId: "worktree-a",
      fetch: (async () => new Response(sourcesList, { status: 200 })) as typeof fetch,
      pharoLauncherMcpClient: client,
    }).listTemplates();

    expect(asked).toEqual(["Official distributions", "Deprecated distributions"]);
    expect(result.templates).toEqual([
      {
        name: "Pharo 14.0 - 64bit (next stable)",
        templateCategory: "Official distributions",
      },
      { name: "Pharo 12.0 - 64bit", templateCategory: "Deprecated distributions" },
    ]);
  });

  it("reports a failed template listing as a scoped launcher error", async () => {
    const plexusHome = temporaryPlexusHome();
    const projectRoot = makeTempDir("plexus-project-");
    const stateRoot = makeTempDir("plexus-state-");
    const client: PharoLauncherMcpToolClient = {
      async callTool(name) {
        if (name === "pharo_launcher_template_category_list") {
          return { ok: true, data: ["Official distributions"] };
        }
        return name === "pharo_launcher_template_list" ? { ok: false } : { ok: true };
      },
    };
    writeProjectConfig(projectRoot);

    await expect(
      new ScopedPharoLauncher({
        projectRoot,
        stateRoot,
        workspaceId: "worktree-a",
        fetch: (async () =>
        new Response("https://files.example.test/pharo/pharo-13.ston\n", {
          status: 200,
        })) as typeof fetch,
      pharoLauncherMcpClient: client,
      }).listTemplates(),
    ).rejects.toThrow(/pharo_launcher_template_list returned ok: false/);
  });

  it("creates an image the record claims but the launcher does not hold", async () => {
    const projectRoot = makeTempDir("plexus-project-");
    const stateRoot = makeTempDir("plexus-state-");
    const homePath = temporaryPlexusHome();
    const { client } = fakeLauncherClient({ projectRoot, stateRoot });
    writeProjectConfig(projectRoot, {
      home: {
        path: homePath,
        imageCache: { enabled: true, networkPolicy: "online" },
      },
    });
    // A record with nothing behind it: an image deleted by hand, or a create
    // that half-finished. Guarding on the record refused this one forever,
    // while image_list reported it absent in the same breath.
    saveProjectState(statePath(projectRoot, stateRoot), runningState());

    const result = await new ScopedPharoLauncher({
      projectRoot,
      stateRoot,
      workspaceId: "worktree-a",
      pharoLauncherMcpClient: client,
      isPidAlive: () => false,
      isPortListening: async () => false,
      now: () => new Date("2026-05-18T12:00:00.000Z"),
    }).createImage("dev", "pharo-13-default");

    expect(result.image.runtime?.materialized).toBe(true);
  });

  it("creates only declared images from an approved project template policy", async () => {
    const projectRoot = makeTempDir("plexus-project-");
    const stateRoot = makeTempDir("plexus-state-");
    const homePath = temporaryPlexusHome();
    const { client, calls } = fakeLauncherClient({ projectRoot, stateRoot });
    writeProjectConfig(projectRoot, {
      home: {
        path: homePath,
        imageCache: { enabled: true, networkPolicy: "online" },
      },
    });

    const result = await new ScopedPharoLauncher({
      projectRoot,
      stateRoot,
      workspaceId: "worktree-a",
      pharoLauncherMcpClient: client,
      now: () => new Date("2026-05-18T12:00:00.000Z"),
    }).createImage("dev", "pharo-13-default");

    expect(calls).toEqual([
      {
        name: "pharo_launcher_template_update",
        argumentsValue: {},
      },
      {
        name: "pharo_launcher_image_create",
        argumentsValue: {
          newImageName: expect.stringMatching(/^PlexusHomeCache-/),
          templateName: "Pharo 13.0 - 64bit",
          templateCategory: "Official",
          noLaunch: true,
        },
      },
      {
        name: "pharo_launcher_image_launch",
        argumentsValue: {
          imageName: expect.stringMatching(/^PlexusHomeCache-/),
          detached: false,
          displayMode: "headless",
          script: expect.stringContaining(
            path.join(homePath, "image-cache", "entries"),
          ),
        },
      },
      {
        name: "pharo_launcher_image_copy_between_profiles",
        argumentsValue: {
          sourceProfile: expect.objectContaining({
            stateRoot: path.join(
              homePath,
              "profiles",
              "pharo-launcher-mcp",
              "image-cache",
            ),
          }),
          destinationProfile: expect.objectContaining({
            stateRoot: path.join(
              path.join(homePath, "profiles", "pharo-launcher-mcp"),
            ),
          }),
          sourceImageName: expect.stringMatching(/^PlexusHomeCache-/),
          destinationImageName: "MyProject-worktree-a-dev",
        },
      },
    ]);
    expect(result).toMatchObject({
      scope: {
        projectId: "project-123",
        workspaceId: "worktree-a",
      },
      image: {
        imageId: "dev",
        status: "stopped",
      },
    });
    expect(JSON.stringify(result)).not.toContain("MyProject-worktree-a-dev");

    const savedState = JSON.parse(
      fs.readFileSync(statePath(projectRoot, stateRoot), "utf8"),
    ) as ProjectState;
    expect(savedState.images).toEqual([
      expect.objectContaining({
        id: "dev",
        imageName: "MyProject-worktree-a-dev",
        status: "stopped",
        creation: {
          role: "development",
          source: {
            kind: "template",
            profileId: "pharo-13-default",
            templateName: "Pharo 13.0 - 64bit",
            templateCategory: "Official",
          },
          cleanupPolicy: "workspace_cleanup_only",
          route: {
            serverName: "pharo_gateway",
            targetKey: "workspaceId",
            imageArgument: "mcpServerId",
            imageId: "dev",
          },
        },
        lease: {
          ownerId: "worktree-a",
          ownerKind: "workspace",
          mode: "mutable",
          purpose: "Scoped Pharo image lifecycle",
          createdAt: "2026-05-18T12:00:00.000Z",
          heartbeatAt: "2026-05-18T12:00:00.000Z",
        },
      }),
    ]);
  });

  it("rejects create when the workspace image limit is already reached", async () => {
    const projectRoot = makeTempDir("plexus-project-");
    const stateRoot = makeTempDir("plexus-state-");
    const { client, calls } = fakeLauncherClient();
    writeProjectConfig(projectRoot, {
      runtime: {
        workspaceImages: {
          maxCount: 1,
        },
      },
      images: [
        projectConfig().images[0],
        {
          ...projectConfig().images[0],
          id: "experiment",
          imageName: "MyProject-{workspaceId}-experiment",
          mcp: {
            port: 7124,
            loadScript: "pharo/load-mcp.st",
          },
        },
      ],
    });
    saveProjectState(statePath(projectRoot, stateRoot), runningState());

    await expect(
      new ScopedPharoLauncher({
        projectRoot,
        stateRoot,
        workspaceId: "worktree-a",
        pharoLauncherMcpClient: client,
      }).createImage("experiment", "pharo-13-default"),
    ).rejects.toThrow(
      "Workspace image policy allows at most 1 image; scoped create for image experiment is rejected",
    );
    expect(calls).toEqual([]);
  });

  it("rejects rendered launcher image-name collisions before launcher calls", async () => {
    const projectRoot = makeTempDir("plexus-project-");
    const stateRoot = makeTempDir("plexus-state-");
    const { client, calls } = fakeLauncherClient();
    writeProjectConfig(projectRoot, {
      images: [
        {
          ...projectConfig().images[0],
          imageName: "MyProject-{workspaceId}-experiment",
        },
        {
          ...projectConfig().images[0],
          id: "experiment",
          imageName: "MyProject-{workspaceId}-{imageId}",
          mcp: {
            port: 7124,
            loadScript: "pharo/load-mcp.st",
          },
        },
      ],
    });

    await expect(
      new ScopedPharoLauncher({
        projectRoot,
        stateRoot,
        workspaceId: "worktree-a",
        pharoLauncherMcpClient: client,
      }).createImage("experiment", "pharo-13-default"),
    ).rejects.toThrow(
      "Rendered image names must be unique: MyProject-worktree-a-experiment",
    );
    expect(calls).toEqual([]);
  });

  it("rejects create when persisted state belongs to another workspace", async () => {
    const projectRoot = makeTempDir("plexus-project-");
    const stateRoot = makeTempDir("plexus-state-");
    const { client, calls } = fakeLauncherClient();
    writeProjectConfig(projectRoot);
    saveProjectState(statePath(projectRoot, stateRoot), {
      ...runningState(),
      workspaceId: "worktree-b",
      runtimeStatus: "idle",
      images: [],
    });

    await expect(
      new ScopedPharoLauncher({
        projectRoot,
        stateRoot,
        workspaceId: "worktree-a",
        pharoLauncherMcpClient: client,
      }).createImage("dev", "pharo-13-default"),
    ).rejects.toThrow(
      "State file belongs to workspace worktree-b; scoped create for workspace worktree-a is rejected",
    );
    expect(calls).toEqual([]);
  });

  it("bootstraps and refreshes a scoped template catalogue before direct create", async () => {
    const plexusHome = temporaryPlexusHome();
    const projectRoot = makeTempDir("plexus-project-");
    const stateRoot = makeTempDir("plexus-state-");
    const { client, calls } = fakeLauncherClient();
    const sourceListUrl = "https://files.example.test/pharo/sources.list";
    const sourceList = "https://files.example.test/pharo/pharo-13.ston\n";
    const fetches: string[] = [];
    writeProjectConfig(projectRoot, {
      home: {
        imageCache: { enabled: false, networkPolicy: "online" },
      },
      runtime: {
        launcherProfile: {
          templateCatalog: {
            source: "server",
            serverSourcesUrl: sourceListUrl,
          },
        },
      },
    });

    await new ScopedPharoLauncher({
      projectRoot,
      stateRoot,
      workspaceId: "worktree-a",
      pharoLauncherMcpClient: client,
      fetch: (async (input) => {
        fetches.push(String(input));
        return new Response(sourceList, { status: 200 });
      }) as typeof fetch,
      now: () => new Date("2026-05-18T12:00:00.000Z"),
    }).createImage("dev", "pharo-13-default");

    expect(fetches).toEqual([sourceListUrl]);
    expect(
      fs.readFileSync(
        path.join(
          path.join(plexusHome, "profiles", "pharo-launcher-mcp"),
          "templates",
          "sources.list",
        ),
        "utf8",
      ),
    ).toBe(sourceList);
    expect(calls).toEqual([
      {
        name: "pharo_launcher_template_update",
        argumentsValue: {},
      },
      {
        name: "pharo_launcher_image_create",
        argumentsValue: {
          newImageName: "MyProject-worktree-a-dev",
          templateName: "Pharo 13.0 - 64bit",
          templateCategory: "Official",
          noLaunch: true,
        },
      },
    ]);
  });

  it("seeds a scoped template catalogue from an explicit local path offline", async () => {
    const plexusHome = temporaryPlexusHome();
    const projectRoot = makeTempDir("plexus-project-");
    const stateRoot = makeTempDir("plexus-state-");
    const templateSource = makeTempDir("plexus-template-catalog-");
    const { client, calls } = fakeLauncherClient();
    fs.writeFileSync(
      path.join(templateSource, "sources.list"),
      "https://files.example.test/pharo/pharo-13.ston\n",
      "utf8",
    );
    fs.writeFileSync(
      path.join(templateSource, "pharo-13.ston"),
      "STON template catalogue fixture",
      "utf8",
    );
    writeProjectConfig(projectRoot, {
      home: {
        imageCache: { enabled: false, networkPolicy: "local-only" },
      },
      runtime: {
        launcherProfile: {
          templateCatalog: {
            source: "path",
            path: templateSource,
          },
        },
      },
    });

    await new ScopedPharoLauncher({
      projectRoot,
      stateRoot,
      workspaceId: "worktree-a",
      pharoLauncherMcpClient: client,
      now: () => new Date("2026-05-18T12:00:00.000Z"),
    }).createImage("dev", "pharo-13-default");

    expect(
      fs.existsSync(
        path.join(
          path.join(plexusHome, "profiles", "pharo-launcher-mcp"),
          "templates",
          "pharo-13.ston",
        ),
      ),
    ).toBe(true);
    expect(calls.map((call) => call.name)).toEqual([
      "pharo_launcher_image_create",
    ]);
  });

  it("fails direct create clearly when local-only policy has no template catalogue", async () => {
    const plexusHome = temporaryPlexusHome();
    const projectRoot = makeTempDir("plexus-project-");
    const stateRoot = makeTempDir("plexus-state-");
    const { client, calls } = fakeLauncherClient();
    writeProjectConfig(projectRoot, {
      home: {
        imageCache: { enabled: false, networkPolicy: "local-only" },
      },
      runtime: {
        launcherProfile: {
          templateCatalog: {
            source: "server",
          },
        },
      },
    });

    await expect(
      new ScopedPharoLauncher({
        projectRoot,
        stateRoot,
        workspaceId: "worktree-a",
        pharoLauncherMcpClient: client,
      }).createImage("dev", "pharo-13-default"),
    ).rejects.toThrow(
      "Scoped template catalogue is missing and local-only policy forbids server bootstrap",
    );
    expect(calls).toEqual([]);
  });

  it("rejects unapproved create profiles before launcher calls", async () => {
    const projectRoot = makeTempDir("plexus-project-");
    const stateRoot = makeTempDir("plexus-state-");
    const { client, calls } = fakeLauncherClient();
    writeProjectConfig(projectRoot);

    await expect(
      new ScopedPharoLauncher({
        projectRoot,
        stateRoot,
        workspaceId: "worktree-a",
        pharoLauncherMcpClient: client,
      }).createImage("dev", "host-profile"),
    ).rejects.toThrow("Profile host-profile is not approved for image dev");
    expect(calls).toEqual([]);
  });

  it("rejects images without approved create policy", async () => {
    const projectRoot = makeTempDir("plexus-project-");
    const stateRoot = makeTempDir("plexus-state-");
    const { client } = fakeLauncherClient();
    writeProjectConfig(projectRoot, {
      images: [
        {
          id: "dev",
          imageName: "MyProject-{workspaceId}-dev",
          mcp: {
            port: 7123,
            loadScript: "pharo/load-mcp.st",
          },
        },
      ],
    });

    await expect(
      new ScopedPharoLauncher({
        projectRoot,
        stateRoot,
        workspaceId: "worktree-a",
        pharoLauncherMcpClient: client,
      }).createImage("dev"),
    ).rejects.toThrow("Image dev has no approved create policy");

    await expect(
      new ScopedPharoLauncher({
        projectRoot,
        stateRoot,
        workspaceId: "worktree-a",
        pharoLauncherMcpClient: client,
      }).resetImage("dev"),
    ).rejects.toThrow(
      "Image dev has no approved create policy in project config; scoped reset is rejected",
    );
  });

  it("preserves structured launcher diagnostics in scoped MCP errors", async () => {
    const projectRoot = makeTempDir("plexus-project-");
    const stateRoot = makeTempDir("plexus-state-");
    writeProjectConfig(projectRoot, {
      home: {
        imageCache: {
          enabled: false,
          networkPolicy: "online",
        },
      },
      runtime: {
        launcherProfile: {
          templateCatalog: {
            source: "none",
          },
        },
      },
    });
    const launcherFailure = {
      ok: false,
      diagnostic: "The selected template is not present in the active profile.",
      action: "Seed the scoped template sources before image creation.",
      command: {
        args: ["image", "create", "--templateName", "Pharo 13.0 - 64bit"],
      },
      templateCreateReadiness: {
        status: "missing",
      },
    };
    const pharoLauncherMcpClient: PharoLauncherMcpToolClient = {
      async callTool(name) {
        throw new PharoLauncherMcpToolError(
          `pharo-launcher-mcp tool failed: ${name}`,
          name,
          launcherFailure,
        );
      },
    };
    const server = createScopedPharoLauncherServer({
      projectRoot,
      stateRoot,
      workspaceId: "worktree-a",
      pharoLauncherMcpClient,
    });
    const client = new Client(
      {
        name: "plexus-core-test",
        version: "0.0.0",
      },
      {
        capabilities: {},
      },
    );
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      const result = await client.callTool({
        name: "pharo_launcher_image_create",
        arguments: { imageId: "dev" },
      });
      const text = result.content.find(
        (item): item is { type: "text"; text: string } =>
          item.type === "text",
      )?.text;

      expect(result.isError).toBe(true);
      expect(text ? JSON.parse(text) : undefined).toMatchObject({
        ok: false,
        error:
          "pharo-launcher-mcp tool failed: pharo_launcher_image_create",
        cause: {
          toolName: "pharo_launcher_image_create",
          result: launcherFailure,
        },
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("starts and stops declared images through PLexus scoped lifecycle calls", async () => {
    const projectRoot = makeTempDir("plexus-project-");
    const stateRoot = makeTempDir("plexus-state-");
    const starts: unknown[] = [];
    const stops: unknown[] = [];
    const routeRegistrations: ProjectLifecycleRouteRegistration[] = [];
    writeProjectConfig(projectRoot);

    const launcher = new ScopedPharoLauncher({
      projectRoot,
      stateRoot,
      workspaceId: "worktree-a",
      startImage: async (options) => {
        starts.push(options);
        return {
          ok: true,
          projectRoot,
          statePath: statePath(projectRoot, stateRoot),
          state: runningState(),
          failures: [],
        };
      },
      stopImage: async (options) => {
        stops.push(options);
        const state = stoppedState();
        return {
          ok: true,
          projectRoot,
          statePath: statePath(projectRoot, stateRoot),
          state,
          stoppedImages: [],
          failures: [],
        };
      },
      routeRegistry: recordingRouteRegistry(routeRegistrations),
    });

    await launcher.startImage("dev", "interactive");
    await launcher.stopImage("dev");

    expect(starts).toEqual([
      expect.objectContaining({
        projectRoot,
        workspaceId: "worktree-a",
        stateRoot,
        imageId: "dev",
        displayMode: "interactive",
      }),
    ]);
    expect(stops).toEqual([
      expect.objectContaining({
        projectRoot,
        workspaceId: "worktree-a",
        stateRoot,
        imageId: "dev",
      }),
    ]);
    // Starting and stopping an image registers nothing: the gateway reads
    // the state file and the endpoint handoffs when a call arrives.
    expect(routeRegistrations).toEqual([]);
  });

  it("blocks scoped mutations when an active image lease belongs to another owner", async () => {
    const projectRoot = makeTempDir("plexus-project-");
    const stateRoot = makeTempDir("plexus-state-");
    const stops: unknown[] = [];
    writeProjectConfig(projectRoot);
    saveProjectState(statePath(projectRoot, stateRoot), {
      ...runningState(),
      images: [
        {
          ...runningState().images[0],
          lease: imageLease({
            expiresAt: "2026-05-18T13:00:00.000Z",
          }),
        },
      ],
    });

    await expect(
      new ScopedPharoLauncher({
        projectRoot,
        stateRoot,
        workspaceId: "worktree-a",
        imageLease: {
          ownerId: "workspace-b",
          ownerKind: "workspace",
          purpose: "Work on a different issue",
        },
        now: () => new Date("2026-05-18T12:00:00.000Z"),
        stopImage: async (options) => {
          stops.push(options);
          return {
            ok: true,
            projectRoot,
            statePath: statePath(projectRoot, stateRoot),
            state: runningState(),
            stoppedImages: [],
            failures: [],
          };
        },
      }).stopImage("dev"),
    ).rejects.toThrow(
      "Image dev is leased to workspace workspace-a for Investigate issue 24 until 2026-05-18T13:00:00.000Z",
    );
    expect(stops).toEqual([]);
  });

  it("allows expired image leases to be reclaimed by the current owner", async () => {
    const projectRoot = makeTempDir("plexus-project-");
    const stateRoot = makeTempDir("plexus-state-");
    writeProjectConfig(projectRoot);
    saveProjectState(statePath(projectRoot, stateRoot), {
      ...runningState(),
      images: [
        {
          ...runningState().images[0],
          lease: imageLease({
            expiresAt: "2026-05-18T11:00:00.000Z",
          }),
        },
      ],
    });

    await new ScopedPharoLauncher({
      projectRoot,
      stateRoot,
      workspaceId: "worktree-a",
      imageLease: {
        ownerId: "workspace-b",
        ownerKind: "workspace",
        purpose: "Continue issue 24",
      },
      now: () => new Date("2026-05-18T12:00:00.000Z"),
      stopImage: async () => {
        const state: ProjectState = {
          ...runningState(),
          runtimeStatus: "idle",
          updatedAt: "2026-05-18T12:00:00.000Z",
          images: [
            {
              id: "dev",
              imageName: "MyProject-worktree-a-dev",
              status: "stopped",
            },
          ],
        };
        saveProjectState(statePath(projectRoot, stateRoot), state);
        return {
          ok: true,
          projectRoot,
          statePath: statePath(projectRoot, stateRoot),
          state,
          stoppedImages: state.images,
          failures: [],
        };
      },
    }).stopImage("dev");

    const savedState = JSON.parse(
      fs.readFileSync(statePath(projectRoot, stateRoot), "utf8"),
    ) as ProjectState;
    expect(savedState.images[0].lease).toEqual({
      ownerId: "workspace-b",
      ownerKind: "workspace",
      mode: "mutable",
      purpose: "Continue issue 24",
      createdAt: "2026-05-18T12:00:00.000Z",
      heartbeatAt: "2026-05-18T12:00:00.000Z",
    });
  });

  it("resets a record whose launcher image was never created", async () => {
    temporaryPlexusHome();
    const projectRoot = makeTempDir("plexus-project-");
    const stateRoot = makeTempDir("plexus-state-");
    writeProjectConfig(projectRoot, {
      home: { imageCache: { enabled: false, networkPolicy: "online" } },
      runtime: { launcherProfile: { templateCatalog: { source: "none" } } },
    });
    const { client, calls } = fakeLauncherClient({ projectRoot, stateRoot });
    const failedState: ProjectState = {
      ...runningState(),
      runtimeStatus: "idle",
      images: [
        {
          id: "dev",
          imageName: "MyProject-worktree-a-dev",
          status: "failed",
        },
      ],
    };
    saveProjectState(statePath(projectRoot, stateRoot), failedState);

    const result = await new ScopedPharoLauncher({
      projectRoot,
      stateRoot,
      workspaceId: "worktree-a",
      pharoLauncherMcpClient: client,
      now: () => new Date("2026-05-18T12:00:00.000Z"),
      stopImage: async () => {
        saveProjectState(statePath(projectRoot, stateRoot), failedState);
        return {
          ok: true,
          projectRoot,
          statePath: statePath(projectRoot, stateRoot),
          state: failedState,
          stoppedImages: failedState.images,
          failures: [],
        };
      },
    }).resetImage("dev", { start: false });

    expect(calls.map((call) => call.name)).toEqual([
      "pharo_launcher_image_create",
    ]);
    expect(result.reset).toMatchObject({
      imageId: "dev",
      deleted: false,
      created: true,
      started: false,
    });
    expect(result.image.status).toBe("stopped");
  });

  it("resets disposable images through scoped close, delete, create, and reopen policy", async () => {
    temporaryPlexusHome();
    const projectRoot = makeTempDir("plexus-project-");
    const stateRoot = makeTempDir("plexus-state-");
    fs.mkdirSync(
      launcherImageDirectory(projectRoot, stateRoot, "MyProject-worktree-a-dev"),
      { recursive: true },
    );
    // With the host, the fake deletes the image files the way the launcher
    // does; create then sees an image that is really gone.
    const { client, calls } = fakeLauncherClient({ projectRoot, stateRoot });
    const starts: unknown[] = [];
    const stops: unknown[] = [];
    const devImageState = runningState().images[0];
    const previewImageState = {
      id: "preview",
      imageName: "MyProject-worktree-a-preview",
      pid: 2345,
      status: "running" as const,
      displayMode: "interactive" as const,
    };
    writeProjectConfig(projectRoot, {
      home: {
        imageCache: {
          enabled: false,
          networkPolicy: "online",
        },
      },
      runtime: {
        launcherProfile: {
          templateCatalog: {
            source: "none",
          },
        },
      },
      images: [
        projectConfig().images[0],
        {
          id: "preview",
          imageName: "MyProject-{workspaceId}-preview",
          displayMode: "interactive",
          mcp: {
            port: 7124,
            loadScript: "pharo/load-mcp.st",
          },
          create: {
            kind: "template",
            profileId: "pharo-13-default",
            templateName: "Pharo 13.0 - 64bit",
            templateCategory: "Official",
          },
        },
      ],
    });
    saveProjectState(statePath(projectRoot, stateRoot), {
      ...runningState(),
      images: [devImageState, previewImageState],
    });

    const result = await new ScopedPharoLauncher({
      projectRoot,
      stateRoot,
      workspaceId: "worktree-a",
      pharoLauncherMcpClient: client,
      isPidAlive: () => true,
      isPortListening: async () => true,
      now: () => new Date("2026-05-18T12:00:00.000Z"),
      stopImage: async (options) => {
        removeEndpointHandoff(projectRoot, stateRoot);
        stops.push(options);
        const state = {
          ...runningState(),
          runtimeStatus: "idle" as const,
          updatedAt: "2026-05-18T12:00:00.000Z",
          images: [
            {
              id: "dev",
              imageName: "MyProject-worktree-a-dev",
              status: "stopped" as const,
            },
            previewImageState,
          ],
        };
        saveProjectState(statePath(projectRoot, stateRoot), state);
        return {
          ok: true,
          projectRoot,
          statePath: statePath(projectRoot, stateRoot),
          state,
          stoppedImages: state.images,
          failures: [],
        };
      },
      startImage: async (options) => {
        writeEndpointHandoff(projectRoot, stateRoot);
        starts.push(options);
        const state = {
          ...runningState(),
          images: [
            {
              ...devImageState,
              mcpServers: [
                {
                  id: "dev",
                  endpoint: {
                    transport: "http" as const,
                    host: "127.0.0.1",
                    port: 7123,
                    path: "/mcp",
                  },
                },
              ],
              pharoMcpContract: {
                status: "matching" as const,
                expectedId: "project-contract",
              },
              displayMode: "interactive" as const,
            },
            previewImageState,
          ],
        };
        saveProjectState(statePath(projectRoot, stateRoot), state);
        return {
          ok: true,
          projectRoot,
          statePath: statePath(projectRoot, stateRoot),
          state,
          failures: [],
        };
      },
    }).resetImage("dev", { displayMode: "interactive" });

    expect(stops).toEqual([
      expect.objectContaining({
        projectRoot,
        workspaceId: "worktree-a",
        stateRoot,
        imageId: "dev",
        pharoLauncherMcpClient: client,
      }),
    ]);
    expect(calls).toEqual([
      {
        name: "pharo_launcher_image_delete",
        argumentsValue: {
          imageName: "MyProject-worktree-a-dev",
          force: true,
          confirm: true,
        },
      },
      {
        name: "pharo_launcher_image_create",
        argumentsValue: {
          newImageName: "MyProject-worktree-a-dev",
          templateName: "Pharo 13.0 - 64bit",
          templateCategory: "Official",
          noLaunch: true,
        },
      },
    ]);
    expect(starts).toEqual([
      expect.objectContaining({
        projectRoot,
        workspaceId: "worktree-a",
        stateRoot,
        imageId: "dev",
        displayMode: "interactive",
      }),
    ]);
    expect(result).toMatchObject({
      image: {
        imageId: "dev",
        status: "running",
        displayMode: "interactive",
      },
      reset: {
        imageId: "dev",
        closed: true,
        deleted: true,
        created: true,
        started: true,
        lifecycle: {
          imageId: "dev",
          status: "running",
          displayMode: "interactive",
        },
        route: {
          serverName: "pharo_gateway",
          requiredArgument: "mcpServerId",
          mcpServerId: "dev",
          status: "routable",
          routable: true,
          endpointRecorded: true,
          contractStatus: "matching",
        },
      },
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("MyProject-worktree-a-dev");
    expect(serialized).not.toContain("MyProject-worktree-a-preview");
    expect(serialized).not.toContain(stateRoot);

    const savedState = JSON.parse(
      fs.readFileSync(statePath(projectRoot, stateRoot), "utf8"),
    ) as ProjectState;
    expect(savedState.images).toEqual([
      expect.objectContaining({ id: "dev", status: "running" }),
      previewImageState,
    ]);
  });

  it("opens declared images interactively through PLexus runtime state", async () => {
    const projectRoot = makeTempDir("plexus-project-");
    const stateRoot = makeTempDir("plexus-state-");
    const starts: unknown[] = [];
    writeProjectConfig(projectRoot);

    const result = await new ScopedPharoLauncher({
      projectRoot,
      stateRoot,
      workspaceId: "worktree-a",
      isPidAlive: () => true,
      isPortListening: async () => true,
      startImage: async (options) => {
        starts.push(options);
        materializeLauncherImage(projectRoot, stateRoot);
        writeEndpointHandoff(projectRoot, stateRoot);
        const state = runningState();
        state.images[0] = {
          ...state.images[0],
          displayMode: "interactive",
        };
        saveProjectState(statePath(projectRoot, stateRoot), state);
        return {
          ok: true,
          projectRoot,
          statePath: statePath(projectRoot, stateRoot),
          state,
          failures: [],
        };
      },
    }).openImageInteractive("dev");

    expect(starts).toEqual([
      expect.objectContaining({
        projectRoot,
        workspaceId: "worktree-a",
        stateRoot,
        imageId: "dev",
        displayMode: "interactive",
      }),
    ]);
    expect(result).toMatchObject({
      image: {
        imageId: "dev",
        status: "running",
        displayMode: "interactive",
        displayModes: {
          default: "headless",
          show: "interactive",
          hide: "headless",
        },
      },
      displayMode: "interactive",
      runtimeStateUnchanged: false,
    });
  });

  it("switches running images between display modes without launching twice", async () => {
    const projectRoot = makeTempDir("plexus-project-");
    const stateRoot = makeTempDir("plexus-state-");
    const calls: string[] = [];
    writeProjectConfig(projectRoot);
    saveProjectState(statePath(projectRoot, stateRoot), {
      ...runningState(),
      images: [
        {
          id: "dev",
          imageName: "MyProject-worktree-a-dev",
          mcpServers: [
            {
              id: "dev",
              endpoint: {
                transport: "http",
                host: "127.0.0.1",
                port: 7432,
                path: "/mcp",
              },
            },
          ],
          pid: 1234,
          status: "running",
          displayMode: "headless",
        },
      ],
    });

    materializeLauncherImage(projectRoot, stateRoot);
    writeEndpointHandoff(projectRoot, stateRoot);

    const launcher = new ScopedPharoLauncher({
      projectRoot,
      stateRoot,
      workspaceId: "worktree-a",
      isPidAlive: () => true,
      isPortListening: async () => true,
      now: () => new Date("2026-05-23T12:00:00.000Z"),
      fetch: async (url, init) => {
        calls.push("snapshot");
        expect(url).toBe("http://127.0.0.1:7432/mcp");
        const body = JSON.parse(String(init?.body)) as {
          params: {
            name: string;
            arguments: {
              code: string;
            };
          };
        };
        const code = body.params.arguments.code;
        expect(body.params).toEqual({
          name: "evaluate",
          arguments: {
            code,
          },
        });
        expect(code).toContain("forkAt: Processor userBackgroundPriority");
        expect(code).toContain("server stop");
        expect(code).toContain(
          "Smalltalk globals removeKey: #PLexusMCPServer",
        );
        expect(code).toContain("Smalltalk snapshot: true andQuit: false.");
        const statusPathMatch = code.match(
          /snapshotStatusFile := '([^']+)' asFileReference/,
        );
        expect(statusPathMatch?.[1]).toContain(
          "display-mode-snapshot-dev-1779537600000.properties",
        );
        fs.writeFileSync(statusPathMatch![1]!, "status=saved\r", "utf8");
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: "snapshot",
            result: {
              content: [],
            },
          }),
          { status: 200 },
        );
      },
      stopImage: async (options) => {
        calls.push("close");
        removeEndpointHandoff(projectRoot, stateRoot);
        expect(options).toMatchObject({
          imageId: "dev",
        });
        const state = {
          ...runningState(),
          runtimeStatus: "idle" as const,
          images: [
            {
              id: "dev",
              imageName: "MyProject-worktree-a-dev",
              status: "stopped" as const,
              displayMode: "headless" as const,
            },
          ],
        };
        saveProjectState(statePath(projectRoot, stateRoot), state);
        return {
          ok: true,
          projectRoot,
          statePath: statePath(projectRoot, stateRoot),
          state,
          stoppedImages: state.images,
          failures: [],
        };
      },
      startImage: async (options) => {
        calls.push("open");
        writeEndpointHandoff(projectRoot, stateRoot);
        expect(options).toMatchObject({
          imageId: "dev",
          displayMode: "interactive",
        });
        const state = {
          ...runningState(),
          images: [
            {
              id: "dev",
              imageName: "MyProject-worktree-a-dev",
              pid: 5678,
              status: "running" as const,
              displayMode: "interactive" as const,
            },
          ],
        };
        saveProjectState(statePath(projectRoot, stateRoot), state);
        return {
          ok: true,
          projectRoot,
          statePath: statePath(projectRoot, stateRoot),
          state,
          failures: [],
        };
      },
    });

    const result = await launcher.showImage("dev");

    expect(calls).toEqual(["snapshot", "close", "open"]);
    expect(result).toMatchObject({
      image: {
        imageId: "dev",
        status: "running",
        displayMode: "interactive",
      },
      previousDisplayMode: "headless",
      displayMode: "interactive",
      restarted: true,
      snapshotBeforeRestart: {
        attempted: true,
        status: "saved",
      },
    });
  });
});
