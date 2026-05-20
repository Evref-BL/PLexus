import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ProjectConfig } from "./projectConfig.js";
import type { ProjectImageState } from "./projectState.js";
import {
  generateImageStartupScript,
  imagePharoMcpLoadStatusPath,
  imageRepositoryWorkspaceLoadStatusPath,
  imageStartupScriptFileName,
  imageStartupScriptPath,
  ProjectStartupScriptError,
  projectScriptsDirectoryPath,
  writeProjectImageStartupScript,
} from "./projectStartupScript.js";

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
  ],
};

const imageState: ProjectImageState = {
  id: "dev",
  imageName: "MyProject-dev",
  assignedPort: 7123,
  status: "starting",
};

describe("project startup scripts", () => {
  it("resolves startup script paths under runtime state", () => {
    const projectRoot = path.join("C:", "dev", "code", "git", "my-project");

    expect(
      projectScriptsDirectoryPath({
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
        "scripts",
      ),
    );
    expect(
      imageStartupScriptPath({
        projectRoot,
        projectId: "project-123",
        imageId: "dev",
      }),
    ).toBe(
      path.win32.join(
        projectRoot,
        ".plexus",
        "projects",
        "project-123",
        "workspaces",
        "my-project",
        "scripts",
        "start-dev.st",
      ),
    );
  });

  it("rejects image ids that are unsafe as script file names", () => {
    expect(() => imageStartupScriptFileName("../dev")).toThrow(
      ProjectStartupScriptError,
    );
  });

  it("generates a Smalltalk script that loads MCP and starts the assigned port", () => {
    const projectRoot = path.join("C:", "dev", "code", "git", "my-project");
    const source = generateImageStartupScript({
      projectRoot,
      imageConfig: config.images[0],
      imageState,
    });

    expect(source).toContain(
      "'C:/dev/code/git/my-project/pharo/load-mcp.st' asFileReference",
    );
    expect(source).toContain("githubUser: 'Evref-BL' project: 'MCP'");
    expect(source).toContain("commitish: 'main' path: 'src'");
    expect(source).toContain("baseline: 'MCP'");
    expect(source).not.toContain("PLexusGitTransport");
    expect(source).not.toContain("IceCredentialsProvider");
    expect(source).toContain("mcp port: 7123.");
    expect(source).toContain("mcp start.");
    expect(source).not.toContain("bindToLoopback");
    expect(source).not.toContain("endpointFile writeStreamDo:");
    expect(source).toContain(
      "Smalltalk globals at: #PLexusMCPServer put: mcp.",
    );
    expect(source).toContain("Semaphore new wait.");
  });

  it("generates a Pharo MCP load status writer when a status path is provided", () => {
    const projectRoot = path.join("C:", "dev", "code", "git", "my-project");
    const statusPath = path.join(
      "C:",
      "dev",
      "code",
      "git",
      "my-project",
      ".plexus",
      "projects",
      "project-123",
      "workspaces",
      "worktree-a",
      "scripts",
      "pharo-mcp-load-dev.properties",
    );
    const source = generateImageStartupScript({
      projectRoot,
      imageConfig: config.images[0],
      imageState,
      pharoMcpLoadStatusPath: statusPath,
    });

    expect(source).toContain(
      "'C:/dev/code/git/my-project/.plexus/projects/project-123/workspaces/worktree-a/scripts/pharo-mcp-load-dev.properties' asFileReference",
    );
    expect(source).toContain("pharoMcpLoadStatusWriter := [ :status :message |");
    expect(source).toContain("nextPutAll: 'imageId=';");
    expect(source).toContain("nextPutAll: 'source=';");
    expect(source).toContain("nextPutAll: 'loadScript=';");
    expect(source).toContain("pharoMcpLoadSource = 'metacello'");
    expect(source).toContain("nextPutAll: 'repository=';");
    expect(source).toContain("nextPutAll: 'configuredRepositoryHint=';");
    expect(source).toContain("pharoMcpLoadStatusWriter value: 'loaded' value: nil");
    expect(source).toContain("pharoMcpLoadStatusWriter value: 'failed' value: error description.");
    expect(source).toContain("error pass");
  });

  it("skips MCP load and startup for known unsupported Pharo versions", () => {
    const projectRoot = path.join("C:", "dev", "code", "git", "my-project");
    const source = generateImageStartupScript({
      projectRoot,
      imageConfig: config.images[0],
      imageState: {
        id: "dev",
        imageName: "MyProject-dev",
        status: "starting",
        pharoVersion: "11",
        pharoMcpContract: {
          status: "unsupported",
          actualMajorVersion: 11,
          supportedMajorVersions: [12, 13, 14],
          reason: "Pharo 11 is outside the supported Pharo MCP range.",
        },
      },
    });

    expect(source).toContain("Pharo MCP startup is disabled");
    expect(source).not.toContain("Metacello new");
    expect(source).not.toContain("mcp start.");
    expect(source).not.toContain("MCP class is not available after loading.");
    expect(source).toContain("Semaphore new wait.");
  });

  it("fails supported MCP startup generation when no port is assigned", () => {
    expect(() =>
      generateImageStartupScript({
        projectRoot: path.join("C:", "dev", "code", "git", "my-project"),
        imageConfig: config.images[0],
        imageState: {
          id: "dev",
          imageName: "MyProject-dev",
          status: "starting",
        },
      }),
    ).toThrow(
      "Project image dev requires Pharo MCP startup but has no assigned MCP port",
    );
  });

  it("generates endpoint handoff startup for dynamic-port images", () => {
    const projectRoot = path.join("C:", "dev", "code", "git", "my-project");
    const source = generateImageStartupScript({
      projectRoot,
      imageConfig: {
        ...config.images[0],
        mcp: {
          loadScript: "pharo/load-mcp.st",
        },
      },
      imageState: {
        id: "dev",
        imageName: "MyProject-dev",
        assignedPort: 7123,
        status: "starting",
      },
      endpointHandoffPath: path.join(
        "C:",
        "dev",
        "code",
        "git",
        "my-project",
        ".plexus",
        "projects",
        "project-123",
        "workspaces",
        "my-project",
        "mcp-endpoints",
        "dev.properties",
      ),
    });

    expect(source).toContain("mcp bindToLoopback.");
    expect(source).toContain("mcp port: 0.");
    expect(source).toContain("endpoint := mcp endpoint.");
    expect(source).toContain("endpointFile writeStreamDo:");
    expect(source).toContain("nextPutAll: 'transport='");
    expect(source).toContain("nextPutAll: 'host='");
    expect(source).toContain("nextPutAll: 'port='");
    expect(source).toContain("nextPutAll: 'path='");
    expect(source).toContain("mcp port: 7123.");
  });

  it("generates a Pharo project load from an image-local repository workspace", () => {
    const projectRoot = path.join("C:", "dev", "code", "git", "my-project");
    const loadStatusPath = path.join(
      "C:",
      "dev",
      "code",
      "git",
      "my-project",
      ".plexus",
      "projects",
      "project-123",
      "workspaces",
      "worktree-a",
      "scripts",
      "repository-workspace-load-dev.properties",
    );
    const source = generateImageStartupScript({
      projectRoot,
      imageConfig: config.images[0],
      repositoryWorkspaceLoadStatusPath: loadStatusPath,
      imageState: {
        ...imageState,
        repositoryWorkspace: {
          repository: {
            id: "my-project",
            componentId: "my-project",
          },
          path: path.join(
            "C:",
            "Pharo",
            "images",
            "dev",
            "pharo-local",
            "iceberg",
            "my-project",
          ),
          materializationStrategy: "copy",
          sourceDirectory: "src",
          baseline: "MyProject",
          loadGroup: "tests",
          currentCommit: "abc123",
          materializationState: "ready",
          diagnostics: [],
          dirtyState: "clean",
          loadState: "pending",
        },
      },
    });

    expect(source).toContain(
      "'C:/dev/code/git/my-project/.plexus/projects/project-123/workspaces/worktree-a/scripts/repository-workspace-load-dev.properties' asFileReference",
    );
    expect(source).toContain(
      "repositorySourcePath := 'C:/Pharo/images/dev/pharo-local/iceberg/my-project/src'.",
    );
    expect(source).toContain(
      "repository: 'tonel://', repositorySourceDirectory fullName;",
    );
    expect(source).toContain("baseline: 'MyProject';");
    expect(source).toContain("load: (Array with: 'tests').");
    expect(source).toContain("nextPutAll: 'currentCommit=';");
    expect(source).toContain("nextPutAll: 'abc123';");
    expect(source.indexOf("Load the configured Pharo project")).toBeLessThan(
      source.indexOf("Load the Pharo MCP project"),
    );
  });

  it("can require endpoint handoff without a fixed fallback port", () => {
    const source = generateImageStartupScript({
      projectRoot: path.join("C:", "dev", "code", "git", "my-project"),
      imageConfig: {
        ...config.images[0],
        mcp: {
          loadScript: "pharo/load-mcp.st",
        },
      },
      imageState: {
        id: "dev",
        imageName: "MyProject-dev",
        status: "starting",
      },
      endpointHandoffPath: path.join(
        "C:",
        "dev",
        "code",
        "git",
        "my-project",
        ".plexus",
        "projects",
        "project-123",
        "workspaces",
        "my-project",
        "mcp-endpoints",
        "dev.properties",
      ),
    });

    expect(source).toContain("mcp bindToLoopback.");
    expect(source).toContain(
      "MCP endpoint handoff is required, but this image-side MCP does not support bindToLoopback/endpoint.",
    );
  });

  it.each([
    [
      "Windows",
      "C:\\dev\\code\\git\\my-project",
      "C:/dev/code/git/my-project/pharo/load-mcp.st",
    ],
    [
      "POSIX",
      "/srv/git/my-project",
      "/srv/git/my-project/pharo/load-mcp.st",
    ],
  ])(
    "preserves %s project-root style in generated Smalltalk load-script paths",
    (_style, projectRoot, expectedLoadScriptPath) => {
      const source = generateImageStartupScript({
        projectRoot,
        imageConfig: config.images[0],
        imageState,
      });

      expect(source).toContain(
        `'${expectedLoadScriptPath}' asFileReference`,
      );
    },
  );

  it("generates image Git configuration for custom SSH keys", () => {
    const projectRoot = path.join("C:", "dev", "code", "git", "my-project");
    const source = generateImageStartupScript({
      projectRoot,
      imageConfig: {
        ...config.images[0],
        git: {
          transport: "ssh",
          ssh: {
            publicKey: "C:\\Users\\me\\.ssh\\id_rsa.pub",
            privateKey: "C:\\Users\\me\\.ssh\\id_rsa",
          },
        },
      },
      imageState,
    });

    expect(source).toContain("credentialsProvider useCustomSsh: true.");
    expect(source).toContain("remoteTypeSelector: #scpUrl.");
    expect(source).toContain("credentialsProvider sshCredentials");
    expect(source).toContain("username: 'git';");
    expect(source).toContain("publicKey: 'C:/Users/me/.ssh/id_rsa.pub';");
    expect(source).toContain("privateKey: 'C:/Users/me/.ssh/id_rsa'.");
  });

  it("generates image Git configuration for explicit SSH host and port", () => {
    const projectRoot = path.join("C:", "dev", "code", "git", "my-project");
    const source = generateImageStartupScript({
      projectRoot,
      imageConfig: {
        ...config.images[0],
        git: {
          transport: "ssh",
          ssh: {
            username: "git",
            host: "ssh.github.com",
            port: 443,
          },
        },
      },
      imageState,
    });

    expect(source).toContain("remoteTypeSelector: #scpUrl.");
    expect(source).toContain(
      "Smalltalk globals at: #PLexusGitSshRemoteTemplate put: 'ssh://git@ssh.github.com:443/{projectPath}.git'.",
    );
    expect(source).toContain("scpUrl");
    expect(source).toContain(
      "^ ''ssh://git@ssh.github.com:443/'', projectPath, ''.git''",
    );
    expect(source).toContain("credentialsProvider useCustomSsh: false.");
  });

  it("generates image Git configuration for HTTPS credentials", () => {
    const projectRoot = path.join("C:", "dev", "code", "git", "my-project");
    const source = generateImageStartupScript({
      projectRoot,
      imageConfig: {
        ...config.images[0],
        git: {
          transport: "https",
          plainCredentials: {
            username: "git-user",
            password: "token's",
          },
        },
      },
      imageState,
    });

    expect(source).toContain(
      "Smalltalk globals at: #PLexusGitTransport put: 'https'.",
    );
    expect(source).toContain("remoteTypeSelector: #httpsUrl.");
    expect(source).toContain("credentialsProvider useCustomSsh: false.");
    expect(source).toContain("Smalltalk globals includesKey: #IcePlaintextCredentials");
    expect(source).toContain("username: 'git-user';");
    expect(source).toContain("password: 'token''s';");
  });

  it("generates image Git configuration for HTTP transport", () => {
    const projectRoot = path.join("C:", "dev", "code", "git", "my-project");
    const source = generateImageStartupScript({
      projectRoot,
      imageConfig: {
        ...config.images[0],
        git: {
          transport: "http",
        },
      },
      imageState,
    });

    expect(source).toContain(
      "Smalltalk globals at: #PLexusGitTransport put: 'http'.",
    );
    expect(source).toContain("remoteTypeSelector: #httpUrl.");
    expect(source).toContain("credentialsProvider useCustomSsh: false.");
  });

  it("escapes single quotes in generated Smalltalk strings", () => {
    const projectRoot = path.join("C:", "dev", "code", "git", "quote's");
    const source = generateImageStartupScript({
      projectRoot,
      imageConfig: config.images[0],
      imageState,
      repository: {
        githubUser: "Evref-BL",
        project: "MCP",
        commitish: "feature's",
        path: "src",
        baseline: "MCP",
      },
    });

    expect(source).toContain("quote''s/pharo/load-mcp.st");
    expect(source).toContain("commitish: 'feature''s'");
  });

  it("writes the startup script into runtime state", () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "plexus-project-"));
    const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "plexus-state-"));

    try {
      const written = writeProjectImageStartupScript({
        projectRoot,
        config,
        imageId: "dev",
        imageState,
        workspaceId: "worktree-a",
        stateRoot,
      });

      expect(written.filePath).toBe(
        path.join(
          stateRoot,
          "projects",
          "project-123",
          "workspaces",
          "worktree-a",
          "scripts",
          "start-dev.st",
        ),
      );
      expect(fs.readFileSync(written.filePath, "utf8")).toBe(written.source);
      expect(written.pharoMcpLoadStatusPath).toBe(
        imagePharoMcpLoadStatusPath({
          projectRoot,
          projectId: "project-123",
          imageId: "dev",
          workspaceId: "worktree-a",
          stateRoot,
        }),
      );
      expect(written.repositoryWorkspaceLoadStatusPath).toBeUndefined();
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
      fs.rmSync(stateRoot, { recursive: true, force: true });
    }
  });

  it("reports the repository workspace load status path when startup will load a Pharo project", () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "plexus-project-"));
    const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "plexus-state-"));
    const repositoryConfig: ProjectConfig = {
      ...config,
      images: [
        {
          ...config.images[0],
          repositoryWorkspace: {
            repository: {
              id: "my-project",
              originPath: "/repo/source",
            },
            sourceDirectory: "src",
            baseline: "MyProject",
            materialization: {
              strategy: "copy",
            },
          },
        },
      ],
    };

    try {
      const written = writeProjectImageStartupScript({
        projectRoot,
        config: repositoryConfig,
        imageId: "dev",
        imageState: {
          ...imageState,
          repositoryWorkspace: {
            repository: {
              id: "my-project",
              originPath: "/repo/source",
            },
            path: "/image/pharo-local/iceberg/my-project",
            materializationStrategy: "copy",
            sourceDirectory: "src",
            baseline: "MyProject",
            materializationState: "ready",
            diagnostics: [],
            dirtyState: "clean",
            loadState: "not-loaded",
          },
        },
        workspaceId: "worktree-a",
        stateRoot,
      });

      expect(written.repositoryWorkspaceLoadStatusPath).toBe(
        imageRepositoryWorkspaceLoadStatusPath({
          projectRoot,
          projectId: "project-123",
          imageId: "dev",
          workspaceId: "worktree-a",
          stateRoot,
        }),
      );
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
      fs.rmSync(stateRoot, { recursive: true, force: true });
    }
  });

  it("fails when the requested project image is missing", () => {
    expect(() =>
      writeProjectImageStartupScript({
        projectRoot: path.join("C:", "dev", "code", "git", "my-project"),
        config,
        imageId: "missing",
        imageState,
      }),
    ).toThrow(ProjectStartupScriptError);
  });
});
