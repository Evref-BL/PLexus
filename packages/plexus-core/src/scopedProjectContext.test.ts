import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ProjectConfig } from "./projectConfig.js";
import type { ProjectState } from "./projectState.js";
import {
  buildScopedProjectContext,
  ScopedProjectContextError,
} from "./scopedProjectContext.js";

const projectConfig: ProjectConfig = {
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
        loadScript: "pharo/load-mcp.st",
      },
    },
    {
      id: "baseline",
      imageName: "MyProject-{workspaceId}-baseline",
      active: false,
      mcp: {
        loadScript: "pharo/load-mcp.st",
      },
    },
  ],
};

const projectRoot = "C:\\dev\\code\\git\\Project-worktree";
const stateRoot = "C:\\dev\\code\\git\\.plexus-state";
const statePath = path.win32.join(
  stateRoot,
  "projects",
  "project-123",
  "workspaces",
  "task-123",
  "state.json",
);

const projectState: ProjectState = {
  projectId: "project-123",
  projectName: "my-project",
  workspaceId: "task-123",
  targetId: "target-123",
  updatedAt: "2026-05-16T10:00:00.000Z",
  images: [
    {
      id: "dev",
      imageName: "MyProject-task-123-dev",
      assignedPort: 7123,
      pid: 1234,
      status: "running",
      imagePath: "C:\\Users\\me\\Pharo\\images\\MyProject-task-123-dev.image",
      imageDirectoryPath: "C:\\Users\\me\\Pharo\\images",
      changesPath: "C:\\Users\\me\\Pharo\\images\\MyProject-task-123-dev.changes",
      localDirectoryPath: "C:\\Users\\me\\Pharo\\images\\pharo-local",
      ombuDirectoryPath: "C:\\Users\\me\\Pharo\\images\\ombu",
    },
    {
      id: "baseline",
      imageName: "MyProject-task-123-baseline",
      assignedPort: 7124,
      status: "stopped",
    },
  ],
};

describe("scoped project context", () => {
  it("models project, workspace, target, and image ownership context", () => {
    const context = buildScopedProjectContext({
      projectRoot,
      projectConfig,
      workspaceId: "task-123",
      targetId: "target-123",
      stateRoot,
      projectState,
    });

    expect(context).toMatchObject({
      schemaVersion: 1,
      scope: {
        projectRoot: path.win32.resolve(projectRoot),
        projectId: "project-123",
        projectName: "my-project",
        workspaceId: "task-123",
        targetId: "target-123",
        stateRoot: path.win32.resolve(stateRoot),
        statePath,
      },
      images: [
        {
          imageId: "dev",
          launcherImageName: "MyProject-task-123-dev",
          status: "running",
          assignedPort: 7123,
          ownership: {
            projectId: "project-123",
            workspaceId: "task-123",
            targetId: "target-123",
            owned: true,
            disposable: true,
          },
        },
        {
          imageId: "baseline",
          launcherImageName: "MyProject-task-123-baseline",
          status: "stopped",
          ownership: {
            projectId: "project-123",
            workspaceId: "task-123",
            targetId: "target-123",
            owned: true,
            disposable: true,
          },
        },
      ],
    });
  });

  it("describes safe scoped lifecycle affordances without raw launcher mutation keys", () => {
    const context = buildScopedProjectContext({
      projectRoot,
      projectConfig,
      workspaceId: "task-123",
      targetId: "target-123",
      stateRoot,
      projectState,
    });

    expect(context.images[0].affordances).toEqual({
      create: {
        allowed: false,
        reason: "Image already has runtime state",
      },
      start: {
        allowed: false,
        reason: "Image is already running",
      },
      stop: {
        allowed: true,
        toolName: "pharo_launcher_image_stop",
        arguments: {
          imageId: "dev",
          confirm: true,
        },
      },
      delete: {
        allowed: false,
        reason:
          "Deletion is reserved for PLexus workspace cleanup policy, not the agent launcher surface",
      },
    });
    expect(context.images[1].affordances.start).toEqual({
      allowed: false,
      reason: "Image is inactive in project config",
    });
    expect(JSON.stringify(context.images[0].affordances)).not.toContain("pid");
    expect(JSON.stringify(context.images[0].affordances)).not.toContain(
      "launcherImageName",
    );
  });

  it("includes cleanup metadata for owned disposable images", () => {
    const context = buildScopedProjectContext({
      projectRoot,
      projectConfig,
      workspaceId: "task-123",
      targetId: "target-123",
      stateRoot,
      projectState,
    });

    expect(context.images[0].cleanup).toEqual({
      disposable: true,
      statePath,
      launcherImageName: "MyProject-task-123-dev",
      policy: "workspace_cleanup_only",
      paths: {
        imagePath: "C:\\Users\\me\\Pharo\\images\\MyProject-task-123-dev.image",
        imageDirectoryPath: "C:\\Users\\me\\Pharo\\images",
        changesPath: "C:\\Users\\me\\Pharo\\images\\MyProject-task-123-dev.changes",
        localDirectoryPath: "C:\\Users\\me\\Pharo\\images\\pharo-local",
        ombuDirectoryPath: "C:\\Users\\me\\Pharo\\images\\ombu",
      },
    });
  });

  it("includes gateway route metadata for the imageId consumed by Pharo tools", () => {
    const context = buildScopedProjectContext({
      projectRoot,
      projectConfig,
      workspaceId: "task-123",
      targetId: "target-123",
      stateRoot,
      projectState,
    });

    expect(context.images[0].route).toEqual({
      serverName: "gateway",
      requiredArgument: "imageId",
      imageId: "dev",
      routeReference: {
        projectId: "project-123",
        workspaceId: "task-123",
        targetId: "target-123",
      },
      imageIdSource:
        "Read images[].imageId from this scoped context or pharo-launcher image list",
      recordHint:
        "Store the selected imageId with the scoped project/workspace/target before calling gateway tools",
    });
  });

  it("rejects project state from a different workspace or target", () => {
    expect(() =>
      buildScopedProjectContext({
        projectRoot,
        projectConfig,
        workspaceId: "task-123",
        targetId: "target-123",
        stateRoot,
        projectState: {
          ...projectState,
          workspaceId: "other-worktree",
        },
      }),
    ).toThrow(ScopedProjectContextError);

    expect(() =>
      buildScopedProjectContext({
        projectRoot,
        projectConfig,
        workspaceId: "task-123",
        targetId: "target-123",
        stateRoot,
        projectState: {
          ...projectState,
          targetId: "other-target",
        },
      }),
    ).toThrow(
      "Project state targetId other-target does not match scoped target target-123",
    );
  });

  it("rejects runtime images that are not declared in project config", () => {
    expect(() =>
      buildScopedProjectContext({
        projectRoot,
        projectConfig,
        workspaceId: "task-123",
        targetId: "target-123",
        stateRoot,
        projectState: {
          ...projectState,
          images: [
            ...projectState.images,
            {
              id: "rogue",
              imageName: "Other",
              assignedPort: 7999,
              status: "running",
            },
          ],
        },
      }),
    ).toThrow("State image rogue is not declared in project config");
  });
});
