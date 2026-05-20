import { execFileSync } from "node:child_process";
import fs from "node:fs";
import {
  dirnamePathLike,
  isAbsolutePathLike,
  joinPathLike,
  resolvePathLike,
} from "./pathStyle.js";
import type { ProjectImageConfig } from "./projectConfig.js";
import type {
  ProjectImageRepositoryWorkspaceDirtyState,
  ProjectImageRepositoryWorkspaceMaterializationState,
  ProjectImageRepositoryWorkspaceState,
  ProjectImageState,
} from "./projectState.js";

export interface ProjectRepositoryWorkspaceMaterializationPlan {
  imageId: string;
  repositoryId: string;
  strategy: ProjectImageRepositoryWorkspaceState["materializationStrategy"];
  targetPath: string;
  sourcePath?: string;
  remoteUrl?: string;
  branch?: string;
  baseRef?: string;
  diagnostics: string[];
}

export interface ProjectRepositoryWorkspaceMaterializationResult
  extends ProjectRepositoryWorkspaceMaterializationPlan {
  status: Extract<
    ProjectImageRepositoryWorkspaceMaterializationState,
    "ready" | "reused"
  >;
  currentCommit?: string;
  dirtyState: ProjectImageRepositoryWorkspaceDirtyState;
}

export interface MaterializeProjectImageRepositoryWorkspaceOptions {
  projectRoot: string;
  imageConfig: ProjectImageConfig;
  imageState: ProjectImageState;
  env?: NodeJS.ProcessEnv;
}

export class ProjectRepositoryWorkspaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectRepositoryWorkspaceError";
  }
}

function splitPath(value: string): string[] {
  return value.split(/[\\/]+/).filter(Boolean);
}

function imageLocalRepositoryPath(
  imageState: ProjectImageState,
  logicalPath: string,
): string {
  const localDirectory =
    imageState.localDirectoryPath ??
    (imageState.imageDirectoryPath
      ? joinPathLike(imageState.imageDirectoryPath, "pharo-local")
      : imageState.imagePath
        ? joinPathLike(dirnamePathLike(imageState.imagePath), "pharo-local")
        : undefined);
  if (!localDirectory) {
    throw new ProjectRepositoryWorkspaceError(
      `Project image ${imageState.id} needs launcher image paths before materializing image-local repository workspace ${logicalPath}`,
    );
  }

  const withoutScheme = logicalPath.slice("image-local://".length);
  const firstSlash = withoutScheme.search(/[\\/]/);
  const pathPart = firstSlash === -1 ? "" : withoutScheme.slice(firstSlash + 1);
  const relativeToLocal = pathPart.replace(/^pharo-local[\\/]+/, "");
  return joinPathLike(localDirectory, ...splitPath(relativeToLocal));
}

export function resolveRepositoryWorkspacePath(options: {
  projectRoot: string;
  imageState: ProjectImageState;
  workspace: ProjectImageRepositoryWorkspaceState;
}): string {
  const configuredPath = options.workspace.path;
  if (configuredPath.startsWith("image-local://")) {
    return imageLocalRepositoryPath(options.imageState, configuredPath);
  }

  return isAbsolutePathLike(configuredPath)
    ? resolvePathLike(configuredPath)
    : resolvePathLike(options.projectRoot, configuredPath);
}

