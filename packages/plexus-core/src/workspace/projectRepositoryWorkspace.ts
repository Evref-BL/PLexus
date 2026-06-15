import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  dirnamePathLike,
  isAbsolutePathLike,
  joinPathLike,
  resolvePathLike,
  sanitizePathSegment,
} from "../support/pathStyle.js";
import type { ProjectImageConfig } from "../config/projectConfig.js";
import type {
  ProjectImageRepositoryWorkspaceCleanupPolicy,
  ProjectImageRepositoryWorkspaceCleanupRecord,
  ProjectImageRepositoryWorkspaceDirtyState,
  ProjectImageRepositoryWorkspaceMaterializationState,
  ProjectImageRepositoryWorkspaceState,
  ProjectImageState,
} from "./projectState.js";
import {
  projectImageRepositoryWorkspaces,
  syncProjectImageRepositoryWorkspaceAliases,
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
  workspace?: ProjectImageRepositoryWorkspaceState | undefined;
  sourcePath?: string | undefined;
  env?: NodeJS.ProcessEnv;
}

export interface ProjectRepositoryWorkspaceInspection {
  imageId: string;
  repositoryId: string;
  path: string;
  exists: boolean;
  isGitRepository: boolean;
  dirtyState: ProjectImageRepositoryWorkspaceDirtyState;
  diagnostics: string[];
  branch?: string;
  baseCommit?: string;
  currentCommit?: string;
}

