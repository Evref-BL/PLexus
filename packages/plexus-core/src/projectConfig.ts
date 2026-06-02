import fs from "node:fs";
import { joinPathLike } from "./pathStyle.js";

export const plexusProjectConfigFileName = "plexus.project.json";

export interface ProjectKanbanConfig {
  provider: "vibe-kanban";
  projectId: string;
}

export interface ProjectImageMcpConfig {
  port?: number;
  loadScript: string;
  startupMode?: ProjectPharoMcpStartupMode;
  loadPolicy?: ProjectPharoMcpLoadPolicy;
}

export type ProjectPharoMcpStartupMode = "required" | "optional" | "disabled";
export type ProjectPharoMcpLoadPolicy = "ifMissing" | "always" | "never";
export type ProjectImageDisplayMode = "headless" | "interactive";

export interface ProjectPharoMcpRepositoryConfig {
  githubUser: string;
  project: string;
  commitish: string;
  path: string;
  baseline: string;
}

export interface ProjectPreparedImageMcpConfig {
  loadScript: string;
  repository?: ProjectPharoMcpRepositoryConfig;
  startupMode?: ProjectPharoMcpStartupMode;
}

export type ProjectImageGitTransport = "ssh" | "https" | "http";

export interface ProjectImageSshConfig {
  username?: string;
  host?: string;
  port?: number;
  publicKey?: string;
  privateKey?: string;
}

export interface ProjectImagePlainCredentialsConfig {
  username: string;
  password: string;
}

export interface ProjectImageGitConfig {
  transport: ProjectImageGitTransport;
  ssh?: ProjectImageSshConfig;
  plainCredentials?: ProjectImagePlainCredentialsConfig;
}

export interface ProjectImageTemplateCreateConfig {
  kind: "template";
  profileId?: string;
  templateName: string;
  templateCategory?: string;
  role?: string;
  cleanupPolicy?: ProjectImageCreationCleanupPolicy;
}

export type ProjectImageCreateConfig = ProjectImageTemplateCreateConfig;
export type ProjectImageCreationCleanupPolicy = "workspace_cleanup_only";

export type ProjectImagePreparedCopyMode = "copy-on-open";

export interface ProjectImagePreparedImageConfig {
  cacheId: string;
  copyMode: ProjectImagePreparedCopyMode;
}

export type ProjectImageRepositoryWorkspaceMaterializationStrategy =
  | "copy"
  | "git-worktree"
  | "clone";

export interface ProjectImageRepositoryIdentityConfig {
  id: string;
  componentId?: string;
  remoteUrl?: string;
  originPath?: string;
}

export interface ProjectImageRepositoryWorkspaceMaterializationConfig {
  strategy: ProjectImageRepositoryWorkspaceMaterializationStrategy;
  path?: string;
}

export interface ProjectImageRepositoryWorkspaceConfig {
  repository: ProjectImageRepositoryIdentityConfig;
  sourceDirectory: string;
  baseline: string;
  loadGroup?: string;
  pharoVersion?: number;
  templateName?: string;
  templateCategory?: string;
  branch?: string;
  baseBranch?: string;
  baseCommit?: string;
  materialization: ProjectImageRepositoryWorkspaceMaterializationConfig;
}

export interface ProjectImageConfig {
  id: string;
  imageName: string;
  active: boolean;
  displayMode?: ProjectImageDisplayMode;
  mcp: ProjectImageMcpConfig;
  create?: ProjectImageCreateConfig;
  preparedImage?: ProjectImagePreparedImageConfig;
  repositoryWorkspace?: ProjectImageRepositoryWorkspaceConfig;
  repositoryWorkspaces?: ProjectImageRepositoryWorkspaceConfig[];
  git?: ProjectImageGitConfig;
}

export interface ProjectPreparedImageTemplateSourceConfig {
  kind: "template";
  profileId?: string;
  templateName: string;
  templateCategory?: string;
}

export type ProjectPreparedImageSourceConfig =
  ProjectPreparedImageTemplateSourceConfig;

export interface ProjectPreparedImageConfig {
  id: string;
  imageName: string;
  source: ProjectPreparedImageSourceConfig;
  mcp: ProjectPreparedImageMcpConfig;
}

export type ProjectHomeImageCacheNetworkPolicy = "online" | "local-only";
export type ProjectHomeDependencyRepositoryNetworkPolicy =
  | "online"
  | "local-only";

export interface ProjectHomeImageCacheConfig {
  enabled: boolean;
  networkPolicy: ProjectHomeImageCacheNetworkPolicy;
}

export interface ProjectHomeDependencyRepositoriesConfig {
  networkPolicy: ProjectHomeDependencyRepositoryNetworkPolicy;
}

export interface ProjectHomeConfig {
  path?: string;
  imageCache: ProjectHomeImageCacheConfig;
  dependencyRepositories?: ProjectHomeDependencyRepositoriesConfig;
}

export interface ProjectRuntimePortRange {
  start: number;
  end: number;
}

export type ProjectRuntimeScope = "project";
export type ProjectRuntimeStateRootMode = "project-local" | "external";

export interface ProjectRuntimeStateRootPolicy {
  mode: ProjectRuntimeStateRootMode;
  path?: string;
}

export type ProjectGatewayMode = "project-local" | "shared";

export interface ProjectLocalGatewayPolicy {
  mode: "project-local";
  host: string;
  port?: number;
  portRange?: ProjectRuntimePortRange;
  agentMcpPath: string;
  routeControlMcpPath: string;
}

export interface ProjectSharedGatewayPolicy {
  mode: "shared";
  agentMcpUrl: string;
  routeControlMcpUrl: string;
}

export type ProjectGatewayPolicy =
  | ProjectLocalGatewayPolicy
  | ProjectSharedGatewayPolicy;

export type ProjectImagePortAllocationPolicy =
  | "configured-or-dynamic"
  | "dynamic-only"
  | "configured-only";

export type ProjectImagePortCoordinationMode = "project-state" | "host-local";

export interface ProjectImagePortCoordinationPolicy {
  mode: ProjectImagePortCoordinationMode;
  root?: string;
}

export interface ProjectImagePortPolicy {
  allocation: ProjectImagePortAllocationPolicy;
  range: ProjectRuntimePortRange;
  coordination: ProjectImagePortCoordinationPolicy;
}

export const defaultPharoMcpMetadataKey = "io.github.evref-bl/pharo";
export const defaultPharoMcpSupportedMajorVersions = [12, 13, 14] as const;

export interface ProjectPharoMcpPolicy {
  metadataKey: string;
  supportedMajorVersions: number[];
}

export interface ProjectRemoteNodeTargetMappingConfig {
  targetId: string;
  remoteTargetId?: string;
}

export interface ProjectRemoteNodeWorkspaceMappingConfig {
  workspaceId: string;
  remoteWorkspaceId?: string;
  remoteProjectPath?: string;
  targets?: ProjectRemoteNodeTargetMappingConfig[];
}

export interface ProjectRemoteNodeConfig {
  id: string;
  parentNodeId?: string;
  projectMcpUrl: string;
  gatewayMcpUrl: string;
  workspaces?: ProjectRemoteNodeWorkspaceMappingConfig[];
}

export type ProjectLauncherProfileMode = "project-owned" | "external";