function git(
  cwd: string,
  args: string[],
  env: NodeJS.ProcessEnv | undefined,
): string {
  return execFileSync("git", args, {
    cwd,
    env: {
      ...process.env,
      ...env,
    },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function isGitRepository(path: string, env: NodeJS.ProcessEnv | undefined): boolean {
  try {
    return git(path, ["rev-parse", "--is-inside-work-tree"], env) === "true";
  } catch {
    return false;
  }
}

function gitStatus(path: string, env: NodeJS.ProcessEnv | undefined): string {
  return git(path, ["status", "--porcelain"], env);
}

function gitHead(path: string, env: NodeJS.ProcessEnv | undefined): string {
  return git(path, ["rev-parse", "HEAD"], env);
}

function gitBranchExists(
  path: string,
  branch: string,
  env: NodeJS.ProcessEnv | undefined,
): boolean {
  try {
    git(path, ["show-ref", "--verify", `refs/heads/${branch}`], env);
    return true;
  } catch {
    return false;
  }
}

function requireCleanGitSource(
  sourcePath: string,
  env: NodeJS.ProcessEnv | undefined,
): string {
  if (!isGitRepository(sourcePath, env)) {
    throw new ProjectRepositoryWorkspaceError(
      `Repository workspace source is not a Git repository: ${sourcePath}`,
    );
  }

  const status = gitStatus(sourcePath, env);
  if (status.length > 0) {
    throw new ProjectRepositoryWorkspaceError(
      `Repository workspace source has uncommitted changes; refusing to materialize from dirty source: ${sourcePath}`,
    );
  }

  return gitHead(sourcePath, env);
}

function targetExists(targetPath: string): boolean {
  return fs.existsSync(targetPath);
}

function targetHasContent(targetPath: string): boolean {
  return targetExists(targetPath) && fs.readdirSync(targetPath).length > 0;
}

function ensureUsableTarget(
  targetPath: string,
  env: NodeJS.ProcessEnv | undefined,
): "empty" | "git-repository" {
  if (!targetExists(targetPath) || !targetHasContent(targetPath)) {
    return "empty";
  }

  if (isGitRepository(targetPath, env)) {
    return "git-repository";
  }

  throw new ProjectRepositoryWorkspaceError(
    `Repository workspace target exists and is not a Git repository: ${targetPath}`,
  );
}

function checkoutMaterializationRef(
  targetPath: string,
  workspace: ProjectImageRepositoryWorkspaceState,
  env: NodeJS.ProcessEnv | undefined,
): void {
  const baseRef = workspace.baseCommit ?? workspace.baseBranch;
  if (workspace.branch) {
    git(targetPath, ["checkout", "-B", workspace.branch, baseRef ?? "HEAD"], env);
    return;
  }

  if (baseRef) {
    git(targetPath, ["checkout", baseRef], env);
  }
}

function materializeCopy(
  plan: ProjectRepositoryWorkspaceMaterializationPlan,
  workspace: ProjectImageRepositoryWorkspaceState,
  env: NodeJS.ProcessEnv | undefined,
): void {
  if (!plan.sourcePath) {
    throw new ProjectRepositoryWorkspaceError(
      `Repository workspace ${plan.repositoryId} uses copy materialization but has no originPath source`,
    );
  }

  requireCleanGitSource(plan.sourcePath, env);
  const targetStatus = ensureUsableTarget(plan.targetPath, env);
  if (targetStatus === "git-repository") {
    return;
  }

  fs.mkdirSync(dirnamePathLike(plan.targetPath), { recursive: true });
  let created = false;
  try {
    git(dirnamePathLike(plan.targetPath), [
      "clone",
      "--local",
      "--no-hardlinks",
      plan.sourcePath,
      plan.targetPath,
    ], env);
    created = true;
    checkoutMaterializationRef(plan.targetPath, workspace, env);
  } catch (error) {
    if (created || targetExists(plan.targetPath)) {
      fs.rmSync(plan.targetPath, { recursive: true, force: true });
    }
    throw error;
  }
}

function materializeClone(
  plan: ProjectRepositoryWorkspaceMaterializationPlan,
  workspace: ProjectImageRepositoryWorkspaceState,
  env: NodeJS.ProcessEnv | undefined,
): void {
  if (!plan.remoteUrl) {
    throw new ProjectRepositoryWorkspaceError(
      `Repository workspace ${plan.repositoryId} uses clone materialization but has no remoteUrl`,
    );
  }

  const targetStatus = ensureUsableTarget(plan.targetPath, env);
  if (targetStatus === "git-repository") {
    return;
  }

  fs.mkdirSync(dirnamePathLike(plan.targetPath), { recursive: true });
  try {
    git(dirnamePathLike(plan.targetPath), [
      "clone",
      plan.remoteUrl,
      plan.targetPath,
    ], env);
    checkoutMaterializationRef(plan.targetPath, workspace, env);
  } catch (error) {
    if (targetExists(plan.targetPath)) {
      fs.rmSync(plan.targetPath, { recursive: true, force: true });
    }
    throw error;
  }
}

function materializeGitWorktree(
  plan: ProjectRepositoryWorkspaceMaterializationPlan,
  workspace: ProjectImageRepositoryWorkspaceState,
  env: NodeJS.ProcessEnv | undefined,
): void {
  if (!plan.sourcePath) {
    throw new ProjectRepositoryWorkspaceError(
      `Repository workspace ${plan.repositoryId} uses git-worktree materialization but has no originPath source`,
    );
  }

  requireCleanGitSource(plan.sourcePath, env);
  const targetStatus = ensureUsableTarget(plan.targetPath, env);
  if (targetStatus === "git-repository") {
    return;
  }

  fs.mkdirSync(dirnamePathLike(plan.targetPath), { recursive: true });
  const baseRef = plan.baseRef ?? "HEAD";
  const args = workspace.branch
    ? gitBranchExists(plan.sourcePath, workspace.branch, env)
      ? ["worktree", "add", plan.targetPath, workspace.branch]
      : ["worktree", "add", "-b", workspace.branch, plan.targetPath, baseRef]
    : ["worktree", "add", plan.targetPath, baseRef];
  try {
    git(plan.sourcePath, args, env);
  } catch (error) {
    if (targetExists(plan.targetPath)) {
      fs.rmSync(plan.targetPath, { recursive: true, force: true });
    }
    throw error;
  }
}

function dirtyState(
  targetPath: string,
  env: NodeJS.ProcessEnv | undefined,
): ProjectImageRepositoryWorkspaceDirtyState {
  return gitStatus(targetPath, env).length > 0 ? "dirty" : "clean";
}

function updateWorkspaceState(
  workspace: ProjectImageRepositoryWorkspaceState,
  plan: ProjectRepositoryWorkspaceMaterializationPlan,
  result: ProjectRepositoryWorkspaceMaterializationResult,
): void {
  workspace.path = plan.targetPath;
  workspace.materializationState = result.status;
  workspace.dirtyState = result.dirtyState;
  workspace.diagnostics = result.diagnostics;
  if (result.sourcePath) {
    workspace.sourcePath = result.sourcePath;
  }
  if (result.currentCommit) {
    workspace.currentCommit = result.currentCommit;
  }
  if (!workspace.baseCommit && result.currentCommit) {
    workspace.baseCommit = result.currentCommit;
  }
}

export function buildProjectImageRepositoryWorkspaceMaterializationPlan(
  options: MaterializeProjectImageRepositoryWorkspaceOptions,
): ProjectRepositoryWorkspaceMaterializationPlan | undefined {
  const workspace = options.imageState.repositoryWorkspace;
  if (!workspace) {
    return undefined;
  }

  const targetPath = resolveRepositoryWorkspacePath({
    projectRoot: options.projectRoot,
    imageState: options.imageState,
    workspace,
  });
  const sourcePath = workspace.repository.originPath
    ? resolvePathLike(workspace.repository.originPath)
    : undefined;
  const baseRef = workspace.baseCommit ?? workspace.baseBranch;
  const diagnostics = [
    `Repository workspace ${workspace.repository.id} will use ${workspace.materializationStrategy} materialization.`,
  ];

  return {
    imageId: options.imageState.id,
    repositoryId: workspace.repository.id,
    strategy: workspace.materializationStrategy,
    targetPath,
    ...(sourcePath ? { sourcePath } : {}),
    ...(workspace.repository.remoteUrl ? { remoteUrl: workspace.repository.remoteUrl } : {}),
    ...(workspace.branch ? { branch: workspace.branch } : {}),
    ...(baseRef ? { baseRef } : {}),
    diagnostics,
  };
}

export function materializeProjectImageRepositoryWorkspace(
  options: MaterializeProjectImageRepositoryWorkspaceOptions,
): ProjectRepositoryWorkspaceMaterializationResult | undefined {
  const workspace = options.imageState.repositoryWorkspace;
  const plan = buildProjectImageRepositoryWorkspaceMaterializationPlan(options);
  if (!workspace || !plan) {
    return undefined;
  }

  try {
    const existingTarget = ensureUsableTarget(plan.targetPath, options.env);
    if (plan.strategy === "copy") {
      materializeCopy(plan, workspace, options.env);
    } else if (plan.strategy === "clone") {
      materializeClone(plan, workspace, options.env);
    } else {
      materializeGitWorktree(plan, workspace, options.env);
    }

    const result: ProjectRepositoryWorkspaceMaterializationResult = {
      ...plan,
      status: existingTarget === "git-repository" ? "reused" : "ready",
      currentCommit: gitHead(plan.targetPath, options.env),
      dirtyState: dirtyState(plan.targetPath, options.env),
      diagnostics: [
        ...plan.diagnostics,
        existingTarget === "git-repository"
          ? `Reused existing repository workspace at ${plan.targetPath}.`
          : `Materialized repository workspace at ${plan.targetPath}.`,
      ],
    };
    updateWorkspaceState(workspace, plan, result);
    return result;
  } catch (error) {
    workspace.materializationState = "failed";
    workspace.diagnostics = [
      ...plan.diagnostics,
      error instanceof Error ? error.message : String(error),
    ];
    throw error;
  }
}
