import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PharoLauncherMcpToolClient } from "./pharoLauncherMcpClient.js";
import type { PharoMcpHealthClient } from "./pharoMcpHealth.js";
import {
  rescueImage,
  type ImageRescueMcpClient,
} from "./imageRescue.js";
import {
  saveProjectState,
  type ProjectImageState,
  type ProjectState,
} from "./projectState.js";

const tempDirs: string[] = [];

interface ToolCall {
  name: string;
  argumentsValue: Record<string, unknown>;
}

class FakeLauncherClient implements PharoLauncherMcpToolClient {
  readonly calls: ToolCall[] = [];

  constructor(private readonly imagesDir: string) {}

  async callTool<T = unknown>(
    name: string,
    argumentsValue: Record<string, unknown> = {},
  ): Promise<T> {
    this.calls.push({ name, argumentsValue });

    if (name === "pharo_launcher_config") {
      return {
        profile: {
          imagesDir: {
            path: this.imagesDir,
            exists: true,
          },
        },
      } as T;
    }

    if (name === "pharo_launcher_image_info") {
      const imageName = argumentsValue.imageName as string;
      return {
        ok: true,
        data: {
          name: imageName,
          imagePath: path.join(imageName, `${imageName}.image`),
          pharoVersion: "13",
          vmId: "vm-13",
          originTemplate: {
            name: "Pharo 13.0 - 64bit",
          },
        },
      } as T;
    }

    if (name === "pharo_launcher_image_create") {
      return { ok: true } as T;
    }

    if (name === "pharo_launcher_image_launch") {
      return { ok: true } as T;
    }

    if (name === "pharo_launcher_process_list") {
      return {
        ok: true,
        data: [
          {
            pid: 4321,
            imageName: "MyProject-dev-rescue",
            commandLine: "Pharo MyProject-dev-rescue.image",
          },
        ],
      } as T;
    }

    throw new Error(`Unexpected launcher tool: ${name}`);
  }
}

class FakeImageMcpClient implements ImageRescueMcpClient {
  readonly calls: Array<{
    imageId: string;
    toolName: string;
    argumentsValue: Record<string, unknown>;
  }> = [];

  async callTool(
    image: ProjectImageState,
    toolName: string,
    argumentsValue: Record<string, unknown>,
  ): Promise<unknown> {
    this.calls.push({ imageId: image.id, toolName, argumentsValue });

    if (toolName === "manage-change-history") {
      if (argumentsValue.operation === "listEntries") {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                entries: [{ index: 1 }, { index: 2 }, { index: 3 }],
              }),
            },
          ],
        };
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ applied: true }),
          },
        ],
      };
    }

    throw new Error(`Unexpected image MCP tool: ${toolName}`);
  }
}

class FakeHealthClient implements PharoMcpHealthClient {
  async check(): Promise<boolean> {
    return true;
  }
}

function makeTempDir(prefix: string): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(tempDir);
  return tempDir;
}

function writeProjectConfig(projectRoot: string): void {
  fs.writeFileSync(
    path.join(projectRoot, "plexus.project.json"),
    JSON.stringify(
      {
        name: "my-project",
        kanban: {
          provider: "vibe-kanban",
          projectId: "project-123",
        },
        images: [
          {
            id: "dev",
            imageName: "MyProject-dev",
            active: true,
            mcp: {
              port: 7123,
              loadScript: "pharo/load-mcp.st",
            },
          },
        ],
      },
      null,
      2,
    ),
    "utf8",
  );
}

function statePath(stateRoot: string): string {
  return path.join(
    stateRoot,
    "projects",
    "project-123",
    "workspaces",
    "worktree-a",
    "state.json",
  );
}

function writeState(stateRoot: string, images: ProjectImageState[]): ProjectState {
  const state: ProjectState = {
    projectId: "project-123",
    projectName: "my-project",
    workspaceId: "worktree-a",
    targetId: "project-123--worktree-a",
    updatedAt: "2026-05-11T10:00:00.000Z",
    images,
  };

  saveProjectState(statePath(stateRoot), state);
  return state;
}

