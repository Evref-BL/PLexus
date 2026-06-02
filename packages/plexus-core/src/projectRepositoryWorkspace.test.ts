import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ProjectImageConfig } from "./projectConfig.js";
import {
  materializeProjectImageRepositoryWorkspace,
  materializeProjectImageRepositoryWorkspaces,
  ProjectRepositoryWorkspaceError,
  resolveRepositoryWorkspacePath,
} from "./projectRepositoryWorkspace.js";
import {
  projectImageRepositoryWorkspaceState,
  projectImageRepositoryWorkspaceStates,
  type ProjectImageState,
} from "./projectState.js";

const tempDirs: string[] = [];
const gitEnv = {
  GIT_AUTHOR_NAME: "PLexus Test",
  GIT_AUTHOR_EMAIL: "plexus-test@example.invalid",
  GIT_COMMITTER_NAME: "PLexus Test",
  GIT_COMMITTER_EMAIL: "plexus-test@example.invalid",
};

function makeTempDir(prefix: string): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(tempDir);
  return tempDir;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    env: {
      ...process.env,
      ...gitEnv,
    },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function writeFile(filePath: string, contents: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents, "utf8");
}

function initRepository(sourceRoot: string): string {
  git(sourceRoot, ["init", "--initial-branch=main"]);
  writeFile(path.join(sourceRoot, "src", "BaselineOfMyProject.class.st"), "baseline");
  git(sourceRoot, ["add", "."]);
  git(sourceRoot, ["commit", "-m", "Initial"]);
  return git(sourceRoot, ["rev-parse", "HEAD"]);
}

function imageConfig(overrides: {
  componentId?: string;
  originPath?: string;
  remoteUrl?: string;
  strategy?: "copy" | "git-worktree" | "clone";
  path?: string;
  branch?: string;
}): ProjectImageConfig {
  return {
    id: "dev",
    imageName: "MyProject-dev",
    active: true,
    mcp: {
      loadScript: "pharo/load-mcp.st",
    },
    repositoryWorkspace: {
      repository: {
        id: "my-project",
        ...(overrides.componentId ? { componentId: overrides.componentId } : {}),
        ...(overrides.originPath ? { originPath: overrides.originPath } : {}),
        ...(overrides.remoteUrl ? { remoteUrl: overrides.remoteUrl } : {}),
      },
      sourceDirectory: "src",
      baseline: "MyProject",
      ...(overrides.branch ? { branch: overrides.branch } : {}),
      materialization: {
        strategy: overrides.strategy ?? "copy",
        ...(overrides.path ? { path: overrides.path } : {}),
      },
    },
  };
}