export type ProjectLauncherTemplateCatalogSource =
  | "user-or-server"
  | "user"
  | "server"
  | "path"
  | "none";

export interface ProjectLauncherTemplateCatalogPolicy {
  source: ProjectLauncherTemplateCatalogSource;
  path?: string;
  serverSourcesUrl?: string;
}

export interface ProjectLauncherProfilePolicy {
  mode: ProjectLauncherProfileMode;
  name?: string;
  root?: string;
  templateCatalog?: ProjectLauncherTemplateCatalogPolicy;
}

export interface ProjectRuntimePolicy {
  scope: ProjectRuntimeScope;
  nodeId?: string;
  stateRoot: ProjectRuntimeStateRootPolicy;
  gateway: ProjectGatewayPolicy;
  imagePorts: ProjectImagePortPolicy;
  workspaceImages?: ProjectWorkspaceImagePolicy;
  remoteNodes?: ProjectRemoteNodeConfig[];
  launcherProfile: ProjectLauncherProfilePolicy;
  pharoMcp: ProjectPharoMcpPolicy;
}

export interface ProjectWorkspaceImagePolicy {
  maxCount?: number;
}

export interface ProjectConfig {
  id: string;
  name: string;
  kanban?: ProjectKanbanConfig;
  home?: ProjectHomeConfig;
  runtime?: ProjectRuntimePolicy;
  preparedImages?: ProjectPreparedImageConfig[];
  images: ProjectImageConfig[];
}

export type PlexusProjectConfig = ProjectConfig;

export class ProjectConfigError extends Error {
  constructor(
    message: string,
    public readonly issues: string[],
  ) {
    super(message);
    this.name = "ProjectConfigError";
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function defaultProjectRuntimePolicy(): ProjectRuntimePolicy {
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
      metadataKey: defaultPharoMcpMetadataKey,
      supportedMajorVersions: [...defaultPharoMcpSupportedMajorVersions],
    },
  };
}

export function resolveProjectRuntimePolicy(
  config: Pick<ProjectConfig, "runtime">,
): ProjectRuntimePolicy {
  return config.runtime ?? defaultProjectRuntimePolicy();
}

export function projectConfigId(config: Pick<ProjectConfig, "id">): string {
  return config.id;
}

export function projectMcpStartupMode(
  mcp: Pick<ProjectImageMcpConfig, "startupMode">,
): ProjectPharoMcpStartupMode {
  return mcp.startupMode ?? "required";
}

export function projectMcpLoadPolicy(
  mcp: Pick<ProjectImageMcpConfig, "loadPolicy">,
): ProjectPharoMcpLoadPolicy {
  return mcp.loadPolicy ?? "ifMissing";
}

export function projectImageDisplayMode(
  image: Pick<ProjectImageConfig, "displayMode">,
): ProjectImageDisplayMode {
  return image.displayMode ?? "headless";
}

export function projectImageCreateCleanupPolicy(
  create: ProjectImageCreateConfig,
): ProjectImageCreationCleanupPolicy {
  return create.cleanupPolicy ?? "workspace_cleanup_only";
}

function stringField(
  object: Record<string, unknown>,
  key: string,
  issues: string[],
  pathPrefix: string,
): string {
  const value = object[key];
  if (typeof value === "string" && value.trim().length > 0) {
    return value;
  }

  issues.push(`${pathPrefix}.${key} must be a non-empty string`);
  return "";
}

function stringFieldAllowingEmpty(
  object: Record<string, unknown>,
  key: string,
  issues: string[],
  pathPrefix: string,
): string {
  const value = object[key];
  if (typeof value === "string") {
    return value;
  }

  issues.push(`${pathPrefix}.${key} must be a string`);
  return "";
}

function booleanField(
  object: Record<string, unknown>,
  key: string,
  issues: string[],
  pathPrefix: string,
): boolean {
  const value = object[key];
  if (typeof value === "boolean") {
    return value;
  }

  issues.push(`${pathPrefix}.${key} must be a boolean`);
  return false;
}

function booleanFieldWithDefault(
  object: Record<string, unknown>,
  key: string,
  issues: string[],
  pathPrefix: string,
  defaultValue: boolean,
): boolean {
  const value = object[key];
  if (value === undefined) {
    return defaultValue;
  }

  if (typeof value === "boolean") {
    return value;
  }

  issues.push(`${pathPrefix}.${key} must be a boolean`);
  return defaultValue;
}

function optionalPortField(
  object: Record<string, unknown>,
  key: string,
  issues: string[],
  pathPrefix: string,
): number | undefined {
  const value = object[key];
  if (value === undefined) {
    return undefined;
  }

  if (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= 65_535
  ) {
    return value;
  }

  issues.push(`${pathPrefix}.${key} must be an integer between 1 and 65535`);
  return undefined;
}

function optionalPharoMcpStartupModeField(
  object: Record<string, unknown>,
  key: string,
  issues: string[],
  pathPrefix: string,
): ProjectPharoMcpStartupMode | undefined {
  const value = object[key];
  if (value === undefined) {
    return undefined;
  }

  if (value === "required" || value === "optional" || value === "disabled") {
    return value;
  }

  issues.push(`${pathPrefix}.${key} must be one of required, optional, disabled`);
  return undefined;
}

function optionalPharoMcpLoadPolicyField(
  object: Record<string, unknown>,
  key: string,
  issues: string[],
  pathPrefix: string,
): ProjectPharoMcpLoadPolicy | undefined {
  const value = object[key];
  if (value === undefined) {
    return undefined;
  }

  if (value === "ifMissing" || value === "always" || value === "never") {
    return value;
  }

  issues.push(`${pathPrefix}.${key} must be one of ifMissing, always, never`);
  return undefined;
}

function imageMcpLoadScriptField(
  object: Record<string, unknown>,
  key: string,
  issues: string[],
  pathPrefix: string,
  loadPolicy: ProjectPharoMcpLoadPolicy | undefined,
): string {
  if (loadPolicy === "never" && object[key] === undefined) {
    return "";
  }

  return stringField(object, key, issues, pathPrefix);
}

function optionalImageDisplayModeField(
  object: Record<string, unknown>,
  key: string,
  issues: string[],
  pathPrefix: string,
): ProjectImageDisplayMode | undefined {
  const value = object[key];
  if (value === undefined) {
    return undefined;
  }

  if (value === "headless" || value === "interactive") {
    return value;
  }

  issues.push(`${pathPrefix}.${key} must be one of headless, interactive`);
  return undefined;
}

function optionalImageCreateCleanupPolicyField(
  object: Record<string, unknown>,
  key: string,
  issues: string[],
  pathPrefix: string,
): ProjectImageCreationCleanupPolicy | undefined {
  const value = object[key];
  if (value === undefined) {
    return undefined;
  }

  if (value === "workspace_cleanup_only") {
    return value;
  }

  issues.push(`${pathPrefix}.${key} must be workspace_cleanup_only`);
  return undefined;
}

function optionalPositiveIntegerField(
  object: Record<string, unknown>,
  key: string,
  issues: string[],
  pathPrefix: string,
): number | undefined {
  const value = object[key];
  if (value === undefined) {
    return undefined;
  }

  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }

  issues.push(`${pathPrefix}.${key} must be a positive integer`);
  return undefined;
}

