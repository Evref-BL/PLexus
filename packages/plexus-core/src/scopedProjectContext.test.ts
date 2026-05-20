import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ProjectConfig } from "./projectConfig.js";
import type { ProjectState } from "./projectState.js";
import {
  buildScopedProjectContext,
  buildScopedProjectContextDiagnostics,
  ScopedProjectContextError,
} from "./scopedProjectContext.js";

const projectConfig: ProjectConfig = {
  id: "project-123",
  name: "my-project",
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
        projectId: "project-123",
        projectName: "my-project",
        workspaceId: "task-123",
        targetId: "target-123",
      },
      images: [
        {
          imageId: "dev",
          status: "running",
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
    expect(context.images[0]).not.toHaveProperty("launcherImageName");
    expect(context.images[0]).not.toHaveProperty("assignedPort");
    expect(context.images[0]).not.toHaveProperty("pid");
    expect(context.images[0]).not.toHaveProperty("cleanup");

    const contextJson = JSON.stringify(context);
    expect(contextJson).not.toContain("MyProject-task-123-dev");
    expect(contextJson).not.toContain("7123");
    expect(contextJson).not.toContain("1234");
    expect(contextJson).not.toContain("C:\\Users\\me\\Pharo\\images");
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
      openInteractive: {
        allowed: false,
        reason:
          "Stop the headless runtime before interactive open to avoid two processes using the same image",
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
    const interactiveContext = buildScopedProjectContext({
      projectRoot,
      projectConfig: {
        ...projectConfig,
        images: [
          ...projectConfig.images,
          {
            id: "preview",
            imageName: "MyProject-{workspaceId}-preview",
            active: true,
          },
        ],
      },
      workspaceId: "task-123",
      targetId: "target-123",
      stateRoot,
      projectState,
    });
    expect(interactiveContext.images[2].affordances.openInteractive).toEqual({
      allowed: true,
      toolName: "pharo_launcher_image_open_interactive",
      arguments: {
        imageId: "preview",
      },
    });
    expect(JSON.stringify(context.images[0].affordances)).not.toContain("pid");
    expect(JSON.stringify(context.images[0].affordances)).not.toContain(
      "launcherImageName",
    );
  });

  it("keeps raw launcher and cleanup metadata in diagnostics", () => {
    const diagnostics = buildScopedProjectContextDiagnostics({
      projectRoot,
      projectConfig,
      workspaceId: "task-123",
      targetId: "target-123",
      stateRoot,
      projectState,
    });

    expect(diagnostics.scope).toEqual({
      projectRoot: path.win32.resolve(projectRoot),
      projectId: "project-123",
      projectName: "my-project",
      workspaceId: "task-123",
      targetId: "target-123",
      stateRoot: path.win32.resolve(stateRoot),
      statePath,
    });
    expect(diagnostics.images[0]).toMatchObject({
      imageId: "dev",
      launcherImageName: "MyProject-task-123-dev",
      assignedPort: 7123,
      pid: 1234,
    });
    expect(diagnostics.images[0].cleanup).toEqual({
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

  it("includes repository workspace preservation metadata in cleanup diagnostics", () => {
    const diagnostics = buildScopedProjectContextDiagnostics({
      projectRoot,
      projectConfig,
      workspaceId: "task-123",
      targetId: "target-123",
      stateRoot,
      projectState: {
        ...projectState,
        images: [
          {
            ...projectState.images[0],
            repositoryWorkspace: {
              repository: {
                id: "my-project",
              },
              path: "C:\\Users\\me\\Pharo\\images\\pharo-local\\iceberg\\my-project",
              materializationStrategy: "copy",
              sourceDirectory: "src",
              baseline: "MyProject",
              materializationState: "ready",
              diagnostics: [],
              dirtyState: "dirty",
              loadState: "loaded",
              cleanupState: {
                policy: "preserve",
                decision: "preserved",
                imageId: "dev",
                repositoryId: "my-project",
                path: "C:\\Users\\me\\Pharo\\images\\pharo-local\\iceberg\\my-project",
                dirtyState: "dirty",
                recordedAt: "2026-05-16T11:00:00.000Z",
              },
            },
          },
        ],
      },
    });

    expect(diagnostics.images[0].cleanup.repositoryWorkspace).toEqual({
      path: "C:\\Users\\me\\Pharo\\images\\pharo-local\\iceberg\\my-project",
      dirtyState: "dirty",
      defaultPolicy: "preserve",
      destructivePolicyRequired: true,
      lastDecision: {
        policy: "preserve",
        decision: "preserved",
        imageId: "dev",
        repositoryId: "my-project",
        path: "C:\\Users\\me\\Pharo\\images\\pharo-local\\iceberg\\my-project",
        dirtyState: "dirty",
        recordedAt: "2026-05-16T11:00:00.000Z",
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
        "Read images[].imageId from this scoped context",
      recordHint:
        "Store the selected imageId with the scoped project/workspace/target before calling gateway tools",
    });
  });

  it("reports planned image-local repository workspaces before image launch", () => {
    const context = buildScopedProjectContext({
      projectRoot,
      projectConfig: {
        ...projectConfig,
        images: [
          {
            ...projectConfig.images[0],
            repositoryWorkspace: {
              repository: {
                id: "my-project",
                componentId: "my-project",
              },
              sourceDirectory: "src",
              baseline: "MyProject",
              materialization: {
                strategy: "copy",
              },
            },
          },
        ],
      },
      workspaceId: "task-123",
      targetId: "target-123",
      stateRoot,
    });

    expect(context.images[0]).toMatchObject({
      imageId: "dev",
      status: "declared",
      repositoryWorkspace: {
        repository: {
          id: "my-project",
          componentId: "my-project",
        },
        path: "image-local://dev/pharo-local/iceberg/my-project",
        materializationStrategy: "copy",
        sourceDirectory: "src",
        baseline: "MyProject",
        dirtyState: "unknown",
        loadState: "not-loaded",
      },
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
