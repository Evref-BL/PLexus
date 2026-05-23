import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ProjectConfig, ProjectRuntimePolicy } from "./projectConfig.js";
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
  id: "project-123",
  name: "my-project",
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

function defaultRuntimePolicy(): ProjectRuntimePolicy {
  return {
    scope: "project",
    stateRoot: {
      mode: "project-local",
    },
    gateway: {
      mode: "project-local",
      host: "127.0.0.1",
      portRange: {
        start: 8_133,
        end: 8_199,
      },
      agentMcpPath: "/mcp",
      routeControlMcpPath: "/control-mcp",
    },
    imagePorts: {
      allocation: "configured-or-dynamic",
      range: {
        start: 7_100,
        end: 7_199,
      },
      coordination: {
        mode: "host-local",
      },
    },
    launcherProfile: {
      mode: "project-owned",
    },
    pharoMcp: {
      metadataKey: "io.github.evref-bl/pharo",
      supportedMajorVersions: [12, 13, 14],
    },
  };
}

describe("project state", () => {
  it("resolves the default runtime state path under .plexus", () => {
    const projectRoot = path.join("C:", "dev", "code", "git", "my-project");

    expect(defaultPlexusStateRoot(projectRoot)).toBe(
      path.win32.join(projectRoot, ".plexus"),
    );
    expect(
      projectStateDirectoryPath({
        projectRoot,
        projectId: "project-123",
      }),
    ).toBe(
      path.win32.join(
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
      path.win32.join(
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

  it.each([
    [
      "Windows",
      "C:\\dev\\code\\git\\my-project",
      "C:\\dev\\code\\git\\.plexus-state",
      path.win32,
    ],
    [
      "POSIX",
      "/srv/git/my-project",
      "/srv/git/.plexus-state",
      path.posix,
    ],
  ])(
    "preserves %s absolute path style when generating runtime state paths",
    (_style, projectRoot, stateRoot, pathApi) => {
      expect(defaultWorkspaceId(projectRoot)).toBe("my-project");
      expect(defaultPlexusStateRoot(projectRoot)).toBe(
        pathApi.join(projectRoot, ".plexus"),
      );
      expect(
        projectStatePath({
          projectRoot,
          projectId: "project-123",
          stateRoot,
        }),
      ).toBe(
        pathApi.join(
          stateRoot,
          "projects",
          "project-123",
          "workspaces",
          "my-project",
          "state.json",
        ),
      );
    },
  );

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
      path.win32.join(
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
      path.win32.join(
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

  it("uses external runtime state root policy from project config", () => {
    const projectRoot = path.join("C:", "dev", "code", "git", "my-project");
    const runtimeConfig: ProjectConfig = {
      ...config,
      runtime: {
        ...defaultRuntimePolicy(),
        stateRoot: {
          mode: "external",
          path: path.join("C:", "dev", "plexus-state"),
        },
      },
    };

    expect(projectStatePathForConfig({ projectRoot, config: runtimeConfig })).toBe(
      path.win32.join(
        "C:",
        "dev",
        "plexus-state",
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
      runtimeStatus: "starting",
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

  it("records Pharo MCP support state from known template versions", () => {
    const state = createProjectState(
      {
        ...config,
        images: [
          {
            id: "legacy",
            imageName: "MyProject-legacy",
            active: true,
            create: {
              kind: "template",
              templateName: "Pharo 11.0 - 64bit",
            },
            mcp: {
              port: 7123,
              loadScript: "pharo/load-mcp.st",
            },
          },
          {
            id: "current",
            imageName: "MyProject-current",
            active: true,
            create: {
              kind: "template",
              templateName: "Pharo 13.0 - 64bit",
            },
            mcp: {
              port: 7124,
              loadScript: "pharo/load-mcp.st",
            },
          },
        ],
      },
      "2026-04-25T10:00:00.000Z",
    );

    expect(state.images).toEqual([
      expect.objectContaining({
        id: "legacy",
        pharoVersion: "11",
        pharoMcpContract: expect.objectContaining({
          status: "unsupported",
          actualMajorVersion: 11,
          supportedMajorVersions: [12, 13, 14],
        }),
      }),
      expect.objectContaining({
        id: "current",
        assignedPort: 7124,
        pharoVersion: "13",
        pharoMcpContract: expect.objectContaining({
          status: "matching",
          actualMajorVersion: 13,
          supportedMajorVersions: [12, 13, 14],
        }),
      }),
    ]);
    expect(state.images[0]).not.toHaveProperty("assignedPort");
  });

  it("plans image-local repository workspace state without launching images", () => {
    const state = createProjectState(
      {
        ...config,
        images: [
          {
            ...config.images[0],
            imageName: "MyProject-{workspaceId}-{imageId}",
            repositoryWorkspace: {
              repository: {
                id: "my-project",
                componentId: "my-project",
                remoteUrl: "git@github.com:Example/MyProject.git",
              },
              sourceDirectory: "src",
              baseline: "MyProject",
              loadGroup: "dev",
              pharoVersion: 13,
              templateName: "Pharo 13.0 - 64bit",
              branch: "task/image-workspace",
              baseBranch: "main",
              baseCommit: "abc123",
              materialization: {
                strategy: "copy",
              },
            },
          },
        ],
      },
      {
        updatedAt: "2026-04-25T10:00:00.000Z",
        workspaceId: "task-123",
      },
    );

    expect(state.images[0]).toMatchObject({
      id: "dev",
      imageName: "MyProject-task-123-dev",
      repositoryWorkspace: {
        repository: {
          id: "my-project",
          componentId: "my-project",
          remoteUrl: "git@github.com:Example/MyProject.git",
        },
        path: "image-local://dev/pharo-local/iceberg/my-project",
        materializationStrategy: "copy",
        sourceDirectory: "src",
        baseline: "MyProject",
        loadGroup: "dev",
        pharoVersion: 13,
        templateName: "Pharo 13.0 - 64bit",
        branch: "task/image-workspace",
        baseBranch: "main",
        baseCommit: "abc123",
        dirtyState: "unknown",
        loadState: "not-loaded",
      },
    });
  });

  it("renders configured image-local repository workspace path templates", () => {
    const state = createProjectState(
      {
        ...config,
        images: [
          {
            ...config.images[0],
            repositoryWorkspace: {
              repository: {
                id: "my-project",
                originPath: "C:\\dev\\sources\\my-project",
              },
              sourceDirectory: "src",
              baseline: "MyProject",
              materialization: {
                strategy: "git-worktree",
                path: "C:\\dev\\plexus\\{workspaceId}\\{imageId}\\{repositoryId}",
              },
            },
          },
        ],
      },
      {
        updatedAt: "2026-04-25T10:00:00.000Z",
        workspaceId: "task-123",
      },
    );

    expect(state.images[0].repositoryWorkspace).toMatchObject({
      path: "C:\\dev\\plexus\\task-123\\dev\\my-project",
      materializationStrategy: "git-worktree",
      dirtyState: "unknown",
      loadState: "not-loaded",
    });
  });

  it("does not let unsupported configured MCP ports reserve the dynamic range", () => {
    const state = createProjectState(
      {
        ...config,
        images: [
          {
            id: "legacy",
            imageName: "MyProject-legacy",
            active: true,
            create: {
              kind: "template",
              templateName: "Pharo 11.0 - 64bit",
            },
            mcp: {
              port: 7100,
              loadScript: "pharo/load-mcp.st",
            },
          },
          {
            id: "current",
            imageName: "MyProject-current",
            active: true,
            create: {
              kind: "template",
              templateName: "Pharo 13.0 - 64bit",
            },
            mcp: {
              loadScript: "pharo/load-mcp.st",
            },
          },
        ],
      },
      {
        updatedAt: "2026-04-25T10:00:00.000Z",
        portRange: {
          start: 7100,
          end: 7100,
        },
      },
    );

    expect(state.images).toEqual([
      expect.objectContaining({
        id: "legacy",
        pharoMcpContract: expect.objectContaining({
          status: "unsupported",
        }),
      }),
      expect.objectContaining({
        id: "current",
        assignedPort: 7100,
        pharoMcpContract: expect.objectContaining({
          status: "matching",
        }),
      }),
    ]);
    expect(state.images[0]).not.toHaveProperty("assignedPort");
  });

  it("does not allocate or reserve image MCP ports when startup is disabled", () => {
    const state = createProjectState(
      {
        ...config,
        images: [
          {
            id: "plain",
            imageName: "MyProject-plain",
            active: true,
            mcp: {
              port: 7100,
              loadScript: "pharo/load-mcp.st",
              startupMode: "disabled",
            },
          },
          {
            id: "current",
            imageName: "MyProject-current",
            active: true,
            create: {
              kind: "template",
              templateName: "Pharo 13.0 - 64bit",
            },
            mcp: {
              loadScript: "pharo/load-mcp.st",
            },
          },
        ],
      },
      {
        updatedAt: "2026-04-25T10:00:00.000Z",
        portRange: {
          start: 7100,
          end: 7100,
        },
      },
    );

    expect(state.images[0]).not.toHaveProperty("assignedPort");
    expect(state.images[1]).toMatchObject({
      id: "current",
      assignedPort: 7100,
    });
  });

  it("creates idle runtime state for projects with no images", () => {
    const zeroImageConfig: ProjectConfig = {
      ...config,
      images: [],
    };

    expect(
      createProjectState(zeroImageConfig, "2026-04-25T10:00:00.000Z"),
    ).toEqual({
      projectId: "project-123",
      projectName: "my-project",
      workspaceId: "default",
      targetId: "project-123--default",
      runtimeStatus: "idle",
      updatedAt: "2026-04-25T10:00:00.000Z",
      images: [],
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

  it("allocates missing image ports from the runtime policy range", () => {
    const dynamicConfig: ProjectConfig = {
      ...config,
      runtime: {
        ...defaultRuntimePolicy(),
        imagePorts: {
          ...defaultRuntimePolicy().imagePorts,
          range: {
            start: 7_200,
            end: 7_201,
          },
        },
      },
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

    expect(
      createProjectState(dynamicConfig, {
        updatedAt: "2026-04-25T10:00:00.000Z",
        workspaceId: "worktree-a",
      }).images.map((image) => image.assignedPort),
    ).toEqual([7_200, 7_201]);
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