function requiredPortField(
  object: Record<string, unknown>,
  key: string,
  issues: string[],
  pathPrefix: string,
  fallback: number,
): number {
  const value = optionalPortField(object, key, issues, pathPrefix);
  if (value !== undefined) {
    return value;
  }

  if (object[key] === undefined) {
    issues.push(`${pathPrefix}.${key} must be an integer between 1 and 65535`);
  }

  return fallback;
}

function optionalStringField(
  object: Record<string, unknown>,
  key: string,
  issues: string[],
  pathPrefix: string,
): string | undefined {
  const value = object[key];
  if (value === undefined) {
    return undefined;
  }

  if (typeof value === "string" && value.trim().length > 0) {
    return value;
  }

  issues.push(`${pathPrefix}.${key} must be a non-empty string`);
  return undefined;
}

function stringFieldWithDefault(
  object: Record<string, unknown>,
  key: string,
  issues: string[],
  pathPrefix: string,
  defaultValue: string,
): string {
  return optionalStringField(object, key, issues, pathPrefix) ?? defaultValue;
}

function urlField(
  object: Record<string, unknown>,
  key: string,
  issues: string[],
  pathPrefix: string,
): string {
  const value = object[key];
  if (typeof value === "string" && value.trim().length > 0) {
    try {
      new URL(value);
      return value;
    } catch {
      issues.push(`${pathPrefix}.${key} must be a valid URL`);
      return "";
    }
  }

  issues.push(`${pathPrefix}.${key} must be a valid URL`);
  return "";
}

function optionalUrlField(
  object: Record<string, unknown>,
  key: string,
  issues: string[],
  pathPrefix: string,
): string | undefined {
  const value = object[key];
  if (value === undefined) {
    return undefined;
  }

  if (typeof value === "string" && value.trim().length > 0) {
    try {
      new URL(value);
      return value;
    } catch {
      issues.push(`${pathPrefix}.${key} must be a valid URL`);
      return undefined;
    }
  }

  issues.push(`${pathPrefix}.${key} must be a valid URL`);
  return undefined;
}

function pathFieldWithDefault(
  object: Record<string, unknown>,
  key: string,
  issues: string[],
  pathPrefix: string,
  defaultValue: string,
): string {
  const value = stringFieldWithDefault(
    object,
    key,
    issues,
    pathPrefix,
    defaultValue,
  );
  if (!value.startsWith("/")) {
    issues.push(`${pathPrefix}.${key} must start with /`);
    return defaultValue;
  }

  return value;
}

function parseRuntimePortRange(
  value: unknown,
  issues: string[],
  pathPrefix: string,
  fallback: ProjectRuntimePortRange,
): ProjectRuntimePortRange {
  if (!isObject(value)) {
    issues.push(`${pathPrefix} must be an object`);
    return { ...fallback };
  }

  const start = requiredPortField(
    value,
    "start",
    issues,
    pathPrefix,
    fallback.start,
  );
  const end = requiredPortField(value, "end", issues, pathPrefix, fallback.end);
  if (start > end) {
    issues.push(
      `${pathPrefix}.start must be less than or equal to ${pathPrefix}.end`,
    );
  }

  return { start, end };
}

function parsePositiveIntegerArray(
  value: unknown,
  issues: string[],
  pathPrefix: string,
  fallback: readonly number[],
): number[] {
  if (value === undefined) {
    return [...fallback];
  }

  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every((item) => Number.isInteger(item) && item > 0)
  ) {
    issues.push(`${pathPrefix} must be a non-empty array of positive integers`);
    return [...fallback];
  }

  return [...new Set(value)];
}

function parseKanban(
  value: unknown,
  issues: string[],
): ProjectKanbanConfig | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isObject(value)) {
    issues.push("kanban must be an object");
    return undefined;
  }

  const provider = value.provider;
  if (provider !== "vibe-kanban") {
    issues.push("kanban.provider must be \"vibe-kanban\"");
  }

  return {
    provider: "vibe-kanban",
    projectId: stringField(value, "projectId", issues, "kanban"),
  };
}

function parseHome(value: unknown, issues: string[]): ProjectHomeConfig | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isObject(value)) {
    issues.push("home must be an object");
    return undefined;
  }

  const imageCacheValue = value.imageCache;
  let imageCache: ProjectHomeImageCacheConfig = {
    enabled: true,
    networkPolicy: "online",
  };
  if (imageCacheValue !== undefined) {
    if (!isObject(imageCacheValue)) {
      issues.push("home.imageCache must be an object");
    } else {
      const networkPolicy = imageCacheValue.networkPolicy ?? "online";
      if (networkPolicy !== "online" && networkPolicy !== "local-only") {
        issues.push(
          "home.imageCache.networkPolicy must be one of online, local-only",
        );
      }
      imageCache = {
        enabled: booleanFieldWithDefault(
          imageCacheValue,
          "enabled",
          issues,
          "home.imageCache",
          true,
        ),
        networkPolicy:
          networkPolicy === "local-only" ? "local-only" : "online",
      };
    }
  }
  const dependencyRepositoriesValue = value.dependencyRepositories;
  let dependencyRepositories: ProjectHomeDependencyRepositoriesConfig = {
    networkPolicy: "online",
  };
  if (dependencyRepositoriesValue !== undefined) {
    if (!isObject(dependencyRepositoriesValue)) {
      issues.push("home.dependencyRepositories must be an object");
    } else {
      const networkPolicy =
        dependencyRepositoriesValue.networkPolicy ?? "online";
      if (networkPolicy !== "online" && networkPolicy !== "local-only") {
        issues.push(
          "home.dependencyRepositories.networkPolicy must be one of online, local-only",
        );
      }
      dependencyRepositories = {
        networkPolicy:
          networkPolicy === "local-only" ? "local-only" : "online",
      };
    }
  }

  const path = optionalStringField(value, "path", issues, "home");
  return {
    ...(path ? { path } : {}),
    imageCache,
    dependencyRepositories,
  };
}

function parseProjectIdentity(
  value: Record<string, unknown>,
  legacyKanban: ProjectKanbanConfig | undefined,
  issues: string[],
): string {
  if (typeof value.id === "string" && value.id.trim().length > 0) {
    return value.id;
  }

  if (value.id === undefined && legacyKanban?.projectId) {
    return legacyKanban.projectId;
  }

  issues.push("config.id must be a non-empty string");
  return "";
}

function parseImageMcp(
  value: unknown,
  issues: string[],
  pathPrefix: string,
): ProjectImageMcpConfig {
  if (!isObject(value)) {
    issues.push(`${pathPrefix}.mcp must be an object`);
    return { loadScript: "" };
  }

  const loadPolicy = optionalPharoMcpLoadPolicyField(
    value,
    "loadPolicy",
    issues,
    `${pathPrefix}.mcp`,
  );

  return {
    port: optionalPortField(value, "port", issues, `${pathPrefix}.mcp`),
    loadScript: imageMcpLoadScriptField(
      value,
      "loadScript",
      issues,
      `${pathPrefix}.mcp`,
      loadPolicy,
    ),
    startupMode: optionalPharoMcpStartupModeField(
      value,
      "startupMode",
      issues,
      `${pathPrefix}.mcp`,
    ),
    loadPolicy,
  };
}

