import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ProjectConfig } from "./projectConfig.js";
import type { ProjectImageState } from "./projectState.js";
import {
  generateImageStartupScript,
  imageStartupScriptFileName,
  imageStartupScriptPath,
  ProjectStartupScriptError,
  projectScriptsDirectoryPath,
  writeProjectImageStartupScript,
} from "./projectStartupScript.js";

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
      path.join(
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
      path.join(
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
    expect(source).toContain("baseline: 'MCP'");
    expect(source).toContain(
      "Smalltalk globals at: #PLexusGitTransport put: 'ssh'.",
    );
    expect(source).toContain("credentialsProvider useCustomSsh: false.");
    expect(source).toContain("mcp port: 7123.");
    expect(source).toContain("mcp start.");
    expect(source).toContain(
      "Smalltalk globals at: #PLexusMCPServer put: mcp.",
    );
  });

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
    expect(source).toContain("credentialsProvider sshCredentials");
    expect(source).toContain("username: 'git';");
    expect(source).toContain("publicKey: 'C:/Users/me/.ssh/id_rsa.pub';");
    expect(source).toContain("privateKey: 'C:/Users/me/.ssh/id_rsa'.");
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
    expect(source).toContain("credentialsProvider useCustomSsh: false.");
    expect(source).toContain("Smalltalk globals includesKey: #IcePlaintextCredentials");
    expect(source).toContain("username: 'git-user';");
    expect(source).toContain("password: 'token''s';");
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
