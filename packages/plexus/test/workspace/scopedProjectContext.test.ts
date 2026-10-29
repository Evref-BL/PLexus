import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ProjectConfig } from "../../src/config/projectConfig.js";
import type { ProjectState } from "../../src/workspace/projectState.js";
import {
  buildScopedProjectContext,
  buildScopedProjectContextDiagnostics,
  ScopedProjectContextError,
} from "../../src/workspace/scopedProjectContext.js";

const projectConfig: ProjectConfig = {
  id: "project-123",
  name: "my-project",
  images: [
    {
      id: "dev",
      imageName: "MyProject-{workspaceId}-dev",
      mcp: {
        loadScript: "pharo/load-mcp.st",
      },
      create: {
        kind: "template",
        profileId: "pharo-13-default",
        templateName: "Pharo 13.0 - 64bit",
        templateCategory: "Official",
      },
    },
    {
      id: "baseline",
      imageName: "MyProject-{workspaceId}-baseline",
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
  updatedAt: "2026-05-16T10:00:00.000Z",
  images: [
    {
      id: "dev",
      imageName: "MyProject-task-123-dev",
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
      status: "stopped",
    },
  ],
};

describe("scoped project context", () => {
  it("models project, workspace, and image ownership context", () => {
    const context = buildScopedProjectContext({
      projectRoot,
      projectConfig,
      workspaceId: "task-123",
      stateRoot,
      projectState,
    });

    expect(context).toMatchObject({
      schemaVersion: 1,
      scope: {
        projectId: "project-123",
        projectName: "my-project",
        workspaceId: "task-123",
      },
      workspace: {
        projectRoot: path.win32.resolve(projectRoot),
        source: {
          path: path.win32.resolve(projectRoot),
          policy: "caller-managed",
          defaultLoadSource: true,
        },
        state: {
          root: path.win32.resolve(stateRoot),
          path: statePath,
        },
        images: {
          declaration: "project-config",
          lifecycle: "scoped-affordances",
          handle: "imageId",
          creation: "project-policy",
        },
        routes: {
          policy: "pharo-gateway-workspace-route",
          serverName: "pharo_gateway",
          targetKey: "workspaceId",
          imageArgument: "mcpServerId",
        },
        cleanup: {
          policy: "workspace_cleanup_only",
          deletionSurface: "workspace-cleanup",
        },
      },
      images: [
        {
          imageId: "dev",
          status: "running",
          ownership: {
            projectId: "project-123",
            workspaceId: "task-123",
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

  it("allows callers to declare a workspace source path separately from the project root", () => {
    const sourcePath = "C:\\dev\\code\\git\\Project-feature-source";

    const context = buildScopedProjectContext({
      projectRoot,
      sourcePath,
      projectConfig,
      workspaceId: "task-123",
      stateRoot,
      projectState,
    });

    expect(context.workspace).toMatchObject({
      projectRoot: path.win32.resolve(projectRoot),
      source: {
        path: path.win32.resolve(sourcePath),
        policy: "caller-managed",
        defaultLoadSource: true,
      },
      state: {
        root: path.win32.resolve(stateRoot),
        path: statePath,
      },
    });
  });

  it("describes safe scoped lifecycle affordances without raw launcher mutation keys", () => {
    const context = buildScopedProjectContext({
      projectRoot,
      projectConfig,
      workspaceId: "task-123",
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
        allowed: true,
        toolName: "pharo_launcher_image_open_interactive",
        arguments: {
          imageId: "dev",
        },
      },
      show: {
        allowed: true,
        toolName: "pharo_launcher_image_show",
        arguments: {
          imageId: "dev",
        },
      },
      hide: {
        allowed: true,
        toolName: "pharo_launcher_image_hide",
        arguments: {
          imageId: "dev",
        },
      },
      stop: {
        allowed: true,
        toolName: "pharo_launcher_image_stop",
        arguments: {
          imageId: "dev",
          confirm: true,
        },
      },
      reset: {
        allowed: true,
        toolName: "pharo_launcher_image_reset",
        arguments: {
          imageId: "dev",
          confirm: true,
        },
      },
      delete: {
        allowed: false,
        reason:
          "Deletion is reserved for PLexus workspace cleanup policy, not the scoped launcher surface",
      },
    });
    // `active` says what project open starts by itself. It is not a gate: a
    // declared image can always be started, or there is no way to start it.
    expect(context.images[1].affordances.start).toMatchObject({
      allowed: true,
      toolName: "pharo_launcher_image_start",
    });
    // Reset is still denied, but on its own policy rather than on `active`.
    expect(context.images[1].affordances.reset.allowed).toBe(false);
    expect(context.images[1].affordances.reset.reason).not.toContain("inactive");
    const interactiveContext = buildScopedProjectContext({
      projectRoot,
      projectConfig: {
        ...projectConfig,
        images: [
          ...projectConfig.images,
          {
            id: "preview",
            imageName: "MyProject-{workspaceId}-preview",
          },
        ],
      },
      workspaceId: "task-123",
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
      stateRoot,
      projectState,
    });

    expect(diagnostics.scope).toEqual({
      projectRoot: path.win32.resolve(projectRoot),
      sourcePath: path.win32.resolve(projectRoot),
      projectId: "project-123",
      projectName: "my-project",
      workspaceId: "task-123",
      stateRoot: path.win32.resolve(stateRoot),
      statePath,
    });
    expect(diagnostics.workspace).toMatchObject({
      projectRoot: path.win32.resolve(projectRoot),
      source: {
        path: path.win32.resolve(projectRoot),
        policy: "caller-managed",
      },
      state: {
        root: path.win32.resolve(stateRoot),
        path: statePath,
      },
      cleanup: {
        policy: "workspace_cleanup_only",
      },
    });
    expect(diagnostics.images[0]).toMatchObject({
      imageId: "dev",
      launcherImageName: "MyProject-task-123-dev",
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


  it("includes gateway route metadata for the imageId consumed by Pharo tools", () => {
    const context = buildScopedProjectContext({
      projectRoot,
      projectConfig,
      workspaceId: "task-123",
      stateRoot,
      projectState,
    });

    expect(context.images[0].route).toEqual({
      serverName: "pharo_gateway",
      requiredArgument: "mcpServerId",
      mcpServerId: "dev",
      routeReference: {
        projectId: "project-123",
        workspaceId: "task-123",
      },
      mcpServerIdSource:
        "Read a server id from images[].mcpServers[] in this scoped context",
      recordHint:
        "Store the selected mcpServerId with the scoped project and workspace before calling pharo_gateway tools",
    });
  });


  it("rejects project state from a different workspace", () => {
    expect(() =>
      buildScopedProjectContext({
        projectRoot,
        projectConfig,
        workspaceId: "task-123",
        stateRoot,
        projectState: {
          ...projectState,
          workspaceId: "other-worktree",
        },
      }),
    ).toThrow(
      "Project state workspaceId other-worktree does not match scoped workspace task-123",
    );
  });

  it("rejects runtime images that are not declared in project config", () => {
    expect(() =>
      buildScopedProjectContext({
        projectRoot,
        projectConfig,
        workspaceId: "task-123",
        stateRoot,
        projectState: {
          ...projectState,
          images: [
            ...projectState.images,
            {
              id: "rogue",
              imageName: "Other",
              status: "running",
            },
          ],
        },
      }),
    ).toThrow("State image rogue is not declared in project config");
  });
});