function parsePharoMcpRepository(
  value: unknown,
  issues: string[],
  pathPrefix: string,
): ProjectPharoMcpRepositoryConfig | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isObject(value)) {
    issues.push(`${pathPrefix}.repository must be an object`);
    return undefined;
  }

  return {
    githubUser: stringField(value, "githubUser", issues, `${pathPrefix}.repository`),
    project: stringField(value, "project", issues, `${pathPrefix}.repository`),
    commitish: stringField(value, "commitish", issues, `${pathPrefix}.repository`),
    path: stringFieldAllowingEmpty(
      value,
      "path",
      issues,
      `${pathPrefix}.repository`,
    ),
    baseline: stringField(value, "baseline", issues, `${pathPrefix}.repository`),
  };
}

function parsePreparedImageMcp(
  value: unknown,
  issues: string[],
  pathPrefix: string,
): ProjectPreparedImageMcpConfig {
  if (!isObject(value)) {
    issues.push(`${pathPrefix}.mcp must be an object`);
    return { loadScript: "" };
  }

  return {
    loadScript: stringField(value, "loadScript", issues, `${pathPrefix}.mcp`),
    repository: parsePharoMcpRepository(value.repository, issues, `${pathPrefix}.mcp`),
    startupMode: optionalPharoMcpStartupModeField(
      value,
      "startupMode",
      issues,
      `${pathPrefix}.mcp`,
    ),
  };
}

function parseImageSshConfig(
  value: unknown,
  issues: string[],
  pathPrefix: string,
): ProjectImageSshConfig | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isObject(value)) {
    issues.push(`${pathPrefix}.ssh must be an object`);
    return undefined;
  }

  const username = optionalStringField(value, "username", issues, `${pathPrefix}.ssh`);
  const host = optionalStringField(value, "host", issues, `${pathPrefix}.ssh`);
  const port = optionalPortField(value, "port", issues, `${pathPrefix}.ssh`);
  if (port !== undefined && host === undefined) {
    issues.push(`${pathPrefix}.ssh.host must be set when ${pathPrefix}.ssh.port is set`);
  }

  const hasPublicKey = value.publicKey !== undefined;
  const hasPrivateKey = value.privateKey !== undefined;
  const hasCustomKeys = hasPublicKey || hasPrivateKey;
  const publicKey = hasCustomKeys
    ? stringField(value, "publicKey", issues, `${pathPrefix}.ssh`)
    : undefined;
  const privateKey = hasCustomKeys
    ? stringField(value, "privateKey", issues, `${pathPrefix}.ssh`)
    : undefined;

  return {
    ...(username ? { username } : {}),
    ...(host ? { host } : {}),
    ...(port ? { port } : {}),
    ...(publicKey !== undefined ? { publicKey } : {}),
    ...(privateKey !== undefined ? { privateKey } : {}),
  };
}

function parseImagePlainCredentialsConfig(
  value: unknown,
  issues: string[],
  pathPrefix: string,
): ProjectImagePlainCredentialsConfig | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isObject(value)) {
    issues.push(`${pathPrefix}.plainCredentials must be an object`);
    return undefined;
  }

  return {
    username: stringField(
      value,
      "username",
      issues,
      `${pathPrefix}.plainCredentials`,
    ),
    password: stringField(
      value,
      "password",
      issues,
      `${pathPrefix}.plainCredentials`,
    ),
  };
}

function parseImageGit(
  value: unknown,
  issues: string[],
  pathPrefix: string,
): ProjectImageGitConfig | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isObject(value)) {
    issues.push(`${pathPrefix}.git must be an object`);
    return undefined;
  }

  const transportValue = value.transport ?? "ssh";
  const transport =
    transportValue === "ssh" ||
    transportValue === "https" ||
    transportValue === "http"
      ? transportValue
      : "ssh";

  if (transport !== transportValue) {
    issues.push(`${pathPrefix}.git.transport must be one of ssh, https, http`);
  }

  const ssh = parseImageSshConfig(value.ssh, issues, `${pathPrefix}.git`);
  const plainCredentials = parseImagePlainCredentialsConfig(
    value.plainCredentials,
    issues,
    `${pathPrefix}.git`,
  );
  if (transport === "ssh" && plainCredentials) {
    issues.push(`${pathPrefix}.git.plainCredentials can only be used with https or http`);
  }
  if (transport !== "ssh" && ssh) {
    issues.push(`${pathPrefix}.git.ssh can only be used with ssh`);
  }

  return {
    transport,
    ...(ssh ? { ssh } : {}),
    ...(plainCredentials ? { plainCredentials } : {}),
  };
}

function parseImageCreate(
  value: unknown,
  issues: string[],
  pathPrefix: string,
): ProjectImageCreateConfig | undefined {
  if (value === undefined) {
    return undefined;
  }

  const createPath = `${pathPrefix}.create`;
  if (!isObject(value)) {
    issues.push(`${createPath} must be an object`);
    return undefined;
  }

  const kindValue = value.kind ?? "template";
  const kind = kindValue === "template" ? kindValue : "template";
  if (kind !== kindValue) {
    issues.push(`${createPath}.kind must be template`);
  }

  const profileId = optionalStringField(value, "profileId", issues, createPath);
  const templateName = stringField(value, "templateName", issues, createPath);
  const templateCategory = optionalStringField(
    value,
    "templateCategory",
    issues,
    createPath,
  );
  const role = optionalStringField(value, "role", issues, createPath);
  const cleanupPolicy = optionalImageCreateCleanupPolicyField(
    value,
    "cleanupPolicy",
    issues,
    createPath,
  );

  return {
    kind,
    ...(profileId ? { profileId } : {}),
    templateName,
    ...(templateCategory ? { templateCategory } : {}),
    ...(role ? { role } : {}),
    ...(cleanupPolicy ? { cleanupPolicy } : {}),
  };
}

function parseImagePreparedImage(
  value: unknown,
  issues: string[],
  pathPrefix: string,
): ProjectImagePreparedImageConfig | undefined {
  if (value === undefined) {
    return undefined;
  }

  const preparedPath = `${pathPrefix}.preparedImage`;
  if (!isObject(value)) {
    issues.push(`${preparedPath} must be an object`);
    return undefined;
  }

  const copyModeValue = value.copyMode ?? "copy-on-open";
  const copyMode =
    copyModeValue === "copy-on-open" ? copyModeValue : "copy-on-open";
  if (copyMode !== copyModeValue) {
    issues.push(`${preparedPath}.copyMode must be copy-on-open`);
  }

  return {
    cacheId: stringField(value, "cacheId", issues, preparedPath),
    copyMode,
  };
}

function parseImageRepositoryIdentity(
  value: unknown,
  issues: string[],
  pathPrefix: string,
): ProjectImageRepositoryIdentityConfig {
  if (!isObject(value)) {
    issues.push(`${pathPrefix}.repository must be an object`);
    return { id: "" };
  }

  const componentId = optionalStringField(
    value,
    "componentId",
    issues,
    `${pathPrefix}.repository`,
  );
  const remoteUrl = optionalStringField(
    value,
    "remoteUrl",
    issues,
    `${pathPrefix}.repository`,
  );
  const originPath = optionalStringField(
    value,
    "originPath",
    issues,
    `${pathPrefix}.repository`,
  );
  if (!componentId && !remoteUrl && !originPath) {
    issues.push(
      `${pathPrefix}.repository must set at least one of componentId, remoteUrl, or originPath`,
    );
  }

  return {
    id: stringField(value, "id", issues, `${pathPrefix}.repository`),
    ...(componentId ? { componentId } : {}),
    ...(remoteUrl ? { remoteUrl } : {}),
    ...(originPath ? { originPath } : {}),
  };
}