function writeOmbu(imagesDir: string, imageName: string): string {
  const ombuDir = path.join(imagesDir, imageName, "pharo-local", "ombu-sessions");
  fs.mkdirSync(ombuDir, { recursive: true });
  const filePath = path.join(ombuDir, "changes.ombu");
  fs.writeFileSync(filePath, "ombu", "utf8");
  return filePath;
}

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("image rescue", () => {
  it("plans rescue from source image metadata and ombu files", async () => {
    const projectRoot = makeTempDir("plexus-project-");
    const stateRoot = makeTempDir("plexus-state-");
    const imagesDir = makeTempDir("plexus-images-");
    writeProjectConfig(projectRoot);
    writeState(stateRoot, [
      {
        id: "dev",
        imageName: "MyProject-dev",
        assignedPort: 7123,
        status: "stopped",
      },
    ]);
    const ombuPath = writeOmbu(imagesDir, "MyProject-dev");

    const result = await rescueImage({
      operation: "plan",
      projectRoot,
      stateRoot,
      workspaceId: "worktree-a",
      sourceImageId: "dev",
      pharoLauncherMcpClient: new FakeLauncherClient(imagesDir),
      now: () => new Date("2026-05-11T10:00:00.000Z"),
    });

    expect(result.ok).toBe(true);
    expect(result.historyDirectoryPath).toBe(
      path.join(imagesDir, "MyProject-dev", "pharo-local", "ombu-sessions"),
    );
    expect(result.historyFiles).toEqual([
      expect.objectContaining({
        path: ombuPath,
        size: 4,
      }),
    ]);
    expect(result.selectedHistoryFilePath).toBe(ombuPath);
  });

  it("prepares and launches a fresh target image from the source template", async () => {
    const projectRoot = makeTempDir("plexus-project-");
    const stateRoot = makeTempDir("plexus-state-");
    const imagesDir = makeTempDir("plexus-images-");
    writeProjectConfig(projectRoot);
    writeState(stateRoot, [
      {
        id: "dev",
        imageName: "MyProject-dev",
        assignedPort: 7123,
        status: "stopped",
      },
    ]);
    const launcher = new FakeLauncherClient(imagesDir);

    const result = await rescueImage({
      operation: "prepareTarget",
      projectRoot,
      stateRoot,
      workspaceId: "worktree-a",
      sourceImageId: "dev",
      targetImageName: "MyProject-dev-rescue",
      pharoLauncherMcpClient: launcher,
      healthClient: new FakeHealthClient(),
      now: () => new Date("2026-05-11T10:00:00.000Z"),
      sleep: async () => {},
      poll: {
        intervalMs: 0,
      },
    });

    expect(result.targetImage).toMatchObject({
      id: "dev-rescue",
      imageName: "MyProject-dev-rescue",
      assignedPort: 7100,
      pid: 4321,
      status: "running",
    });
    expect(launcher.calls).toContainEqual({
      name: "pharo_launcher_image_create",
      argumentsValue: {
        newImageName: "MyProject-dev-rescue",
        templateName: "Pharo 13.0 - 64bit",
        noLaunch: true,
      },
    });
  });

  it("applies selected history entries while excluding suspected indexes", async () => {
    const projectRoot = makeTempDir("plexus-project-");
    const stateRoot = makeTempDir("plexus-state-");
    const imagesDir = makeTempDir("plexus-images-");
    writeProjectConfig(projectRoot);
    const ombuPath = writeOmbu(imagesDir, "MyProject-dev");
    writeState(stateRoot, [
      {
        id: "dev",
        imageName: "MyProject-dev",
        assignedPort: 7123,
        status: "stopped",
      },
      {
        id: "dev-rescue",
        imageName: "MyProject-dev-rescue",
        assignedPort: 7100,
        status: "running",
      },
    ]);
    const imageMcpClient = new FakeImageMcpClient();

    const result = await rescueImage({
      operation: "applyPlan",
      projectRoot,
      stateRoot,
      workspaceId: "worktree-a",
      sourceImageId: "dev",
      targetImageId: "dev-rescue",
      historyFilePath: ombuPath,
      exclude: {
        indexes: [2],
      },
      confirm: true,
      pharoLauncherMcpClient: new FakeLauncherClient(imagesDir),
      imageMcpClient,
      now: () => new Date("2026-05-11T10:00:00.000Z"),
    });

    expect(result.ok).toBe(true);
    expect(result.changeResult).toMatchObject({
      status: "applied",
      arguments: {
        operation: "applyEntries",
        indexes: [1, 3],
        confirm: true,
      },
    });
    expect(imageMcpClient.calls.map((call) => call.argumentsValue.operation)).toEqual([
      "listEntries",
      "applyEntries",
    ]);
  });
});
