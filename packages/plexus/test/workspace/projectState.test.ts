import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ProjectConfig } from "../../src/config/projectConfig.js";
import {
  createProjectState,
  defaultPlexusStateRoot,
  defaultWorkspaceId,
  loadProjectState,
  renderProjectImageName,
  projectStateDirectoryPath,
  projectStatePath,
  saveProjectState,
} from "../../src/workspace/projectState.js";

const config: ProjectConfig = {
  id: "project-123",
  name: "my-project",
  images: [
    {
      id: "dev",
      imageName: "MyProject-dev",
      mcp: {
        port: 7123,
        loadScript: "pharo/load-mcp.st",
      },
    },
    {
      id: "baseline",
      imageName: "MyProject-baseline",
      mcp: {
        port: 7124,
        loadScript: "pharo/load-mcp.st",
      },
    },
  ],
};

describe("project state", () => {
  it("keeps a workspace's state directly in its .plexus directory", () => {
    const projectRoot = path.join("C:", "dev", "code", "git", "my-project");

    expect(defaultPlexusStateRoot(projectRoot)).toBe(
      path.win32.join(projectRoot, ".plexus"),
    );
    expect(projectStateDirectoryPath({ projectRoot })).toBe(
      path.win32.join(projectRoot, ".plexus"),
    );
    expect(projectStatePath({ projectRoot })).toBe(
      path.win32.join(projectRoot, ".plexus", "state.json"),
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
      expect(projectStatePath({ projectRoot, stateRoot })).toBe(
        pathApi.join(stateRoot, "state.json"),
      );
    },
  );

  it("allows callers to keep runtime state outside the project root", () => {
    const projectRoot = path.join("C:", "dev", "code", "git", "my-project");
    const stateRoot = path.join("C:", "dev", "plexus-state");

    expect(projectStatePath({ projectRoot, stateRoot })).toBe(
      path.win32.join(stateRoot, "state.json"),
    );
  });

  it("creates stopped runtime records for declared project images", () => {
    expect(createProjectState(config, "2026-04-25T10:00:00.000Z")).toEqual({
      projectId: "project-123",
      projectName: "my-project",
      workspaceId: "default",
      runtimeStatus: "idle",
      updatedAt: "2026-04-25T10:00:00.000Z",
      images: [
        {
          id: "dev",
          imageName: "MyProject-dev",
          status: "stopped",
        },
        {
          id: "baseline",
          imageName: "MyProject-baseline",
          status: "stopped",
        },
      ],
    });
  });

  it("records configured image display mode in runtime image state", () => {
    const state = createProjectState(
      {
        ...config,
        images: [
          {
            ...config.images[0],
            displayMode: "interactive",
          },
          config.images[1],
        ],
      },
      "2026-04-25T10:00:00.000Z",
    );

    expect(state.images[0]).toMatchObject({
      id: "dev",
      displayMode: "interactive",
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
          supportedMajorVersions: [12, 13, 14, 15],
        }),
      }),
      expect.objectContaining({
        id: "current",
        pharoVersion: "13",
        pharoMcpContract: expect.objectContaining({
          status: "matching",
          actualMajorVersion: 13,
          supportedMajorVersions: [12, 13, 14, 15],
        }),
      }),
    ]);
    expect(state.images[0]).not.toHaveProperty("assignedPort");
  });




  it("does not let unsupported configured MCP ports reserve the dynamic range", () => {
    const state = createProjectState(
      {
        ...config,
        images: [
          {
            id: "legacy",
            imageName: "MyProject-legacy",
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
            mcp: {
              port: 7100,
              loadScript: "pharo/load-mcp.st",
              startupMode: "disabled",
            },
          },
          {
            id: "current",
            imageName: "MyProject-current",
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
      },
    );

    expect(state.images[0]).not.toHaveProperty("assignedPort");
    expect(state.images[1]).toMatchObject({
      id: "current",
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
        status: "stopped",
      },
      {
        id: "baseline",
        imageName: "MyProject-baseline",
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
          updatedAt: "2026-04-25T09:00:00.000Z",
          images: [
            {
              id: "baseline",
              imageName: "MyProject-baseline",
              status: "stopped",
            },
          ],
        },
      }).images[1],
    ).toEqual({
      id: "baseline",
      imageName: "MyProject-baseline",
      status: "stopped",
    });
  });

  it("preserves previous image leases when rebuilding runtime state", () => {
    expect(
      createProjectState(config, {
        updatedAt: "2026-04-25T10:00:00.000Z",
        workspaceId: "worktree-a",
        previousState: {
          projectId: "project-123",
          projectName: "my-project",
          workspaceId: "worktree-a",
          updatedAt: "2026-04-25T09:00:00.000Z",
          images: [
            {
              id: "dev",
              imageName: "MyProject-dev",
              status: "running",
              lease: {
                ownerId: "workspace-a",
                ownerKind: "workspace",
                mode: "mutable",
                purpose: "Work on issue 24",
                createdAt: "2026-04-25T09:00:00.000Z",
                heartbeatAt: "2026-04-25T09:30:00.000Z",
              },
            },
          ],
        },
      }).images[0].lease,
    ).toEqual({
      ownerId: "workspace-a",
      ownerKind: "workspace",
      mode: "mutable",
      purpose: "Work on issue 24",
      createdAt: "2026-04-25T09:00:00.000Z",
      heartbeatAt: "2026-04-25T09:30:00.000Z",
    });
  });


  it("persists runtime state with allocated ports", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "plexus-state-"));
    const filePath = path.join(
      tempRoot,
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
  });

  it("renders image names from runtime identity tokens", () => {
    expect(
      renderProjectImageName("PLexus-{workspaceId}-{imageId}", {
        projectId: "project-123",
        projectName: "my-project",
        workspaceId: "worktree-a",
        imageId: "dev",
      }),
    ).toBe("PLexus-worktree-a-dev");
  });

});
