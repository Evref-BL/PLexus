import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PharoLauncherMcpToolClient } from "./pharoLauncherMcpClient.js";
import type {
  ProjectLifecycleRouteRegistration,
  ProjectLifecycleRouteRegistry,
} from "./projectLifecycle.js";
import {
  defaultTargetId,
  projectStatePathForConfig,
  saveProjectState,
  type ProjectImageLeaseState,
  type ProjectState,
} from "./projectState.js";
import {
  ScopedPharoLauncher,
  scopedImageLeaseOptionsFromEnvironment,
  scopedPharoLauncherTools,
} from "./scopedPharoLauncherServer.js";

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
        active: true,
        mcp: {
          port: 7123,
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
    ...overrides,
  };
}

function writeProjectConfig(
  projectRoot: string,
  overrides: Record<string, unknown> = {},
): void {
  fs.writeFileSync(
    path.join(projectRoot, "plexus.project.json"),
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

function runningState(): ProjectState {
  return {
    projectId: "project-123",
    projectName: "my-project",
    workspaceId: "worktree-a",
    targetId: defaultTargetId("project-123", "worktree-a"),
    runtimeStatus: "running",
    updatedAt: "2026-05-18T10:00:00.000Z",
    images: [
      {
        id: "dev",
        imageName: "MyProject-worktree-a-dev",
        assignedPort: 7123,
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
        assignedPort: 7123,
        status: "stopped",
      },
    ],
  };
}

function imageLease(
  overrides: Partial<ProjectImageLeaseState> = {},
): ProjectImageLeaseState {
  return {
    ownerId: "thread-a",
    ownerKind: "thread",
    mode: "mutable",
    purpose: "Investigate issue 24",
    createdAt: "2026-05-18T09:00:00.000Z",
    heartbeatAt: "2026-05-18T09:30:00.000Z",
    ...overrides,
  };
}

function fakeLauncherClient() {
  const calls: Array<{ name: string; argumentsValue: Record<string, unknown> }> =
    [];
  const client: PharoLauncherMcpToolClient = {
    async callTool(name, argumentsValue) {
      calls.push({ name, argumentsValue });
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

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("scoped pharo launcher facade", () => {
  it("reads image lease ownership from scoped launcher environment", () => {
    expect(
      scopedImageLeaseOptionsFromEnvironment({
        PLEXUS_IMAGE_LEASE_OWNER_ID: "thread-456",
        PLEXUS_IMAGE_LEASE_OWNER_KIND: "work-item",
        PLEXUS_IMAGE_LEASE_PURPOSE: "Work on issue 24",
        PLEXUS_IMAGE_LEASE_REPOSITORY_PATH: "/worktrees/project-a",
        PLEXUS_IMAGE_LEASE_BRANCH: "codex/project-a-24",
        PLEXUS_IMAGE_LEASE_TTL_MS: "3600000",
        PLEXUS_IMAGE_LEASE_CLEANUP_COMMAND:
          "plexus project close /worktrees/project-a",
      }),
    ).toEqual({
      ownerId: "thread-456",
      ownerKind: "workItem",
      purpose: "Work on issue 24",
      repositoryPath: "/worktrees/project-a",
      branch: "codex/project-a-24",
      ttlMs: 3_600_000,
      cleanupCommand: "plexus project close /worktrees/project-a",
    });
  });

  it("reports scoped image listings without raw launcher mutation handles", () => {
    const projectRoot = makeTempDir("plexus-project-");
    const stateRoot = makeTempDir("plexus-state-");
    writeProjectConfig(projectRoot);
    saveProjectState(statePath(projectRoot, stateRoot), runningState());

    const result = new ScopedPharoLauncher({
      projectRoot,
      stateRoot,
      workspaceId: "worktree-a",
    }).listImages();

    expect(result).toMatchObject({
      scope: {
        projectId: "project-123",
        projectName: "my-project",
        workspaceId: "worktree-a",
        targetId: "project-123--worktree-a",
      },
      launcherProfile: {
        ownership: "plexus-owned",
        mode: "project-owned",
      },
      images: [
        {
          imageId: "dev",
          active: true,
          status: "running",
        },
      ],
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("MyProject-worktree-a-dev");
    expect(serialized).not.toContain("7123");
    expect(serialized).not.toContain("1234");
    expect(serialized).not.toContain(stateRoot);
  });

  it("reports image lease metadata from scoped runtime state", () => {
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
            branch: "codex/project-a-24",
            cleanupCommand: "plexus project close /worktrees/project-a",
          }),
        },
      ],
    });

    const result = new ScopedPharoLauncher({
      projectRoot,
      stateRoot,
      workspaceId: "worktree-a",
    }).listImages();

    expect(result.images[0]).toMatchObject({
      imageId: "dev",
      lease: {
        ownerId: "thread-a",
        ownerKind: "thread",
        mode: "mutable",
        purpose: "Investigate issue 24",
        repositoryPath: "/worktrees/project-a",
        branch: "codex/project-a-24",
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
      "pharo_launcher_image_create",
      "pharo_launcher_image_start",
      "pharo_launcher_image_open_interactive",
      "pharo_launcher_image_show",
      "pharo_launcher_image_hide",
      "pharo_launcher_image_stop",
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

  it("creates only declared images from an approved project template policy", async () => {
    const projectRoot = makeTempDir("plexus-project-");
    const stateRoot = makeTempDir("plexus-state-");
    const homePath = makeTempDir("plexus-home-");
    const { client, calls } = fakeLauncherClient();
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
              stateRoot,
              "profiles",
              "pharo-launcher-mcp",
              "project-123",
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
        assignedPort: 7123,
        status: "stopped",
        lease: {
          ownerId: "project-123--worktree-a",
          ownerKind: "target",
          mode: "mutable",
          purpose: "Scoped Pharo image lifecycle",
          createdAt: "2026-05-18T12:00:00.000Z",
          heartbeatAt: "2026-05-18T12:00:00.000Z",
        },
      }),
    ]);
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
          active: true,
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
      projectOpen: async (options) => {
        starts.push(options);
        return {
          ok: true,
          projectRoot,
          statePath: statePath(projectRoot, stateRoot),
          state: runningState(),
          failures: [],
        };
      },
      projectClose: async (options) => {
        stops.push(options);
        const state = stoppedState();
        return {
          ok: true,
          projectRoot,
          statePath: statePath(projectRoot, stateRoot),
          state,
          stoppedImages: [],
          repositoryWorkspaceCleanups: [],
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
        targetId: "project-123--worktree-a",
        stateRoot,
        imageIds: ["dev"],
        displayMode: "interactive",
      }),
    ]);
    expect(stops).toEqual([
      expect.objectContaining({
        projectRoot,
        workspaceId: "worktree-a",
        stateRoot,
        imageIds: ["dev"],
      }),
    ]);
    expect(routeRegistrations).toEqual([
      expect.objectContaining({
        projectRoot,
        statePath: statePath(projectRoot, stateRoot),
        state: expect.objectContaining({
          targetId: "project-123--worktree-a",
          images: [expect.objectContaining({ id: "dev", status: "running" })],
        }),
      }),
      expect.objectContaining({
        projectRoot,
        statePath: statePath(projectRoot, stateRoot),
        state: expect.objectContaining({
          targetId: "project-123--worktree-a",
          images: [expect.objectContaining({ id: "dev", status: "stopped" })],
        }),
      }),
    ]);
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
          ownerId: "thread-b",
          ownerKind: "thread",
          purpose: "Work on a different issue",
        },
        now: () => new Date("2026-05-18T12:00:00.000Z"),
        projectClose: async (options) => {
          stops.push(options);
          return {
            ok: true,
            projectRoot,
            statePath: statePath(projectRoot, stateRoot),
            state: runningState(),
            stoppedImages: [],
            repositoryWorkspaceCleanups: [],
            failures: [],
          };
        },
      }).stopImage("dev"),
    ).rejects.toThrow(
      "Image dev is leased to thread thread-a for Investigate issue 24 until 2026-05-18T13:00:00.000Z",
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
        ownerId: "thread-b",
        ownerKind: "thread",
        purpose: "Continue issue 24",
      },
      now: () => new Date("2026-05-18T12:00:00.000Z"),
      projectClose: async () => {
        const state: ProjectState = {
          ...runningState(),
          runtimeStatus: "idle",
          updatedAt: "2026-05-18T12:00:00.000Z",
          images: [
            {
              id: "dev",
              imageName: "MyProject-worktree-a-dev",
              assignedPort: 7123,
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
          repositoryWorkspaceCleanups: [],
          failures: [],
        };
      },
    }).stopImage("dev");

    const savedState = JSON.parse(
      fs.readFileSync(statePath(projectRoot, stateRoot), "utf8"),
    ) as ProjectState;
    expect(savedState.images[0].lease).toEqual({
      ownerId: "thread-b",
      ownerKind: "thread",
      mode: "mutable",
      purpose: "Continue issue 24",
      createdAt: "2026-05-18T12:00:00.000Z",
      heartbeatAt: "2026-05-18T12:00:00.000Z",
    });
  });

  it("resets disposable images through scoped close, delete, create, and reopen policy", async () => {
    const projectRoot = makeTempDir("plexus-project-");
    const stateRoot = makeTempDir("plexus-state-");
    const { client, calls } = fakeLauncherClient();
    const starts: unknown[] = [];
    const stops: unknown[] = [];
    const devImageState = runningState().images[0];
    const previewImageState = {
      id: "preview",
      imageName: "MyProject-worktree-a-preview",
      assignedPort: 7124,
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
      images: [
        projectConfig().images[0],
        {
          id: "preview",
          imageName: "MyProject-{workspaceId}-preview",
          active: true,
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
      now: () => new Date("2026-05-18T12:00:00.000Z"),
      projectClose: async (options) => {
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
          repositoryWorkspaceCleanups: [
            {
              policy: "delete-disposable" as const,
              decision: "deleted" as const,
              imageId: "dev",
              repositoryId: "my-project",
              path: "/private/plexus/repository-workspace",
              dirtyState: "clean" as const,
              recordedAt: "2026-05-18T12:00:00.000Z",
            },
          ],
          failures: [],
        };
      },
      projectOpen: async (options) => {
        starts.push(options);
        const state = {
          ...runningState(),
          images: [
            {
              ...devImageState,
              mcpEndpoint: {
                transport: "http" as const,
                host: "127.0.0.1",
                port: 7123,
                path: "/mcp",
              },
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
        imageIds: ["dev"],
        pharoLauncherMcpClient: client,
        repositoryWorkspaceCleanupPolicy: "delete-disposable",
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
        targetId: "project-123--worktree-a",
        stateRoot,
        imageIds: ["dev"],
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
          requiredArgument: "imageId",
          imageId: "dev",
          status: "routable",
          routable: true,
          endpointRecorded: true,
          contractStatus: "matching",
        },
        repositoryWorkspaceCleanupPolicy: "delete-disposable",
        repositoryWorkspaceCleanup: {
          attempted: true,
          decisions: [
            {
              repositoryId: "my-project",
              decision: "deleted",
              dirtyState: "clean",
            },
          ],
        },
      },
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("MyProject-worktree-a-dev");
    expect(serialized).not.toContain("MyProject-worktree-a-preview");
    expect(serialized).not.toContain(stateRoot);
    expect(serialized).not.toContain("/private/plexus/repository-workspace");

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
      projectOpen: async (options) => {
        starts.push(options);
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
        targetId: "project-123--worktree-a",
        stateRoot,
        imageIds: ["dev"],
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
          mcpEndpoint: {
            transport: "http",
            host: "127.0.0.1",
            port: 7432,
            path: "/mcp",
          },
          pid: 1234,
          status: "running",
          displayMode: "headless",
        },
      ],
    });

    const launcher = new ScopedPharoLauncher({
      projectRoot,
      stateRoot,
      workspaceId: "worktree-a",
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
      projectClose: async (options) => {
        calls.push("close");
        expect(options).toMatchObject({
          imageIds: ["dev"],
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
          repositoryWorkspaceCleanups: [],
          failures: [],
        };
      },
      projectOpen: async (options) => {
        calls.push("open");
        expect(options).toMatchObject({
          imageIds: ["dev"],
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