function imageState(config: ProjectImageConfig): ProjectImageState {
  return {
    id: "dev",
    imageName: "MyProject-dev",
    status: "starting",
    localDirectoryPath: path.join(makeTempDir("plexus-image-local-"), "pharo-local"),
    repositoryWorkspace: projectImageRepositoryWorkspaceState(config, {
      projectId: "project-123",
      projectName: "my-project",
      workspaceId: "task-123",
      targetId: "target-123",
      imageId: "dev",
    }),
  };
}

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("project repository workspace materialization", () => {
  it("resolves image-local repository paths from the image local directory", () => {
    const config = imageConfig({});
    const state = imageState(config);

    expect(
      resolveRepositoryWorkspacePath({
        projectRoot: makeTempDir("plexus-project-"),
        imageState: state,
        workspace: state.repositoryWorkspace!,
      }),
    ).toBe(path.join(state.localDirectoryPath!, "iceberg", "my-project"));
  });

  it("uses the workspace source path when a local repository workspace omits originPath", () => {
    const sourceRoot = makeTempDir("plexus-source-");
    const sourceCommit = initRepository(sourceRoot);
    const targetPath = path.join(makeTempDir("plexus-target-"), "repo");
    const config = imageConfig({
      componentId: "my-project",
      path: targetPath,
    });
    const state = imageState(config);

    const result = materializeProjectImageRepositoryWorkspace({
      projectRoot: makeTempDir("plexus-project-"),
      imageConfig: config,
      imageState: state,
      sourcePath: sourceRoot,
      env: gitEnv,
    });

    expect(result).toMatchObject({
      status: "ready",
      strategy: "copy",
      sourcePath: sourceRoot,
      targetPath,
      currentCommit: sourceCommit,
      dirtyState: "clean",
    });
    expect(git(targetPath, ["rev-parse", "HEAD"])).toBe(sourceCommit);
    expect(state.repositoryWorkspace).toMatchObject({
      repository: {
        componentId: "my-project",
      },
      sourcePath: sourceRoot,
      currentCommit: sourceCommit,
      baseCommit: sourceCommit,
      materializationState: "ready",
    });
  });

  it("materializes a clean local source through copy strategy", () => {
    const sourceRoot = makeTempDir("plexus-source-");
    const sourceCommit = initRepository(sourceRoot);
    const targetPath = path.join(makeTempDir("plexus-target-"), "repo");
    const config = imageConfig({
      originPath: sourceRoot,
      path: targetPath,
    });
    const state = imageState(config);

    const result = materializeProjectImageRepositoryWorkspace({
      projectRoot: makeTempDir("plexus-project-"),
      imageConfig: config,
      imageState: state,
      env: gitEnv,
    });

    expect(result).toMatchObject({
      status: "ready",
      strategy: "copy",
      sourcePath: sourceRoot,
      targetPath,
      currentCommit: sourceCommit,
      dirtyState: "clean",
    });
    expect(git(targetPath, ["rev-parse", "HEAD"])).toBe(sourceCommit);
    expect(state.repositoryWorkspace).toMatchObject({
      path: targetPath,
      sourcePath: sourceRoot,
      currentCommit: sourceCommit,
      baseCommit: sourceCommit,
      materializationState: "ready",
      dirtyState: "clean",
      loadState: "not-loaded",
    });
  });

  it("materializes multiple editable repository workspaces", () => {
    const firstSourceRoot = makeTempDir("plexus-source-");
    const firstCommit = initRepository(firstSourceRoot);
    const secondSourceRoot = makeTempDir("plexus-source-");
    const secondCommit = initRepository(secondSourceRoot);
    const firstTargetPath = path.join(makeTempDir("plexus-target-"), "first");
    const secondTargetPath = path.join(makeTempDir("plexus-target-"), "second");
    const config: ProjectImageConfig = {
      id: "dev",
      imageName: "MyProject-dev",
      active: true,
      mcp: {
        loadScript: "pharo/load-mcp.st",
      },
      repositoryWorkspaces: [
        {
          repository: {
            id: "my-project",
            originPath: firstSourceRoot,
          },
          sourceDirectory: "src",
          baseline: "MyProject",
          materialization: {
            strategy: "copy",
            path: firstTargetPath,
          },
        },
        {
          repository: {
            id: "dependency",
            originPath: secondSourceRoot,
          },
          sourceDirectory: "src",
          baseline: "Dependency",
          materialization: {
            strategy: "copy",
            path: secondTargetPath,
          },
        },
      ],
    };
    const state: ProjectImageState = {
      id: "dev",
      imageName: "MyProject-dev",
      status: "starting",
      localDirectoryPath: path.join(makeTempDir("plexus-image-local-"), "pharo-local"),
      repositoryWorkspaces: projectImageRepositoryWorkspaceStates(config, {
        projectId: "project-123",
        projectName: "my-project",
        workspaceId: "task-123",
        targetId: "target-123",
        imageId: "dev",
      }),
    };

    const results = materializeProjectImageRepositoryWorkspaces({
      projectRoot: makeTempDir("plexus-project-"),
      imageConfig: config,
      imageState: state,
      env: gitEnv,
    });

    expect(results).toEqual([
      expect.objectContaining({
        repositoryId: "my-project",
        targetPath: firstTargetPath,
        currentCommit: firstCommit,
      }),
      expect.objectContaining({
        repositoryId: "dependency",
        targetPath: secondTargetPath,
        currentCommit: secondCommit,
      }),
    ]);
    expect(git(firstTargetPath, ["rev-parse", "HEAD"])).toBe(firstCommit);
    expect(git(secondTargetPath, ["rev-parse", "HEAD"])).toBe(secondCommit);
    expect(state.repositoryWorkspaces).toEqual([
      expect.objectContaining({
        repository: { id: "my-project", originPath: firstSourceRoot },
        currentCommit: firstCommit,
        materializationState: "ready",
      }),
      expect.objectContaining({
        repository: { id: "dependency", originPath: secondSourceRoot },
        currentCommit: secondCommit,
        materializationState: "ready",
      }),
    ]);
    expect(state.repositoryWorkspace).toBe(state.repositoryWorkspaces?.[0]);
  });

  it("reuses an existing repository workspace", () => {
    const sourceRoot = makeTempDir("plexus-source-");
    initRepository(sourceRoot);
    const targetPath = path.join(makeTempDir("plexus-target-"), "repo");
    const config = imageConfig({
      originPath: sourceRoot,
      path: targetPath,
    });
    const state = imageState(config);

    materializeProjectImageRepositoryWorkspace({
      projectRoot: makeTempDir("plexus-project-"),
      imageConfig: config,
      imageState: state,
      env: gitEnv,
    });
    const reused = materializeProjectImageRepositoryWorkspace({
      projectRoot: makeTempDir("plexus-project-"),
      imageConfig: config,
      imageState: state,
      env: gitEnv,
    });

    expect(reused?.status).toBe("reused");
    expect(state.repositoryWorkspace?.materializationState).toBe("reused");
  });

  it("refuses to copy a dirty integration source", () => {
    const sourceRoot = makeTempDir("plexus-source-");
    initRepository(sourceRoot);
    writeFile(path.join(sourceRoot, "src", "Uncommitted.class.st"), "dirty");
    const config = imageConfig({
      originPath: sourceRoot,
      path: path.join(makeTempDir("plexus-target-"), "repo"),
    });

    expect(() =>
      materializeProjectImageRepositoryWorkspace({
        projectRoot: makeTempDir("plexus-project-"),
        imageConfig: config,
        imageState: imageState(config),
        env: gitEnv,
      }),
    ).toThrow(ProjectRepositoryWorkspaceError);
  });

  it("materializes a Git worktree from a clean origin repository", () => {
    const sourceRoot = makeTempDir("plexus-source-");
    const sourceCommit = initRepository(sourceRoot);
    const targetPath = path.join(makeTempDir("plexus-target-"), "repo");
    const config = imageConfig({
      originPath: sourceRoot,
      strategy: "git-worktree",
      path: targetPath,
      branch: "image/dev",
    });
    const state = imageState(config);

    const result = materializeProjectImageRepositoryWorkspace({
      projectRoot: makeTempDir("plexus-project-"),
      imageConfig: config,
      imageState: state,
      env: gitEnv,
    });

    expect(result).toMatchObject({
      status: "ready",
      strategy: "git-worktree",
      branch: "image/dev",
      currentCommit: sourceCommit,
      dirtyState: "clean",
    });
    expect(git(targetPath, ["branch", "--show-current"])).toBe("image/dev");
  });

  it("materializes a remote clone fallback", () => {
    const sourceRoot = makeTempDir("plexus-source-");
    const sourceCommit = initRepository(sourceRoot);
    const targetPath = path.join(makeTempDir("plexus-target-"), "repo");
    const config = imageConfig({
      remoteUrl: sourceRoot,
      strategy: "clone",
      path: targetPath,
    });
    const state = imageState(config);

    const result = materializeProjectImageRepositoryWorkspace({
      projectRoot: makeTempDir("plexus-project-"),
      imageConfig: config,
      imageState: state,
      env: gitEnv,
    });

    expect(result).toMatchObject({
      status: "ready",
      strategy: "clone",
      remoteUrl: sourceRoot,
      currentCommit: sourceCommit,
      dirtyState: "clean",
    });
  });

  it("cleans up failed clone targets", () => {
    const targetPath = path.join(makeTempDir("plexus-target-"), "repo");
    const config = imageConfig({
      remoteUrl: path.join(makeTempDir("missing-remote-"), "missing.git"),
      strategy: "clone",
      path: targetPath,
    });

    expect(() =>
      materializeProjectImageRepositoryWorkspace({
        projectRoot: makeTempDir("plexus-project-"),
        imageConfig: config,
        imageState: imageState(config),
        env: gitEnv,
      }),
    ).toThrow();
    expect(fs.existsSync(targetPath)).toBe(false);
  });
});
