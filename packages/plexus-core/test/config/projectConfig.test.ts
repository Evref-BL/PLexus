import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadProjectConfig,
  parseProjectConfig,
  projectConfigPath,
  ProjectConfigError,
  plexusProjectConfigFileName,
} from "../../src/config/projectConfig.js";

const tempDirs: string[] = [];

function validProjectConfig() {
  return {
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
        git: {
          transport: "ssh",
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
        git: {
          transport: "ssh",
        },
      },
    ],
  };
}

function defaultRuntimePolicy() {
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

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("project config", () => {
  it("parses the prototype project config shape with runtime defaults", () => {
    expect(parseProjectConfig(validProjectConfig())).toEqual({
      ...validProjectConfig(),
      runtime: defaultRuntimePolicy(),
    });
  });

  it("keeps legacy kanban project identity readable as compatibility input", () => {
    const legacyConfig = {
      ...validProjectConfig(),
      id: undefined,
      kanban: {
        provider: "vibe-kanban",
        projectId: "legacy-project",
      },
    };

    expect(parseProjectConfig(legacyConfig)).toEqual({
      ...validProjectConfig(),
      id: "legacy-project",
      kanban: legacyConfig.kanban,
      runtime: defaultRuntimePolicy(),
    });
  });

  it("loads plexus.project.json from the project root", () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "plexus-project-"));
    tempDirs.push(projectRoot);
    fs.writeFileSync(
      path.join(projectRoot, plexusProjectConfigFileName),
      JSON.stringify(validProjectConfig(), null, 2),
      "utf8",
    );

    expect(projectConfigPath(projectRoot)).toBe(
      path.join(projectRoot, "plexus.project.json"),
    );
    expect(loadProjectConfig(projectRoot)).toEqual({
      ...validProjectConfig(),
      runtime: defaultRuntimePolicy(),
    });
  });

  it("allows image MCP ports to be allocated later", () => {
    const config = validProjectConfig();
    delete config.images[1].mcp.port;

    expect(parseProjectConfig(config)).toEqual({
      ...config,
      runtime: defaultRuntimePolicy(),
    });
  });

  it("parses explicit Pharo MCP startup modes and load policies", () => {
    const config = validProjectConfig();
    (config.images[0].mcp as { startupMode?: string }).startupMode = "optional";
    (config.images[1].mcp as { startupMode?: string }).startupMode = "disabled";
    (config.images[0].mcp as { loadPolicy?: string }).loadPolicy = "always";
    (config.images[1].mcp as { loadPolicy?: string }).loadPolicy = "never";

    expect(parseProjectConfig(config).images.map((image) => image.mcp)).toEqual([
      {
        port: 7123,
        loadScript: "pharo/load-mcp.st",
        startupMode: "optional",
        loadPolicy: "always",
      },
      {
        port: 7124,
        loadScript: "pharo/load-mcp.st",
        startupMode: "disabled",
        loadPolicy: "never",
      },
    ]);
  });

  it("parses workspace image creation limits", () => {
    const config: ReturnType<typeof validProjectConfig> & { runtime?: unknown } =
      validProjectConfig();
    config.runtime = {
      workspaceImages: {
        maxCount: 2,
      },
    };

    expect(parseProjectConfig(config).runtime?.workspaceImages).toEqual({
      maxCount: 2,
    });
  });

  it("parses image display mode defaults", () => {
    const config = validProjectConfig();
    (config.images[0] as { displayMode?: string }).displayMode = "interactive";

    expect(parseProjectConfig(config).images.map((image) => image.displayMode))
      .toEqual(["interactive", undefined]);
  });

  it("rejects invalid image display mode defaults", () => {
    const config = validProjectConfig();
    (config.images[0] as { displayMode?: string }).displayMode = "visible";

    expect(() => parseProjectConfig(config)).toThrow(ProjectConfigError);

    try {
      parseProjectConfig(config);
    } catch (error) {
      expect((error as ProjectConfigError).issues).toEqual(
        expect.arrayContaining([
          "images[0].displayMode must be one of headless, interactive",
        ]),
      );
    }
  });

  it("rejects invalid Pharo MCP startup modes", () => {
    const config = validProjectConfig();
    (config.images[0].mcp as { startupMode?: string }).startupMode = "plain";

    expect(() => parseProjectConfig(config)).toThrow(ProjectConfigError);

    try {
      parseProjectConfig(config);
    } catch (error) {
      expect((error as ProjectConfigError).issues).toEqual(
        expect.arrayContaining([
          "images[0].mcp.startupMode must be one of required, optional, disabled",
        ]),
      );
    }
  });

  it("rejects invalid Pharo MCP load policies", () => {
    const config = validProjectConfig();
    (config.images[0].mcp as { loadPolicy?: string }).loadPolicy = "sometimes";

    expect(() => parseProjectConfig(config)).toThrow(ProjectConfigError);

    try {
      parseProjectConfig(config);
    } catch (error) {
      expect((error as ProjectConfigError).issues).toEqual(
        expect.arrayContaining([
          "images[0].mcp.loadPolicy must be one of ifMissing, always, never",
        ]),
      );
    }
  });

  it("allows Pharo MCP load scripts to be omitted when configured loading is skipped", () => {
    const config = validProjectConfig();
    delete (config.images[0].mcp as { loadScript?: string }).loadScript;
    (config.images[0].mcp as { loadPolicy?: string }).loadPolicy = "never";

    expect(parseProjectConfig(config).images[0].mcp).toEqual({
      port: 7123,
      loadScript: "",
      loadPolicy: "never",
      startupMode: undefined,
    });
  });

  it("allows projects with no declared images", () => {
    const config = {
      ...validProjectConfig(),
      images: [],
    };

    expect(parseProjectConfig(config)).toEqual({
      ...config,
      runtime: defaultRuntimePolicy(),
    });
  });

  it("parses the explicit project runtime policy shape", () => {
    const config: ReturnType<typeof validProjectConfig> & { runtime?: unknown } =
      validProjectConfig();
    config.runtime = {
      scope: "project",
      stateRoot: {
        mode: "external",
        path: "C:\\dev\\plexus-state",
      },
      gateway: {
        mode: "shared",
        agentMcpUrl: "http://gateway.local:8133/mcp",
        routeControlMcpUrl: "http://gateway.local:8133/control-mcp",
      },
      imagePorts: {
        allocation: "configured-or-dynamic",
        range: {
          start: 7_200,
          end: 7_299,
        },
        coordination: {
          mode: "host-local",
          root: "C:\\dev\\plexus-port-claims",
        },
      },
      launcherProfile: {
        mode: "project-owned",
        name: "my-project-isolated",
        root: "C:\\dev\\plexus-state\\profiles\\pharo-launcher",
      },
      pharoMcp: {
        metadataKey: "io.github.evref-bl/pharo",
        supportedMajorVersions: [12, 13, 14],
      },
    };

    expect(parseProjectConfig(config)).toEqual(config);
  });

  it("keeps project-state image port coordination as an explicit opt-in", () => {
    const config: ReturnType<typeof validProjectConfig> & { runtime?: unknown } =
      validProjectConfig();
    config.runtime = {
      imagePorts: {
        coordination: {
          mode: "project-state",
        },
      },
    };

    expect(parseProjectConfig(config).runtime?.imagePorts.coordination).toEqual({
      mode: "project-state",
    });
  });

  it("allows external launcher profile policy as an explicit opt-out", () => {
    const config: ReturnType<typeof validProjectConfig> & { runtime?: unknown } =
      validProjectConfig();
    config.runtime = {
      launcherProfile: {
        mode: "external",
      },
    };

    expect(parseProjectConfig(config).runtime?.launcherProfile).toEqual({
      mode: "external",
    });
  });

  it("parses launcher template catalogue source policy", () => {
    const config: ReturnType<typeof validProjectConfig> & { runtime?: unknown } =
      validProjectConfig();
    config.runtime = {
      launcherProfile: {
        mode: "project-owned",
        templateCatalog: {
          source: "path",
          path: "/Users/ada/Library/Application Support/Pharo Launcher/templates",
          serverSourcesUrl: "https://files.example.test/sources.list",
        },
      },
    };

    expect(parseProjectConfig(config).runtime?.launcherProfile).toEqual({
      mode: "project-owned",
      templateCatalog: {
        source: "path",
        path: "/Users/ada/Library/Application Support/Pharo Launcher/templates",
        serverSourcesUrl: "https://files.example.test/sources.list",
      },
    });
  });

  it("rejects invalid launcher template catalogue policy", () => {
    const config: ReturnType<typeof validProjectConfig> & { runtime?: unknown } =
      validProjectConfig();
    config.runtime = {
      launcherProfile: {
        templateCatalog: {
          source: "custom",
          serverSourcesUrl: "not a url",
        },
      },
    };

    expect(() => parseProjectConfig(config)).toThrow(ProjectConfigError);

    try {
      parseProjectConfig(config);
    } catch (error) {
      expect((error as ProjectConfigError).issues).toEqual(
        expect.arrayContaining([
          "runtime.launcherProfile.templateCatalog.source must be one of user-or-server, user, server, path, none",
          "runtime.launcherProfile.templateCatalog.serverSourcesUrl must be a valid URL",
        ]),
      );
    }
  });

  it("parses Pharo MCP supported version policy overrides", () => {
    const config: ReturnType<typeof validProjectConfig> & { runtime?: unknown } =
      validProjectConfig();
    config.runtime = {
      pharoMcp: {
        metadataKey: "io.github.evref-bl/pharo",
        supportedMajorVersions: [13, 14],
      },
    };

    expect(parseProjectConfig(config).runtime?.pharoMcp).toEqual({
      metadataKey: "io.github.evref-bl/pharo",
      supportedMajorVersions: [13, 14],
    });
  });

  it("parses optional PLexus home and image-cache policy", () => {
    const config: ReturnType<typeof validProjectConfig> & { home?: unknown } =
      validProjectConfig();
    config.home = {
      path: "/Users/ada/.plexus-custom",
      imageCache: {
        enabled: false,
        networkPolicy: "local-only",
      },
      dependencyRepositories: {
        networkPolicy: "local-only",
      },
    };

    expect(parseProjectConfig(config).home).toEqual({
      path: "/Users/ada/.plexus-custom",
      imageCache: {
        enabled: false,
        networkPolicy: "local-only",
      },
      dependencyRepositories: {
        networkPolicy: "local-only",
      },
    });
  });

  it("defaults PLexus home dependency repository policy", () => {
    const config: ReturnType<typeof validProjectConfig> & { home?: unknown } =
      validProjectConfig();
    config.home = {};

    expect(parseProjectConfig(config).home).toEqual({
      imageCache: {
        enabled: true,
        networkPolicy: "online",
      },
      dependencyRepositories: {
        networkPolicy: "online",
      },
    });
  });

  it("rejects invalid PLexus home network policy values", () => {
    const config: ReturnType<typeof validProjectConfig> & { home?: unknown } =
      validProjectConfig();
    config.home = {
      imageCache: {
        enabled: true,
        networkPolicy: "offline",
      },
      dependencyRepositories: {
        networkPolicy: "offline",
      },
    };

    expect(() => parseProjectConfig(config)).toThrow(ProjectConfigError);

    try {
      parseProjectConfig(config);
    } catch (error) {
      expect((error as ProjectConfigError).issues).toEqual(
        expect.arrayContaining([
          "home.imageCache.networkPolicy must be one of online, local-only",
          "home.dependencyRepositories.networkPolicy must be one of online, local-only",
        ]),
      );
    }
  });

  it("records project-local gateway host, fixed port, route path, and control path", () => {
    const config: ReturnType<typeof validProjectConfig> & { runtime?: unknown } =
      validProjectConfig();
    config.runtime = {
      gateway: {
        mode: "project-local",
        host: "0.0.0.0",
        port: 8_144,
        agentMcpPath: "/agent-mcp",
        routeControlMcpPath: "/route-control",
      },
    };

    expect(parseProjectConfig(config).runtime?.gateway).toEqual({
      mode: "project-local",
      host: "0.0.0.0",
      port: 8_144,
      agentMcpPath: "/agent-mcp",
      routeControlMcpPath: "/route-control",
    });
  });

  it("rejects shared gateway runtime policy without endpoint details", () => {
    const config: ReturnType<typeof validProjectConfig> & { runtime?: unknown } =
      validProjectConfig();
    config.runtime = {
      gateway: {
        mode: "shared",
      },
    };

    expect(() => parseProjectConfig(config)).toThrow(ProjectConfigError);

    try {
      parseProjectConfig(config);
    } catch (error) {
      expect((error as ProjectConfigError).issues).toEqual(
        expect.arrayContaining([
          "runtime.gateway.agentMcpUrl must be a valid URL",
          "runtime.gateway.routeControlMcpUrl must be a valid URL",
        ]),
      );
    }
  });

  it("parses remote PLexus node declarations", () => {
    const config: ReturnType<typeof validProjectConfig> & { runtime?: unknown } =
      validProjectConfig();
    config.runtime = {
      nodeId: "host-a",
      remoteNodes: [
        {
          id: "remote-a",
          parentNodeId: "host-a",
          projectMcpUrl: "http://remote-a.local:7332/mcp",
          gatewayMcpUrl: "http://remote-a.local:7331/mcp",
          workspaces: [
            {
              workspaceId: "task-a",
              remoteWorkspaceId: "remote-task-a",
              remoteProjectPath: "/workspaces/project-a",
              targets: [
                {
                  targetId: "task-a-dev",
                  remoteTargetId: "remote-task-a-dev",
                },
              ],
            },
          ],
        },
      ],
    };

    const parsed = parseProjectConfig(config);

    expect(parsed.runtime?.nodeId).toBe("host-a");
    expect(parsed.runtime?.remoteNodes).toEqual([
      {
        id: "remote-a",
        parentNodeId: "host-a",
        projectMcpUrl: "http://remote-a.local:7332/mcp",
        gatewayMcpUrl: "http://remote-a.local:7331/mcp",
        workspaces: [
          {
            workspaceId: "task-a",
            remoteWorkspaceId: "remote-task-a",
            remoteProjectPath: "/workspaces/project-a",
            targets: [
              {
                targetId: "task-a-dev",
                remoteTargetId: "remote-task-a-dev",
              },
            ],
          },
        ],
      },
    ]);
  });

  it("rejects invalid remote PLexus node declarations", () => {
    const config: ReturnType<typeof validProjectConfig> & { runtime?: unknown } =
      validProjectConfig();
    config.runtime = {
      nodeId: "host-a",
      remoteNodes: [
        {
          id: "",
          projectMcpUrl: "not-a-url",
          gatewayMcpUrl: "",
          workspaces: [
            {
              remoteWorkspaceId: "remote-task-a",
              targets: [
                {
                  remoteTargetId: "remote-target-a",
                },
                "not-a-target",
              ],
            },
            "not-a-workspace",
          ],
        },
        {
          id: "host-a",
          projectMcpUrl: "http://local-cycle.local:7332/mcp",
          gatewayMcpUrl: "http://local-cycle.local:7331/mcp",
        },
        {
          id: "remote-b",
          parentNodeId: "remote-b",
          projectMcpUrl: "http://remote-b.local:7332/mcp",
          gatewayMcpUrl: "http://remote-b.local:7331/mcp",
          workspaces: [
            {
              workspaceId: "task-b",
              targets: [
                {
                  targetId: "target-b",
                },
                {
                  targetId: "target-b",
                },
              ],
            },
          ],
        },
        {
          id: "remote-b",
          parentNodeId: "another-host",
          projectMcpUrl: "http://remote-b2.local:7332/mcp",
          gatewayMcpUrl: "http://remote-b2.local:7331/mcp",
          workspaces: [
            {
              workspaceId: "task-b",
            },
            {
              workspaceId: "task-b",
            },
          ],
        },
      ],
    };

    expect(() => parseProjectConfig(config)).toThrow(ProjectConfigError);

    try {
      parseProjectConfig(config);
    } catch (error) {
      expect((error as ProjectConfigError).issues).toEqual(
        expect.arrayContaining([
          "runtime.remoteNodes[0].id must be a non-empty string",
          "runtime.remoteNodes[0].projectMcpUrl must be a valid URL",
          "runtime.remoteNodes[0].gatewayMcpUrl must be a valid URL",
          "runtime.remoteNodes[0].workspaces[0].workspaceId must be a non-empty string",
          "runtime.remoteNodes[0].workspaces[0].targets[0].targetId must be a non-empty string",
          "runtime.remoteNodes[0].workspaces[0].targets[1] must be an object",
          "runtime.remoteNodes[0].workspaces[1] must be an object",
          "runtime.remoteNodes[1].id must differ from runtime node id: host-a",
          "runtime.remoteNodes[2].parentNodeId must not equal its own id: remote-b",
          "runtime.remoteNodes[3].parentNodeId must be omitted or match runtime node id host-a for flat-tree topology",
          "remote node ids must be unique: remote-b",
          "runtime.remoteNodes[2].workspaces[0].targets.targetId must be unique: target-b",
          "runtime.remoteNodes[3].workspaces.workspaceId must be unique: task-b",
        ]),
      );
    }
  });

  it("leaves image git configuration absent when not specified", () => {
    const config = validProjectConfig();
    delete config.images[0].git;

    expect(parseProjectConfig(config).images[0].git).toBeUndefined();
  });

  it("parses image template create policy", () => {
    const baseConfig = validProjectConfig();
    const config = {
      ...baseConfig,
      images: [
        {
          ...baseConfig.images[0],
          create: {
            kind: "template",
            profileId: "pharo-13-default",
            templateName: "Pharo 13.0 - 64bit",
            templateCategory: "Official",
            role: "development",
            cleanupPolicy: "workspace_cleanup_only",
          },
        },
        baseConfig.images[1],
      ],
    };

    expect(parseProjectConfig(config).images[0].create).toEqual({
      kind: "template",
      profileId: "pharo-13-default",
      templateName: "Pharo 13.0 - 64bit",
      templateCategory: "Official",
      role: "development",
      cleanupPolicy: "workspace_cleanup_only",
    });
  });

  it("parses image-local repository workspace declarations", () => {
    const baseConfig = validProjectConfig();
    const config = {
      ...baseConfig,
      images: [
        {
          ...baseConfig.images[0],
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
              strategy: "git-worktree",
              path: "image-local://{imageId}/pharo-local/iceberg/{repositoryId}",
            },
          },
        },
        baseConfig.images[1],
      ],
    };

    expect(parseProjectConfig(config).images[0].repositoryWorkspace).toEqual(
      config.images[0].repositoryWorkspace,
    );
  });

  it("parses multiple image-local repository workspace declarations", () => {
    const baseConfig = validProjectConfig();
    const config = {
      ...baseConfig,
      images: [
        {
          ...baseConfig.images[0],
          repositoryWorkspaces: [
            {
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
            {
              repository: {
                id: "dependency",
                remoteUrl: "git@github.com:Example/Dependency.git",
              },
              sourceDirectory: "repository",
              baseline: "Dependency",
              materialization: {
                strategy: "clone",
                path: "image-local://{imageId}/pharo-local/iceberg/{repositoryId}",
              },
            },
          ],
        },
        baseConfig.images[1],
      ],
    };

    const image = parseProjectConfig(config).images[0];

    expect(image.repositoryWorkspaces).toEqual(config.images[0].repositoryWorkspaces);
    expect(image.repositoryWorkspace).toEqual(config.images[0].repositoryWorkspaces[0]);
  });

  it("defaults image-local repository workspace materialization to copy", () => {
    const baseConfig = validProjectConfig();
    const config = {
      ...baseConfig,
      images: [
        {
          ...baseConfig.images[0],
          repositoryWorkspace: {
            repository: {
              id: "my-project",
              componentId: "my-project",
            },
            sourceDirectory: "src",
            baseline: "MyProject",
          },
        },
        baseConfig.images[1],
      ],
    };

    expect(
      parseProjectConfig(config).images[0].repositoryWorkspace?.materialization,
    ).toEqual({
      strategy: "copy",
    });
  });

  it("rejects ambiguous or unsafe image-local repository workspace declarations", () => {
    const baseConfig = validProjectConfig();
    const config = {
      ...baseConfig,
      images: [
        {
          ...baseConfig.images[0],
          repositoryWorkspace: {
            repository: {
              id: "",
            },
            sourceDirectory: "",
            baseline: "",
            loadGroup: "",
            pharoVersion: 0,
            materialization: {
              strategy: "checkout",
              path: "/tmp/shared-pharo-repo",
            },
          },
        },
        {
          ...baseConfig.images[1],
          active: true,
          repositoryWorkspace: {
            repository: {
              id: "other",
              remoteUrl: "git@github.com:Example/Other.git",
            },
            sourceDirectory: "src",
            baseline: "Other",
            materialization: {
              strategy: "copy",
              path: "/tmp/shared-pharo-repo",
            },
          },
        },
      ],
    };

    expect(() => parseProjectConfig(config)).toThrow(ProjectConfigError);

    try {
      parseProjectConfig(config);
    } catch (error) {
      expect((error as ProjectConfigError).issues).toEqual(
        expect.arrayContaining([
          "images[0].repositoryWorkspace.repository must set at least one of componentId, remoteUrl, or originPath",
          "images[0].repositoryWorkspace.repository.id must be a non-empty string",
          "images[0].repositoryWorkspace.sourceDirectory must be a non-empty string",
          "images[0].repositoryWorkspace.baseline must be a non-empty string",
          "images[0].repositoryWorkspace.loadGroup must be a non-empty string",
          "images[0].repositoryWorkspace.pharoVersion must be a positive integer",
          "images[0].repositoryWorkspace.materialization.strategy must be one of copy, git-worktree, clone",
          "active image repository workspace paths must be unique: /tmp/shared-pharo-repo",
        ]),
      );
    }
  });

  it("rejects duplicate repository workspace ids in one image", () => {
    const baseConfig = validProjectConfig();
    const config = {
      ...baseConfig,
      images: [
        {
          ...baseConfig.images[0],
          repositoryWorkspaces: [
            {
              repository: {
                id: "my-project",
                componentId: "my-project",
              },
              sourceDirectory: "src",
              baseline: "MyProject",
            },
            {
              repository: {
                id: "my-project",
                remoteUrl: "git@github.com:Example/MyProject.git",
              },
              sourceDirectory: "repository",
              baseline: "MyProjectDependency",
            },
          ],
        },
      ],
    };

    expect(() => parseProjectConfig(config)).toThrow(ProjectConfigError);
    try {
      parseProjectConfig(config);
    } catch (error) {
      expect((error as ProjectConfigError).issues).toContain(
        "images[0] repository workspace ids must be unique: my-project",
      );
    }
  });

  it("rejects invalid image create policy", () => {
    const baseConfig = validProjectConfig();
    const config = {
      ...baseConfig,
      images: [
        {
          ...baseConfig.images[0],
          create: {
            kind: "copy",
            profileId: "",
            role: "",
            cleanupPolicy: "host-delete",
          },
        },
        baseConfig.images[1],
      ],
    };

    expect(() => parseProjectConfig(config)).toThrow(ProjectConfigError);

    try {
      parseProjectConfig(config);
    } catch (error) {
      expect((error as ProjectConfigError).issues).toEqual(
        expect.arrayContaining([
          "images[0].create.kind must be template",
          "images[0].create.profileId must be a non-empty string",
          "images[0].create.role must be a non-empty string",
          "images[0].create.cleanupPolicy must be workspace_cleanup_only",
          "images[0].create.templateName must be a non-empty string",
        ]),
      );
    }
  });

  it("rejects invalid workspace image creation limits", () => {
    const config: ReturnType<typeof validProjectConfig> & { runtime?: unknown } =
      validProjectConfig();
    config.runtime = {
      workspaceImages: {
        maxCount: 0,
      },
    };

    expect(() => parseProjectConfig(config)).toThrow(ProjectConfigError);

    try {
      parseProjectConfig(config);
    } catch (error) {
      expect((error as ProjectConfigError).issues).toEqual(
        expect.arrayContaining([
          "runtime.workspaceImages.maxCount must be a positive integer",
        ]),
      );
    }
  });

  it("parses prepared image cache specs and runtime copy policy", () => {
    const baseConfig = validProjectConfig();
    const config = {
      ...baseConfig,
      preparedImages: [
        {
          id: "pharo-13-mcp",
          imageName: "MyProject-{projectId}-{cacheId}",
          source: {
            kind: "template",
            profileId: "pharo-13-default",
            templateName: "Pharo 13.0 - 64bit",
            templateCategory: "Official",
          },
          mcp: {
            loadScript: "pharo/load-mcp.st",
            repository: {
              githubUser: "Evref-BL",
              project: "MCP",
              commitish: "main",
              path: "",
              baseline: "MCP",
            },
          },
        },
      ],
      images: [
        {
          ...baseConfig.images[0],
          preparedImage: {
            cacheId: "pharo-13-mcp",
            copyMode: "copy-on-open",
          },
        },
        baseConfig.images[1],
      ],
    };

    expect(parseProjectConfig(config)).toEqual({
      ...config,
      runtime: defaultRuntimePolicy(),
    });
  });

  it("rejects invalid prepared image cache specs", () => {
    const baseConfig = validProjectConfig();
    const config = {
      ...baseConfig,
      preparedImages: [
        {
          id: "cache",
          imageName: "Cache",
          source: {
            kind: "copy",
          },
          mcp: {
            loadScript: "",
            repository: {
              githubUser: "",
              project: "MCP",
            },
          },
        },
        {
          id: "cache",
          imageName: "Cache",
          source: {
            templateName: "Pharo 13.0 - 64bit",
          },
          mcp: {
            loadScript: "pharo/load-mcp.st",
          },
        },
      ],
      images: [
        {
          ...baseConfig.images[0],
          preparedImage: {
            cacheId: "missing-cache",
            copyMode: "copy-now",
          },
        },
        baseConfig.images[1],
      ],
    };

    expect(() => parseProjectConfig(config)).toThrow(ProjectConfigError);

    try {
      parseProjectConfig(config);
    } catch (error) {
      expect((error as ProjectConfigError).issues).toEqual(
        expect.arrayContaining([
          "preparedImages[0].source.kind must be template",
          "preparedImages[0].source.templateName must be a non-empty string",
          "preparedImages[0].mcp.loadScript must be a non-empty string",
          "preparedImages[0].mcp.repository.githubUser must be a non-empty string",
          "preparedImages[0].mcp.repository.commitish must be a non-empty string",
          "preparedImages[0].mcp.repository.path must be a string",
          "preparedImages[0].mcp.repository.baseline must be a non-empty string",
          "images[0].preparedImage.copyMode must be copy-on-open",
          "images[0].preparedImage.cacheId must reference a preparedImages id: missing-cache",
          "prepared image ids must be unique: cache",
          "prepared image names must be unique: Cache",
        ]),
      );
    }
  });

  it("parses image git transport and credentials", () => {
    const config = validProjectConfig();
    config.images[0].git = {
      transport: "https",
      plainCredentials: {
        username: "git-user",
        password: "token",
      },
    };
    config.images[1].git = {
      transport: "ssh",
      ssh: {
        username: "git",
        host: "ssh.github.com",
        port: 443,
        publicKey: "C:\\Users\\me\\.ssh\\id_rsa.pub",
        privateKey: "C:\\Users\\me\\.ssh\\id_rsa",
      },
    };

    expect(parseProjectConfig(config).images.map((image) => image.git)).toEqual([
      {
        transport: "https",
        plainCredentials: {
          username: "git-user",
          password: "token",
        },
      },
      {
        transport: "ssh",
        ssh: {
          username: "git",
          host: "ssh.github.com",
          port: 443,
          publicKey: "C:\\Users\\me\\.ssh\\id_rsa.pub",
          privateKey: "C:\\Users\\me\\.ssh\\id_rsa",
        },
      },
    ]);
  });

  it("rejects git credentials that do not match the selected transport", () => {
    const config = validProjectConfig();
    config.images[0].git = {
      transport: "ssh",
      plainCredentials: {
        username: "git-user",
        password: "token",
      },
    };
    config.images[1].git = {
      transport: "https",
      ssh: {
        publicKey: "C:\\Users\\me\\.ssh\\id_rsa.pub",
        privateKey: "C:\\Users\\me\\.ssh\\id_rsa",
      },
    };

    expect(() => parseProjectConfig(config)).toThrow(ProjectConfigError);

    try {
      parseProjectConfig(config);
    } catch (error) {
      expect((error as ProjectConfigError).issues).toEqual(
        expect.arrayContaining([
          "images[0].git.plainCredentials can only be used with https or http",
          "images[1].git.ssh can only be used with ssh",
        ]),
      );
    }
  });

  it("rejects SSH port configuration without an SSH host", () => {
    const config = validProjectConfig();
    config.images[0].git = {
      transport: "ssh",
      ssh: {
        port: 443,
      },
    };

    expect(() => parseProjectConfig(config)).toThrow(ProjectConfigError);

    try {
      parseProjectConfig(config);
    } catch (error) {
      expect((error as ProjectConfigError).issues).toEqual(
        expect.arrayContaining([
          "images[0].git.ssh.host must be set when images[0].git.ssh.port is set",
        ]),
      );
    }
  });

  it("rejects invalid or incomplete project configs with collected issues", () => {
    expect(() =>
      parseProjectConfig({
        name: "",
        id: "",
        kanban: {
          provider: "other",
        },
        images: [
          {
            id: "dev",
            imageName: "Shared",
            active: true,
            mcp: {
              port: 0,
              loadScript: "",
            },
            git: {
              transport: "git",
            },
          },
          {
            id: "dev",
            imageName: "Shared",
            active: "yes",
            mcp: {
              port: 0,
              loadScript: "pharo/load-mcp.st",
            },
            git: {
              ssh: {
                publicKey: "",
                privateKey: "",
              },
            },
          },
        ],
      }),
    ).toThrow(ProjectConfigError);

    try {
      parseProjectConfig({
        name: "",
        id: "",
        kanban: {
          provider: "other",
        },
        images: [
          {
            id: "dev",
            imageName: "Shared",
            active: true,
            mcp: {
              port: 0,
              loadScript: "",
            },
            git: {
              transport: "git",
            },
          },
          {
            id: "dev",
            imageName: "Shared",
            active: "yes",
            mcp: {
              port: 0,
              loadScript: "pharo/load-mcp.st",
            },
            git: {
              ssh: {
                publicKey: "",
                privateKey: "",
              },
            },
          },
        ],
      });
    } catch (error) {
      expect(error).toBeInstanceOf(ProjectConfigError);
      expect((error as ProjectConfigError).issues).toEqual(
        expect.arrayContaining([
          "config.id must be a non-empty string",
          "config.name must be a non-empty string",
          "kanban.provider must be \"vibe-kanban\"",
          "kanban.projectId must be a non-empty string",
          "images[0].mcp.port must be an integer between 1 and 65535",
          "images[0].mcp.loadScript must be a non-empty string",
          "images[0].git.transport must be one of ssh, https, http",
          "images[1].active must be a boolean",
          "images[1].mcp.port must be an integer between 1 and 65535",
          "images[1].git.ssh.publicKey must be a non-empty string",
          "images[1].git.ssh.privateKey must be a non-empty string",
          "image ids must be unique: dev",
          "image names must be unique: Shared",
        ]),
      );
    }
  });

  it("rejects duplicate active image ports", () => {
    const config = validProjectConfig();
    config.images[1].mcp.port = config.images[0].mcp.port;

    expect(() => parseProjectConfig(config)).toThrow(ProjectConfigError);
  });
});