function parseImageRepositoryWorkspaceMaterialization(
  value: unknown,
  issues: string[],
  pathPrefix: string,
): ProjectImageRepositoryWorkspaceMaterializationConfig {
  const materializationPath = `${pathPrefix}.materialization`;
  if (value === undefined) {
    return { strategy: "copy" };
  }

  if (!isObject(value)) {
    issues.push(`${materializationPath} must be an object`);
    return { strategy: "copy" };
  }

  const strategyValue = value.strategy ?? "copy";
  const strategy =
    strategyValue === "copy" ||
    strategyValue === "git-worktree" ||
    strategyValue === "clone"
      ? strategyValue
      : "copy";
  if (strategy !== strategyValue) {
    issues.push(
      `${materializationPath}.strategy must be one of copy, git-worktree, clone`,
    );
  }

  const path = optionalStringField(value, "path", issues, materializationPath);

  return {
    strategy,
    ...(path ? { path } : {}),
  };
}

function parseImageRepositoryWorkspace(
  value: unknown,
  issues: string[],
  workspacePath: string,
): ProjectImageRepositoryWorkspaceConfig | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isObject(value)) {
    issues.push(`${workspacePath} must be an object`);
    return undefined;
  }

  const pharoVersion = optionalPositiveIntegerField(
    value,
    "pharoVersion",
    issues,
    workspacePath,
  );

  return {
    repository: parseImageRepositoryIdentity(value.repository, issues, workspacePath),
    sourceDirectory: stringField(value, "sourceDirectory", issues, workspacePath),
    baseline: stringField(value, "baseline", issues, workspacePath),
    loadGroup: optionalStringField(value, "loadGroup", issues, workspacePath),
    ...(pharoVersion !== undefined ? { pharoVersion } : {}),
    templateName: optionalStringField(value, "templateName", issues, workspacePath),
    templateCategory: optionalStringField(
      value,
      "templateCategory",
      issues,
      workspacePath,
    ),
    branch: optionalStringField(value, "branch", issues, workspacePath),
    baseBranch: optionalStringField(value, "baseBranch", issues, workspacePath),
    baseCommit: optionalStringField(value, "baseCommit", issues, workspacePath),
    materialization: parseImageRepositoryWorkspaceMaterialization(
      value.materialization,
      issues,
      workspacePath,
    ),
  };
}

function parseImageRepositoryWorkspaces(
  value: unknown,
  issues: string[],
  pathPrefix: string,
): ProjectImageRepositoryWorkspaceConfig[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  const workspacesPath = `${pathPrefix}.repositoryWorkspaces`;
  if (!Array.isArray(value)) {
    issues.push(`${workspacesPath} must be an array`);
    return undefined;
  }

  return value.map((workspace, index) =>
    parseImageRepositoryWorkspace(
      workspace,
      issues,
      `${workspacesPath}[${index}]`,
    ) ?? {
      repository: { id: "" },
      sourceDirectory: "",
      baseline: "",
      materialization: { strategy: "copy" },
    },
  );
}

export function imageRepositoryWorkspaceConfigs(
  image: Pick<ProjectImageConfig, "repositoryWorkspace" | "repositoryWorkspaces">,
): ProjectImageRepositoryWorkspaceConfig[] {
  if (image.repositoryWorkspaces && image.repositoryWorkspaces.length > 0) {
    return image.repositoryWorkspaces;
  }
  return image.repositoryWorkspace ? [image.repositoryWorkspace] : [];
}

function parseImages(
  value: unknown,
  issues: string[],
): ProjectImageConfig[] {
  if (!Array.isArray(value)) {
    issues.push("images must be an array");
    return [];
  }

  return value.map((image, index) => {
    const pathPrefix = `images[${index}]`;
    if (!isObject(image)) {
      issues.push(`${pathPrefix} must be an object`);
      return {
        id: "",
        imageName: "",
        active: false,
        mcp: { loadScript: "" },
      };
    }

    const repositoryWorkspace = parseImageRepositoryWorkspace(
      image.repositoryWorkspace,
      issues,
      `${pathPrefix}.repositoryWorkspace`,
    );
    const repositoryWorkspaces = parseImageRepositoryWorkspaces(
      image.repositoryWorkspaces,
      issues,
      pathPrefix,
    );
    const effectiveRepositoryWorkspaces =
      repositoryWorkspaces ??
      (repositoryWorkspace ? [repositoryWorkspace] : undefined);

    return {
      id: stringField(image, "id", issues, pathPrefix),
      imageName: stringField(image, "imageName", issues, pathPrefix),
      active: booleanField(image, "active", issues, pathPrefix),
      displayMode: optionalImageDisplayModeField(
        image,
        "displayMode",
        issues,
        pathPrefix,
      ),
      mcp: parseImageMcp(image.mcp, issues, pathPrefix),
      create: parseImageCreate(image.create, issues, pathPrefix),
      preparedImage: parseImagePreparedImage(
        image.preparedImage,
        issues,
        pathPrefix,
      ),
      repositoryWorkspace:
        repositoryWorkspace ?? effectiveRepositoryWorkspaces?.[0],
      ...(effectiveRepositoryWorkspaces
        ? { repositoryWorkspaces: effectiveRepositoryWorkspaces }
        : {}),
      git: parseImageGit(image.git, issues, pathPrefix),
    };
  });
}

function parsePreparedImageSource(
  value: unknown,
  issues: string[],
  pathPrefix: string,
): ProjectPreparedImageSourceConfig {
  if (!isObject(value)) {
    issues.push(`${pathPrefix}.source must be an object`);
    return {
      kind: "template",
      templateName: "",
    };
  }

  const kindValue = value.kind ?? "template";
  const kind = kindValue === "template" ? kindValue : "template";
  if (kind !== kindValue) {
    issues.push(`${pathPrefix}.source.kind must be template`);
  }

  return {
    kind,
    profileId: optionalStringField(value, "profileId", issues, `${pathPrefix}.source`),
    templateName: stringField(value, "templateName", issues, `${pathPrefix}.source`),
    templateCategory: optionalStringField(
      value,
      "templateCategory",
      issues,
      `${pathPrefix}.source`,
    ),
  };
}

function parsePreparedImages(
  value: unknown,
  issues: string[],
): ProjectPreparedImageConfig[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value)) {
    issues.push("preparedImages must be an array");
    return undefined;
  }

  return value.map((preparedImage, index) => {
    const pathPrefix = `preparedImages[${index}]`;
    if (!isObject(preparedImage)) {
      issues.push(`${pathPrefix} must be an object`);
      return {
        id: "",
        imageName: "",
        source: {
          kind: "template",
          templateName: "",
        },
        mcp: {
          loadScript: "",
        },
      };
    }

    return {
      id: stringField(preparedImage, "id", issues, pathPrefix),
      imageName: stringField(preparedImage, "imageName", issues, pathPrefix),
      source: parsePreparedImageSource(
        preparedImage.source,
        issues,
        pathPrefix,
      ),
      mcp: parsePreparedImageMcp(preparedImage.mcp, issues, pathPrefix),
    };
  });
}