export interface CleanupProjectImageRepositoryWorkspaceOptions {
  projectRoot: string;
  imageState: ProjectImageState;
  workspace?: ProjectImageRepositoryWorkspaceState | undefined;
  policy: ProjectImageRepositoryWorkspaceCleanupPolicy;
  archiveRoot?: string | undefined;
  now?: (() => Date) | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  removePath?: ((targetPath: string) => void) | undefined;
  movePath?: ((sourcePath: string, archivePath: string) => void) | undefined;
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

function gitBranch(path: string, env: NodeJS.ProcessEnv | undefined): string | undefined {
  try {
    const branch = git(path, ["rev-parse", "--abbrev-ref", "HEAD"], env);
    return branch === "HEAD" ? undefined : branch;
  } catch {
    return undefined;
  }
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

function sanitizedPathSegment(value: string): string {
  return sanitizePathSegment(value, "repo");
}

function safeArchivePath(options: {
  archiveRoot: string;
  imageId: string;
  repositoryId: string;
  recordedAt: string;
}): string {
  const stamp = options.recordedAt.replace(/[^0-9A-Za-z]+/g, "-");
  const base = path.join(
    options.archiveRoot,
    `${sanitizedPathSegment(options.imageId)}-${sanitizedPathSegment(
      options.repositoryId,
    )}-${stamp}`,
  );
  let candidate = base;
  let suffix = 1;
  while (fs.existsSync(candidate)) {
    suffix += 1;
    candidate = `${base}-${suffix}`;
  }
  return candidate;
}

function defaultRemovePath(targetPath: string): void {
  fs.rmSync(targetPath, { recursive: true, force: true });
}

function defaultMovePath(sourcePath: string, archivePath: string): void {
  fs.mkdirSync(path.dirname(archivePath), { recursive: true });
  try {
    fs.renameSync(sourcePath, archivePath);
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "EXDEV"
    ) {
      fs.cpSync(sourcePath, archivePath, { recursive: true });
      fs.rmSync(sourcePath, { recursive: true, force: true });
      return;
    }
    throw error;
  }
}

function forbiddenDestructivePaths(
  projectRoot: string,
  imageState: ProjectImageState,
): string[] {
  return [
    projectRoot,
    imageState.imagePath ? path.dirname(imageState.imagePath) : undefined,
    imageState.imageDirectoryPath,
    imageState.localDirectoryPath,
    imageState.ombuDirectoryPath,
  ]
    .filter((item): item is string => item !== undefined)
    .map((item) => path.resolve(item));
}

function assertSafeDestructiveTarget(options: {
  projectRoot: string;
  imageState: ProjectImageState;
  targetPath: string;
}): void {
  const resolved = path.resolve(options.targetPath);
  if (resolved === path.parse(resolved).root) {
    throw new ProjectRepositoryWorkspaceError(
      `Refusing repository workspace cleanup because target path is a filesystem root: ${resolved}`,
    );
  }

  const forbidden = new Set(
    forbiddenDestructivePaths(options.projectRoot, options.imageState),
  );
  if (forbidden.has(resolved)) {
    throw new ProjectRepositoryWorkspaceError(
      `Refusing repository workspace cleanup because target path is an image or project boundary path: ${resolved}`,
    );
  }
}

function cleanupRecord(options: {
  policy: ProjectImageRepositoryWorkspaceCleanupPolicy;
  decision: ProjectImageRepositoryWorkspaceCleanupRecord["decision"];
  imageState: ProjectImageState;
  workspace: ProjectImageRepositoryWorkspaceState;
  inspection: ProjectRepositoryWorkspaceInspection;
  recordedAt: string;
  archivePath?: string;
  message?: string;
}): ProjectImageRepositoryWorkspaceCleanupRecord {
  return {
    policy: options.policy,
    decision: options.decision,
    imageId: options.imageState.id,
    repositoryId: options.workspace.repository.id,
    path: options.inspection.path,
    dirtyState: options.inspection.dirtyState,
    recordedAt: options.recordedAt,
    ...(options.inspection.branch ? { branch: options.inspection.branch } : {}),
    ...(options.workspace.baseCommit
      ? { baseCommit: options.workspace.baseCommit }
      : {}),
    ...(options.inspection.currentCommit
      ? { currentCommit: options.inspection.currentCommit }
      : {}),
    ...(options.archivePath ? { archivePath: options.archivePath } : {}),
    ...(options.message ? { message: options.message } : {}),
  };
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

function repositoryWorkspaceSourcePath(
  workspace: ProjectImageRepositoryWorkspaceState,
  workspaceSourcePath: string | undefined,
): string | undefined {
  const originPath = workspace.repository.originPath;
  if (!originPath) {
    return workspaceSourcePath ? resolvePathLike(workspaceSourcePath) : undefined;
  }

  if (isAbsolutePathLike(originPath) || !workspaceSourcePath) {
    return resolvePathLike(originPath);
  }

  return resolvePathLike(workspaceSourcePath, originPath);
}

export function buildProjectImageRepositoryWorkspaceMaterializationPlan(
  options: MaterializeProjectImageRepositoryWorkspaceOptions,
): ProjectRepositoryWorkspaceMaterializationPlan | undefined {
  const workspace =
    options.workspace ?? options.imageState.repositoryWorkspace;
  if (!workspace) {
    return undefined;
  }

  const targetPath = resolveRepositoryWorkspacePath({
    projectRoot: options.projectRoot,
    imageState: options.imageState,
    workspace,
  });
  const sourcePath = repositoryWorkspaceSourcePath(workspace, options.sourcePath);
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
  const workspace =
    options.workspace ?? options.imageState.repositoryWorkspace;
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
    syncProjectImageRepositoryWorkspaceAliases(options.imageState);
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

export function materializeProjectImageRepositoryWorkspaces(
  options: MaterializeProjectImageRepositoryWorkspaceOptions,
): ProjectRepositoryWorkspaceMaterializationResult[] {
  const results: ProjectRepositoryWorkspaceMaterializationResult[] = [];
  for (const workspace of projectImageRepositoryWorkspaces(options.imageState)) {
    const result = materializeProjectImageRepositoryWorkspace({
      ...options,
      workspace,
    });
    if (result) {
      results.push(result);
    }
  }
  syncProjectImageRepositoryWorkspaceAliases(options.imageState);
  return results;
}

export function inspectProjectImageRepositoryWorkspace(options: {
  projectRoot: string;
  imageState: ProjectImageState;
  workspace?: ProjectImageRepositoryWorkspaceState | undefined;
  env?: NodeJS.ProcessEnv;
}): ProjectRepositoryWorkspaceInspection | undefined {
  const workspace =
    options.workspace ?? options.imageState.repositoryWorkspace;
  if (!workspace) {
    return undefined;
  }

  const diagnostics: string[] = [];
  let targetPath: string;
  try {
    targetPath = resolveRepositoryWorkspacePath({
      projectRoot: options.projectRoot,
      imageState: options.imageState,
      workspace,
    });
  } catch (error) {
    diagnostics.push(error instanceof Error ? error.message : String(error));
    return {
      imageId: options.imageState.id,
      repositoryId: workspace.repository.id,
      path: workspace.path,
      exists: false,
      isGitRepository: false,
      dirtyState: "unknown",
      diagnostics,
      ...(workspace.baseCommit ? { baseCommit: workspace.baseCommit } : {}),
    };
  }

  if (!fs.existsSync(targetPath)) {
    diagnostics.push(`Repository workspace path does not exist: ${targetPath}.`);
    return {
      imageId: options.imageState.id,
      repositoryId: workspace.repository.id,
      path: targetPath,
      exists: false,
      isGitRepository: false,
      dirtyState: "unknown",
      diagnostics,
      ...(workspace.baseCommit ? { baseCommit: workspace.baseCommit } : {}),
    };
  }

  if (!isGitRepository(targetPath, options.env)) {
    diagnostics.push(
      `Repository workspace path exists but is not a Git repository: ${targetPath}.`,
    );
    return {
      imageId: options.imageState.id,
      repositoryId: workspace.repository.id,
      path: targetPath,
      exists: true,
      isGitRepository: false,
      dirtyState: "unknown",
      diagnostics,
      ...(workspace.baseCommit ? { baseCommit: workspace.baseCommit } : {}),
    };
  }

  const currentDirtyState = dirtyState(targetPath, options.env);
  const branch = gitBranch(targetPath, options.env);
  diagnostics.push(
    currentDirtyState === "dirty"
      ? "Repository workspace has uncommitted changes."
      : "Repository workspace is clean.",
  );

  return {
    imageId: options.imageState.id,
    repositoryId: workspace.repository.id,
    path: targetPath,
    exists: true,
    isGitRepository: true,
    dirtyState: currentDirtyState,
    diagnostics,
    ...(branch ? { branch } : {}),
    ...(workspace.baseCommit ? { baseCommit: workspace.baseCommit } : {}),
    currentCommit: gitHead(targetPath, options.env),
  };
}

export function inspectProjectImageRepositoryWorkspaces(options: {
  projectRoot: string;
  imageState: ProjectImageState;
  env?: NodeJS.ProcessEnv;
}): ProjectRepositoryWorkspaceInspection[] {
  return projectImageRepositoryWorkspaces(options.imageState)
    .map((workspace) =>
      inspectProjectImageRepositoryWorkspace({
        ...options,
        workspace,
      }),
    )
    .filter(
      (
        inspection,
      ): inspection is ProjectRepositoryWorkspaceInspection =>
        inspection !== undefined,
    );
}

export function cleanupProjectImageRepositoryWorkspace(
  options: CleanupProjectImageRepositoryWorkspaceOptions,
): ProjectImageRepositoryWorkspaceCleanupRecord | undefined {
  const workspace =
    options.workspace ?? options.imageState.repositoryWorkspace;
  if (!workspace) {
    return undefined;
  }

  const recordedAt = (options.now ?? (() => new Date()))().toISOString();
  const inspection = inspectProjectImageRepositoryWorkspace(options);
  if (!inspection) {
    return undefined;
  }
  const workspaceState = workspace;
  const inspectionState = inspection;

  function record(
    decision: ProjectImageRepositoryWorkspaceCleanupRecord["decision"],
    message?: string,
    archivePath?: string,
  ): ProjectImageRepositoryWorkspaceCleanupRecord {
    const cleanupState = cleanupRecord({
      policy: options.policy,
      decision,
      imageState: options.imageState,
      workspace: workspaceState,
      inspection: inspectionState,
      recordedAt,
      ...(archivePath ? { archivePath } : {}),
      ...(message ? { message } : {}),
    });
    workspaceState.path = inspectionState.path;
    workspaceState.dirtyState = inspectionState.dirtyState;
    if (inspectionState.branch) {
      workspaceState.branch = inspectionState.branch;
    }
    if (inspectionState.currentCommit) {
      workspaceState.currentCommit = inspectionState.currentCommit;
    }
    workspaceState.cleanupState = cleanupState;
    workspaceState.diagnostics = [
      ...workspaceState.diagnostics.filter(
        (diagnostic) => !diagnostic.startsWith("Repository workspace cleanup "),
      ),
      `Repository workspace cleanup ${decision}: ${
        message ?? `policy ${options.policy}`
      }`,
    ];
    syncProjectImageRepositoryWorkspaceAliases(options.imageState);
    return cleanupState;
  }

  if (!inspection.exists) {
    return record("missing", "Repository workspace path was already absent.");
  }

  if (options.policy === "preserve") {
    return record(
      "preserved",
      inspection.dirtyState === "dirty"
        ? "Repository workspace preserved for review because it has uncommitted changes."
        : "Repository workspace preserved by default close policy.",
    );
  }

  try {
    assertSafeDestructiveTarget({
      projectRoot: options.projectRoot,
      imageState: options.imageState,
      targetPath: inspection.path,
    });

    if (options.policy === "archive") {
      const archiveRoot =
        options.archiveRoot ??
        path.join(options.projectRoot, ".plexus", "repository-workspace-archives");
      const archivePath = safeArchivePath({
        archiveRoot,
        imageId: options.imageState.id,
        repositoryId: workspace.repository.id,
        recordedAt,
      });
      (options.movePath ?? defaultMovePath)(inspection.path, archivePath);
      return record("archived", "Repository workspace archived.", archivePath);
    }

    if (!inspection.isGitRepository) {
      return record(
        "refused",
        "Repository workspace is not a Git repository; refusing destructive delete.",
      );
    }
    if (inspection.dirtyState === "dirty") {
      return record(
        "refused",
        "Repository workspace has uncommitted changes; refusing destructive delete.",
      );
    }

    (options.removePath ?? defaultRemovePath)(inspection.path);
    return record("deleted", "Clean disposable repository workspace deleted.");
  } catch (error) {
    return record(
      "failed",
      error instanceof Error ? error.message : String(error),
    );
  }
}

export function cleanupProjectImageRepositoryWorkspaces(
  options: CleanupProjectImageRepositoryWorkspaceOptions,
): ProjectImageRepositoryWorkspaceCleanupRecord[] {
  const records: ProjectImageRepositoryWorkspaceCleanupRecord[] = [];
  for (const workspace of projectImageRepositoryWorkspaces(options.imageState)) {
    const record = cleanupProjectImageRepositoryWorkspace({
      ...options,
      workspace,
    });
    if (record) {
      records.push(record);
    }
  }
  syncProjectImageRepositoryWorkspaceAliases(options.imageState);
  return records;
}
