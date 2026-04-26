import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ProjectConfig } from "./projectConfig.js";
import {
  createProjectState,
  defaultPlexusStateRoot,
  defaultTargetId,
  defaultWorkspaceId,
  loadProjectState,
  PortAllocationError,
  renderProjectImageName,
  projectStateDirectoryPath,
  projectStatePath,
  projectStatePathForConfig,
  saveProjectState,
} from "./projectState.js";

const config: ProjectConfig = {
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
    {
      id: "baseline",
      imageName: "MyProject-baseline",
      active: false,
      mcp: {
        port: 7124,
        loadScript: "pharo/load-mcp.st",
      },
    },
  ],
};

describe("project state", () => {
  it("resolves the default runtime state path under .plexus", () => {
    const projectRoot = path.join("C:", "dev", "code", "git", "my-project");

    expect(defaultPlexusStateRoot(projectRoot)).toBe(
      path.join(projectRoot, ".plexus"),
    );
    expect(
      projectStateDirectoryPath({
        projectRoot,
        projectId: "project-123",
      }),
    ).toBe(
      path.join(
        projectRoot,
        ".plexus",
        "projects",
        "project-123",
        "workspaces",
        "my-project",
      ),
    );
    expect(
      projectStatePath({
        projectRoot,
        projectId: "project-123",
      }),
    ).toBe(
      path.join(
        projectRoot,
        ".plexus",
        "projects",
        "project-123",
        "workspaces",
        "my-project",
        "state.json",
      ),
    );
  });

  it("allows callers to keep runtime state outside the project root", () => {
    const projectRoot = path.join("C:", "dev", "code", "git", "my-project");
    const stateRoot = path.join("C:", "dev", "plexus-state");

    expect(
      projectStatePath({
        projectRoot,
        projectId: "project-123",
        stateRoot,
      }),
    ).toBe(
      path.join(
        stateRoot,
        "projects",
        "project-123",
        "workspaces",
        "my-project",
        "state.json",
      ),
    );
  });

  it("resolves runtime state paths from project config", () => {
    const projectRoot = path.join("C:", "dev", "code", "git", "my-project");

    expect(projectStatePathForConfig({ projectRoot, config })).toBe(
      path.join(
        projectRoot,
        ".plexus",
        "projects",
        "project-123",
        "workspaces",
        "my-project",
        "state.json",
      ),
    );
  });

  it("creates runtime image state from active project images", () => {
    expect(createProjectState(config, "2026-04-25T10:00:00.000Z")).toEqual({
      projectId: "project-123",
      projectName: "my-project",
      workspaceId: "default",
      targetId: "project-123--default",
      updatedAt: "2026-04-25T10:00:00.000Z",
      images: [
        {
          id: "dev",
          imageName: "MyProject-dev",
          assignedPort: 7123,
          status: "starting",
        },
        {
          id: "baseline",
          imageName: "MyProject-baseline",
          assignedPort: 7124,
          status: "stopped",
        },
      ],
    });
  });

  it("allocates missing image ports from the prototype range", () => {
    const dynamicConfig: ProjectConfig = {
      ...config,
      images: [
        config.images[0],
        {
          ...config.images[1],
          mcp: {
            loadScript: "pharo/load-mcp.st",
          },
        },
      ],
    };

    expect(
      createProjectState(dynamicConfig, {
        updatedAt: "2026-04-25T10:00:00.000Z",
        workspaceId: "worktree-a",
      }).images,
    ).toEqual([
      {
        id: "dev",
        imageName: "MyProject-dev",
        assignedPort: 7123,
        status: "starting",
      },
      {
        id: "baseline",
        imageName: "MyProject-baseline",
        assignedPort: 7100,
        status: "stopped",
      },
    ]);
  });

  it("reuses previous runtime allocations for unconfigured image ports", () => {
    const dynamicConfig: ProjectConfig = {
      ...config,
      images: [
        config.images[0],
        {
          ...config.images[1],
          mcp: {
            loadScript: "pharo/load-mcp.st",
          },
        },
      ],
    };

    expect(
      createProjectState(dynamicConfig, {
        updatedAt: "2026-04-25T10:00:00.000Z",
        workspaceId: "worktree-a",
        previousState: {
          projectId: "project-123",
          projectName: "my-project",
          workspaceId: "worktree-a",
          targetId: "project-123--worktree-a",
          updatedAt: "2026-04-25T09:00:00.000Z",
          images: [
            {
              id: "baseline",
              imageName: "MyProject-baseline",
              assignedPort: 7130,
              status: "stopped",
            },
          ],
        },
      }).images[1],
    ).toEqual({
      id: "baseline",
      imageName: "MyProject-baseline",
      assignedPort: 7130,
      status: "stopped",
    });
  });

  it("fails when dynamic port allocation exhausts the range", () => {
    const dynamicConfig: ProjectConfig = {
      ...config,
      images: [
        {
          ...config.images[0],
          mcp: {
            loadScript: "pharo/load-mcp.st",
          },
        },
        {
          ...config.images[1],
          mcp: {
            loadScript: "pharo/load-mcp.st",
          },
        },
      ],
    };

    expect(() =>
      createProjectState(dynamicConfig, {
        workspaceId: "worktree-a",
        portRange: {
          start: 7100,
          end: 7100,
        },
      }),
    ).toThrow(PortAllocationError);
  });

  it("persists runtime state with allocated ports", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "plexus-state-"));
    const filePath = path.join(
      tempRoot,
      "projects",
      "project-123",
      "workspaces",
      "worktree-a",
      "state.json",
    );
    const state = createProjectState(config, {
      updatedAt: "2026-04-25T10:00:00.000Z",
      workspaceId: "worktree-a",
    });

    try {
      expect(loadProjectState(filePath)).toBeUndefined();

      saveProjectState(filePath, state);

      expect(loadProjectState(filePath)).toEqual(state);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("derives stable runtime identity from worktree paths", () => {
    const projectRoot = path.join("C:", "dev", "code", "git", "PLexus-task-123");

    expect(defaultWorkspaceId(projectRoot)).toBe("PLexus-task-123");
    expect(defaultTargetId("project-123", "PLexus-task-123")).toBe(
      "project-123--PLexus-task-123",
    );
  });

  it("renders image names from runtime identity tokens", () => {
    expect(
      renderProjectImageName("PLexus-{workspaceId}-{imageId}", {
        projectId: "project-123",
        projectName: "my-project",
        workspaceId: "worktree-a",
        targetId: "project-123--worktree-a",
        imageId: "dev",
      }),
    ).toBe("PLexus-worktree-a-dev");
  });

  it("allocates around ports reserved by sibling workspaces", () => {
    const dynamicConfig: ProjectConfig = {
      ...config,
      images: [
        {
          ...config.images[0],
          mcp: {
            loadScript: "pharo/load-mcp.st",
          },
        },
      ],
    };

    expect(
      createProjectState(dynamicConfig, {
        workspaceId: "worktree-b",
        reservedPorts: [7100],
        updatedAt: "2026-04-25T10:00:00.000Z",
      }).images[0].assignedPort,
    ).toBe(7101);
  });
});