function parseRuntimeStateRoot(
  value: unknown,
  issues: string[],
): ProjectRuntimeStateRootPolicy {
  if (value === undefined) {
    return { ...defaultProjectRuntimePolicy().stateRoot };
  }

  if (!isObject(value)) {
    issues.push("runtime.stateRoot must be an object");
    return { ...defaultProjectRuntimePolicy().stateRoot };
  }

  const modeValue = value.mode ?? "project-local";
  const mode =
    modeValue === "project-local" || modeValue === "external"
      ? modeValue
      : "project-local";
  if (mode !== modeValue) {
    issues.push("runtime.stateRoot.mode must be one of project-local, external");
  }

  if (mode === "external") {
    return {
      mode,
      path: stringField(value, "path", issues, "runtime.stateRoot"),
    };
  }

  if (value.path !== undefined) {
    issues.push(
      "runtime.stateRoot.path can only be used when runtime.stateRoot.mode is \"external\"",
    );
  }

  return { mode };
}

function parseProjectLocalGateway(
  value: Record<string, unknown>,
  issues: string[],
): ProjectLocalGatewayPolicy {
  const defaultGateway = defaultProjectRuntimePolicy()
    .gateway as ProjectLocalGatewayPolicy;
  const port = optionalPortField(value, "port", issues, "runtime.gateway");
  const hasPortRange = value.portRange !== undefined;
  const parsedPortRange = hasPortRange
    ? parseRuntimePortRange(
        value.portRange,
        issues,
        "runtime.gateway.portRange",
        defaultGateway.portRange ?? { start: 8_133, end: 8_199 },
      )
    : undefined;

  if (port !== undefined && hasPortRange) {
    issues.push("runtime.gateway must use either port or portRange, not both");
  }

  const portPolicy =
    port !== undefined
      ? { port }
      : { portRange: parsedPortRange ?? defaultGateway.portRange };

  return {
    mode: "project-local",
    host: stringFieldWithDefault(
      value,
      "host",
      issues,
      "runtime.gateway",
      defaultGateway.host,
    ),
    ...portPolicy,
    agentMcpPath: pathFieldWithDefault(
      value,
      "agentMcpPath",
      issues,
      "runtime.gateway",
      defaultGateway.agentMcpPath,
    ),
    routeControlMcpPath: pathFieldWithDefault(
      value,
      "routeControlMcpPath",
      issues,
      "runtime.gateway",
      defaultGateway.routeControlMcpPath,
    ),
  };
}

function parseSharedGateway(
  value: Record<string, unknown>,
  issues: string[],
): ProjectSharedGatewayPolicy {
  return {
    mode: "shared",
    agentMcpUrl: urlField(value, "agentMcpUrl", issues, "runtime.gateway"),
    routeControlMcpUrl: urlField(
      value,
      "routeControlMcpUrl",
      issues,
      "runtime.gateway",
    ),
  };
}

function parseRuntimeGateway(
  value: unknown,
  issues: string[],
): ProjectGatewayPolicy {
  if (value === undefined) {
    return {
      ...(defaultProjectRuntimePolicy().gateway as ProjectLocalGatewayPolicy),
    };
  }

  if (!isObject(value)) {
    issues.push("runtime.gateway must be an object");
    return {
      ...(defaultProjectRuntimePolicy().gateway as ProjectLocalGatewayPolicy),
    };
  }

  const modeValue = value.mode ?? "project-local";
  if (modeValue === "shared") {
    return parseSharedGateway(value, issues);
  }

  if (modeValue !== "project-local") {
    issues.push("runtime.gateway.mode must be one of project-local, shared");
  }

  return parseProjectLocalGateway(value, issues);
}

function parseRemoteNodeTargetMappings(
  value: unknown,
  issues: string[],
  pathPrefix: string,
): ProjectRemoteNodeTargetMappingConfig[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value)) {
    issues.push(`${pathPrefix}.targets must be an array`);
    return undefined;
  }

  return value.map((item, index) => {
    const itemPath = `${pathPrefix}.targets[${index}]`;
    if (!isObject(item)) {
      issues.push(`${itemPath} must be an object`);
      return {
        targetId: "",
      };
    }

    const remoteTargetId = optionalStringField(
      item,
      "remoteTargetId",
      issues,
      itemPath,
    );

    return {
      targetId: stringField(item, "targetId", issues, itemPath),
      ...(remoteTargetId ? { remoteTargetId } : {}),
    };
  });
}

function parseRemoteNodeWorkspaceMappings(
  value: unknown,
  issues: string[],
  pathPrefix: string,
): ProjectRemoteNodeWorkspaceMappingConfig[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value)) {
    issues.push(`${pathPrefix}.workspaces must be an array`);
    return undefined;
  }

  return value.map((item, index) => {
    const itemPath = `${pathPrefix}.workspaces[${index}]`;
    if (!isObject(item)) {
      issues.push(`${itemPath} must be an object`);
      return {
        workspaceId: "",
      };
    }

    const remoteWorkspaceId = optionalStringField(
      item,
      "remoteWorkspaceId",
      issues,
      itemPath,
    );
    const remoteProjectPath = optionalStringField(
      item,
      "remoteProjectPath",
      issues,
      itemPath,
    );
    const targets = parseRemoteNodeTargetMappings(item.targets, issues, itemPath);

    return {
      workspaceId: stringField(item, "workspaceId", issues, itemPath),
      ...(remoteWorkspaceId ? { remoteWorkspaceId } : {}),
      ...(remoteProjectPath ? { remoteProjectPath } : {}),
      ...(targets ? { targets } : {}),
    };
  });
}

function parseRemoteNodes(
  value: unknown,
  issues: string[],
): ProjectRemoteNodeConfig[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value)) {
    issues.push("runtime.remoteNodes must be an array");
    return undefined;
  }

  return value.map((item, index) => {
    const itemPath = `runtime.remoteNodes[${index}]`;
    if (!isObject(item)) {
      issues.push(`${itemPath} must be an object`);
      return {
        id: "",
        projectMcpUrl: "",
        gatewayMcpUrl: "",
      };
    }

    const workspaces = parseRemoteNodeWorkspaceMappings(
      item.workspaces,
      issues,
      itemPath,
    );
    const parentNodeId = optionalStringField(
      item,
      "parentNodeId",
      issues,
      itemPath,
    );

    return {
      id: stringField(item, "id", issues, itemPath),
      ...(parentNodeId ? { parentNodeId } : {}),
      projectMcpUrl: urlField(item, "projectMcpUrl", issues, itemPath),
      gatewayMcpUrl: urlField(item, "gatewayMcpUrl", issues, itemPath),
      ...(workspaces ? { workspaces } : {}),
    };
  });
}

