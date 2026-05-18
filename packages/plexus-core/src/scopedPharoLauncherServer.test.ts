import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PharoLauncherMcpToolClient } from "./pharoLauncherMcpClient.js";
import {
  defaultTargetId,
  projectStatePathForConfig,
  saveProjectState,
  type ProjectState,
} from "./projectState.js";
import {
  ScopedPharoLauncher,
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
    name: "my-project",
    kanban: {
      provider: "vibe-kanban",
      projectId: "project-123",
    },
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

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("scoped pharo launcher facade", () => {
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

  it("exposes a scoped create tool without raw image-name inputs", () => {
    expect(scopedPharoLauncherTools.map((tool) => tool.name)).toEqual([
      "pharo_launcher_image_list",
      "pharo_launcher_image_info",
      "pharo_launcher_image_create",
      "pharo_launcher_image_start",
      "pharo_launcher_image_stop",
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
  });

  it("creates only declared images from an approved project template policy", async () => {
    const projectRoot = makeTempDir("plexus-project-");
    const stateRoot = makeTempDir("plexus-state-");
    const { client, calls } = fakeLauncherClient();
    writeProjectConfig(projectRoot);

    const result = await new ScopedPharoLauncher({
      projectRoot,
      stateRoot,
      workspaceId: "worktree-a",
      pharoLauncherMcpClient: client,
      now: () => new Date("2026-05-18T12:00:00.000Z"),
    }).createImage("dev", "pharo-13-default");

    expect(calls).toEqual([
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
  });

  it("starts and stops declared images through PLexus scoped lifecycle calls", async () => {
    const projectRoot = makeTempDir("plexus-project-");
    const stateRoot = makeTempDir("plexus-state-");
    const starts: unknown[] = [];
    const stops: unknown[] = [];
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
        return {
          ok: true,
          projectRoot,
          statePath: statePath(projectRoot, stateRoot),
          state: runningState(),
          stoppedImages: [],
          failures: [],
        };
      },
    });

    await launcher.startImage("dev");
    await launcher.stopImage("dev");

    expect(starts).toEqual([
      expect.objectContaining({
        projectRoot,
        workspaceId: "worktree-a",
        targetId: "project-123--worktree-a",
        stateRoot,
        imageIds: ["dev"],
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
  });
});
