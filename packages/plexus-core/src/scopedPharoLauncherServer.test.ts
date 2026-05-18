import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ScopedPharoLauncher } from "./scopedPharoLauncherServer.js";

const tempDirs: string[] = [];

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

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("scoped pharo launcher facade", () => {
  it("reports the PLexus-owned launcher profile with scoped image listings", () => {
    const projectRoot = makeTempDir("plexus-project-");
    const stateRoot = makeTempDir("plexus-state-");
    writeProjectConfig(projectRoot);

    const result = new ScopedPharoLauncher({
      projectRoot,
      stateRoot,
      workspaceId: "worktree-a",
    }).listImages();

    expect(result).toMatchObject({
      scope: {
        projectId: "project-123",
        workspaceId: "worktree-a",
        targetId: "project-123--worktree-a",
      },
      launcherProfile: {
        ownership: "plexus-owned",
        mode: "project-owned",
        stateRoot: path.join(
          stateRoot,
          "profiles",
          "pharo-launcher-mcp",
          "project-123",
          "worktree-a",
          "project-123--worktree-a",
        ),
      },
      images: [
        {
          imageId: "dev",
          imageName: "MyProject-dev",
          status: "declared",
        },
      ],
    });
  });
});