function parseImagePortCoordination(
  value: unknown,
  issues: string[],
): ProjectImagePortCoordinationPolicy {
  if (value === undefined) {
    return { ...defaultProjectRuntimePolicy().imagePorts.coordination };
  }

  if (!isObject(value)) {
    issues.push("runtime.imagePorts.coordination must be an object");
    return { ...defaultProjectRuntimePolicy().imagePorts.coordination };
  }

  const defaultMode = defaultProjectRuntimePolicy().imagePorts.coordination.mode;
  const modeValue = value.mode ?? defaultMode;
  const mode =
    modeValue === "project-state" || modeValue === "host-local"
      ? modeValue
      : defaultMode;
  if (mode !== modeValue) {
    issues.push(
      "runtime.imagePorts.coordination.mode must be one of project-state, host-local",
    );
  }

  const root = optionalStringField(
    value,
    "root",
    issues,
    "runtime.imagePorts.coordination",
  );
  if (root && mode !== "host-local") {
    issues.push(
      "runtime.imagePorts.coordination.root can only be used when mode is \"host-local\"",
    );
  }

  return {
    mode,
    ...(root && mode === "host-local" ? { root } : {}),
  };
}

function parseImagePortPolicy(
  value: unknown,
  issues: string[],
): ProjectImagePortPolicy {
  const defaults = defaultProjectRuntimePolicy().imagePorts;
  if (value === undefined) {
    return {
      allocation: defaults.allocation,
      range: { ...defaults.range },
      coordination: { ...defaults.coordination },
    };
  }

  if (!isObject(value)) {
    issues.push("runtime.imagePorts must be an object");
    return {
      allocation: defaults.allocation,
      range: { ...defaults.range },
      coordination: { ...defaults.coordination },
    };
  }

  const allocationValue = value.allocation ?? defaults.allocation;
  const allocation =
    allocationValue === "configured-or-dynamic" ||
    allocationValue === "dynamic-only" ||
    allocationValue === "configured-only"
      ? allocationValue
      : defaults.allocation;
  if (allocation !== allocationValue) {
    issues.push(
      "runtime.imagePorts.allocation must be one of " +
        "configured-or-dynamic, dynamic-only, configured-only",
    );
  }

  return {
    allocation,
    range:
      value.range === undefined
        ? { ...defaults.range }
        : parseRuntimePortRange(
            value.range,
            issues,
            "runtime.imagePorts.range",
            defaults.range,
          ),
    coordination: parseImagePortCoordination(value.coordination, issues),
  };
}

function parseLauncherProfilePolicy(
  value: unknown,
  issues: string[],
): ProjectLauncherProfilePolicy {
  if (value === undefined) {
    return { ...defaultProjectRuntimePolicy().launcherProfile };
  }

  if (!isObject(value)) {
    issues.push("runtime.launcherProfile must be an object");
    return { ...defaultProjectRuntimePolicy().launcherProfile };
  }

  const modeValue = value.mode ?? "project-owned";
  const mode =
    modeValue === "project-owned" || modeValue === "external"
      ? modeValue
      : "project-owned";
  if (mode !== modeValue) {
    issues.push(
      "runtime.launcherProfile.mode must be one of project-owned, external",
    );
  }

  const name = optionalStringField(
    value,
    "name",
    issues,
    "runtime.launcherProfile",
  );
  const root = optionalStringField(
    value,
    "root",
    issues,
    "runtime.launcherProfile",
  );
  const templateCatalog = parseLauncherTemplateCatalogPolicy(
    value.templateCatalog,
    issues,
  );

  return {
    mode,
    ...(name ? { name } : {}),
    ...(root ? { root } : {}),
    ...(templateCatalog
      ? {
          templateCatalog,
        }
      : {}),
  };
}

function parseLauncherTemplateCatalogPolicy(
  value: unknown,
  issues: string[],
): ProjectLauncherTemplateCatalogPolicy | undefined {
  if (value === undefined) {
    return undefined;
  }

  const pathPrefix = "runtime.launcherProfile.templateCatalog";
  if (!isObject(value)) {
    issues.push(`${pathPrefix} must be an object`);
    return undefined;
  }

  const pathValue = optionalStringField(value, "path", issues, pathPrefix);
  const sourceValue = value.source ?? (pathValue ? "path" : "user-or-server");
  const source =
    sourceValue === "user-or-server" ||
    sourceValue === "user" ||
    sourceValue === "server" ||
    sourceValue === "path" ||
    sourceValue === "none"
      ? sourceValue
      : "user-or-server";
  if (source !== sourceValue) {
    issues.push(
      `${pathPrefix}.source must be one of user-or-server, user, server, path, none`,
    );
  }
  if (source === "path" && !pathValue) {
    issues.push(`${pathPrefix}.path must be set when source is path`);
  }

  const serverSourcesUrl = optionalUrlField(
    value,
    "serverSourcesUrl",
    issues,
    pathPrefix,
  );

  return {
    source,
    ...(pathValue ? { path: pathValue } : {}),
    ...(serverSourcesUrl ? { serverSourcesUrl } : {}),
  };
}

function parsePharoMcpPolicy(
  value: unknown,
  issues: string[],
): ProjectPharoMcpPolicy {
  const defaults = defaultProjectRuntimePolicy().pharoMcp;
  if (value === undefined) {
    return {
      metadataKey: defaults.metadataKey,
      supportedMajorVersions: [...defaults.supportedMajorVersions],
    };
  }

  if (!isObject(value)) {
    issues.push("runtime.pharoMcp must be an object");
    return {
      metadataKey: defaults.metadataKey,
      supportedMajorVersions: [...defaults.supportedMajorVersions],
    };
  }

  return {
    metadataKey: stringFieldWithDefault(
      value,
      "metadataKey",
      issues,
      "runtime.pharoMcp",
      defaults.metadataKey,
    ),
    supportedMajorVersions: parsePositiveIntegerArray(
      value.supportedMajorVersions,
      issues,
      "runtime.pharoMcp.supportedMajorVersions",
      defaults.supportedMajorVersions,
    ),
  };
}

function parseWorkspaceImagePolicy(
  value: unknown,
  issues: string[],
): ProjectWorkspaceImagePolicy | undefined {
  if (value === undefined) {
    return undefined;
  }

  const pathPrefix = "runtime.workspaceImages";
  if (!isObject(value)) {
    issues.push(`${pathPrefix} must be an object`);
    return undefined;
  }

  const maxCount = optionalPositiveIntegerField(
    value,
    "maxCount",
    issues,
    pathPrefix,
  );

  return {
    ...(maxCount !== undefined ? { maxCount } : {}),
  };
}

function parseRuntimePolicy(
  value: unknown,
  issues: string[],
): ProjectRuntimePolicy {
  if (value === undefined) {
    return defaultProjectRuntimePolicy();
  }

  if (!isObject(value)) {
    issues.push("runtime must be an object");
    return defaultProjectRuntimePolicy();
  }

  const scopeValue = value.scope ?? "project";
  if (scopeValue !== "project") {
    issues.push("runtime.scope must be \"project\"");
  }
  const workspaceImages = parseWorkspaceImagePolicy(
    value.workspaceImages,
    issues,
  );
  const remoteNodes = parseRemoteNodes(value.remoteNodes, issues);
  const nodeId = optionalStringField(value, "nodeId", issues, "runtime");

  return {
    scope: "project",
    ...(nodeId ? { nodeId } : {}),
    stateRoot: parseRuntimeStateRoot(value.stateRoot, issues),
    gateway: parseRuntimeGateway(value.gateway, issues),
    imagePorts: parseImagePortPolicy(value.imagePorts, issues),
    ...(workspaceImages ? { workspaceImages } : {}),
    ...(remoteNodes ? { remoteNodes } : {}),
    launcherProfile: parseLauncherProfilePolicy(
      value.launcherProfile,
      issues,
    ),
    pharoMcp: parsePharoMcpPolicy(value.pharoMcp, issues),
  };
}

function collectDuplicates(
  values: string[],
  label: string,
  issues: string[],
): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (!value) {
      continue;
    }

    if (seen.has(value)) {
      issues.push(`${label} must be unique: ${value}`);
    } else {
      seen.add(value);
    }
  }
}

function collectDuplicatePorts(images: ProjectImageConfig[], issues: string[]): void {
  const seen = new Set<number>();
  for (const image of images) {
    if (projectMcpStartupMode(image.mcp) === "disabled") {
      continue;
    }

    const port = image.mcp.port;
    if (!port) {
      continue;
    }

    if (seen.has(port)) {
      issues.push(`image MCP ports must be unique: ${port}`);
    } else {
      seen.add(port);
    }
  }
}

function collectDuplicateActiveRepositoryWorkspacePaths(
  images: ProjectImageConfig[],
  issues: string[],
): void {
  const seen = new Set<string>();
  for (const image of images) {
    if (!image.active) {
      continue;
    }

    for (const workspace of imageRepositoryWorkspaceConfigs(image)) {
      const path = workspace.materialization.path;
      if (!path) {
        continue;
      }

      if (seen.has(path)) {
        issues.push(`active image repository workspace paths must be unique: ${path}`);
      } else {
        seen.add(path);
      }
    }
  }
}

function collectDuplicateRepositoryWorkspaceIds(
  images: ProjectImageConfig[],
  issues: string[],
): void {
  images.forEach((image, imageIndex) => {
    const seen = new Set<string>();
    for (const workspace of imageRepositoryWorkspaceConfigs(image)) {
      const repositoryId = workspace.repository.id;
      if (seen.has(repositoryId)) {
        issues.push(
          `images[${imageIndex}] repository workspace ids must be unique: ${repositoryId}`,
        );
      } else {
        seen.add(repositoryId);
      }
    }
  });
}

function validateImagePortPolicy(config: ProjectConfig, issues: string[]): void {
  const allocation = resolveProjectRuntimePolicy(config).imagePorts.allocation;
  config.images.forEach((image, index) => {
    if (projectMcpStartupMode(image.mcp) === "disabled") {
      return;
    }

    if (allocation === "dynamic-only" && image.mcp.port !== undefined) {
      issues.push(
        `images[${index}].mcp.port cannot be used when ` +
          `runtime.imagePorts.allocation is "dynamic-only"`,
      );
    }
    if (allocation === "configured-only" && image.mcp.port === undefined) {
      issues.push(
        `images[${index}].mcp.port is required when ` +
          `runtime.imagePorts.allocation is "configured-only"`,
      );
    }
  });
}

function validatePreparedImageReferences(
  config: ProjectConfig,
  issues: string[],
): void {
  const preparedImageIds = new Set(
    config.preparedImages?.map((preparedImage) => preparedImage.id) ?? [],
  );

  config.images.forEach((image, index) => {
    const cacheId = image.preparedImage?.cacheId;
    if (cacheId && !preparedImageIds.has(cacheId)) {
      issues.push(
        `images[${index}].preparedImage.cacheId must reference a preparedImages id: ${cacheId}`,
      );
    }
  });
}

function validateRemoteNodeConfig(config: ProjectConfig, issues: string[]): void {
  const runtime = resolveProjectRuntimePolicy(config);
  const localNodeId = runtime.nodeId ?? projectConfigId(config);
  const remoteNodes = runtime.remoteNodes ?? [];
  collectDuplicates(
    remoteNodes.map((remoteNode) => remoteNode.id),
    "remote node ids",
    issues,
  );

  remoteNodes.forEach((remoteNode, remoteNodeIndex) => {
    if (remoteNode.id === localNodeId) {
      issues.push(
        `runtime.remoteNodes[${remoteNodeIndex}].id must differ from runtime node id: ${localNodeId}`,
      );
    }

    if (remoteNode.parentNodeId === remoteNode.id) {
      issues.push(
        `runtime.remoteNodes[${remoteNodeIndex}].parentNodeId must not equal its own id: ${remoteNode.id}`,
      );
    } else if (
      remoteNode.parentNodeId !== undefined &&
      remoteNode.parentNodeId !== localNodeId
    ) {
      issues.push(
        `runtime.remoteNodes[${remoteNodeIndex}].parentNodeId must be omitted or match runtime node id ${localNodeId} for flat-tree topology`,
      );
    }

    collectDuplicates(
      remoteNode.workspaces?.map((workspace) => workspace.workspaceId) ?? [],
      `runtime.remoteNodes[${remoteNodeIndex}].workspaces.workspaceId`,
      issues,
    );

    remoteNode.workspaces?.forEach((workspace, workspaceIndex) => {
      collectDuplicates(
        workspace.targets?.map((target) => target.targetId) ?? [],
        `runtime.remoteNodes[${remoteNodeIndex}].workspaces[${workspaceIndex}].targets.targetId`,
        issues,
      );
    });
  });
}

export function parseProjectConfig(value: unknown): ProjectConfig {
  const issues: string[] = [];

  if (!isObject(value)) {
    throw new ProjectConfigError("Invalid Plexus project config", [
      "config must be an object",
    ]);
  }

  const legacyKanban = parseKanban(value.kanban, issues);
  const home = parseHome(value.home, issues);
  const preparedImages = parsePreparedImages(value.preparedImages, issues);
  const config: ProjectConfig = {
    id: parseProjectIdentity(value, legacyKanban, issues),
    name: stringField(value, "name", issues, "config"),
    ...(legacyKanban ? { kanban: legacyKanban } : {}),
    ...(home ? { home } : {}),
    runtime: parseRuntimePolicy(value.runtime, issues),
    ...(preparedImages ? { preparedImages } : {}),
    images: parseImages(value.images, issues),
  };

  collectDuplicates(
    config.images.map((image) => image.id),
    "image ids",
    issues,
  );
  collectDuplicates(
    config.images.map((image) => image.imageName),
    "image names",
    issues,
  );
  collectDuplicates(
    config.preparedImages?.map((preparedImage) => preparedImage.id) ?? [],
    "prepared image ids",
    issues,
  );
  collectDuplicates(
    config.preparedImages?.map((preparedImage) => preparedImage.imageName) ?? [],
    "prepared image names",
    issues,
  );
  collectDuplicatePorts(config.images, issues);
  collectDuplicateRepositoryWorkspaceIds(config.images, issues);
  collectDuplicateActiveRepositoryWorkspacePaths(config.images, issues);
  validateImagePortPolicy(config, issues);
  validatePreparedImageReferences(config, issues);
  validateRemoteNodeConfig(config, issues);

  if (issues.length > 0) {
    throw new ProjectConfigError("Invalid Plexus project config", issues);
  }

  return config;
}

export function projectConfigPath(projectRoot: string): string {
  return joinPathLike(projectRoot, plexusProjectConfigFileName);
}

export function loadProjectConfig(projectRoot: string): ProjectConfig {
  const filePath = projectConfigPath(projectRoot);
  const raw = fs.readFileSync(filePath, "utf8");

  return parseProjectConfig(JSON.parse(raw));
}
