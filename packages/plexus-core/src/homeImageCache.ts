import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import {
  defaultPharoMcpMetacelloRepository,
  type PharoMcpMetacelloRepository,
} from "./projectStartupScript.js";
import {
  projectConfigId,
  resolveProjectRuntimePolicy,
  type ProjectConfig,
  type ProjectImageConfig,
  type ProjectImageCreateConfig,
  type ProjectImageGitConfig,
  type ProjectImageMcpConfig,
  type ProjectPreparedImageConfig,
  type ProjectPreparedImageMcpConfig,
  type ProjectPreparedImageSourceConfig,
} from "./projectConfig.js";
import {
  dirnamePathLike,
  isAbsolutePathLike,
  joinPathLike,
  resolvePathLike,
} from "./pathStyle.js";
import {
  pharoLauncherMcpProfileEnvironment,
  type PharoLauncherMcpProfilePaths,
} from "./pharoLauncherProfile.js";
import type { ProjectImageState } from "./projectState.js";

export const plexusHomeEnvironmentKey = "PLEXUS_HOME";
export const defaultPlexusHomeDirectoryName = ".plexus";
export const homeImageCacheDirectoryName = "image-cache";
export const homeImageCacheSchemaVersion = 1;

export type HomeImageCachePlanStatus =
  | "disabled"
  | "hit"
  | "miss"
  | "corrupt"
  | "in-progress";

export type HomeImageCachePharoMcpSupportStatus =
  | "supported"
  | "unsupported"
  | "unknown";

export type HomeImageCachePreparationStatus =
  | "pending"
  | "prepared"
  | "skipped"
  | "failed";

export interface HomeImageCacheTemplateMetadata {
  identity?: unknown;
  architecture?: string;
  launcherVersion?: string;
  pharoVersion?: string;
  sourceFile?: unknown;
}

export interface HomeImageCacheSource {
  kind: "template";
  profileId?: string;
  templateName: string;
  templateCategory?: string;
}

export interface HomeImageCachePharoMcpSupport {
  status: HomeImageCachePharoMcpSupportStatus;
  actualMajorVersion?: number;
  supportedMajorVersions: number[];
  metadataKey: string;
  reason: string;
}

export interface HomeImageCacheKeyMaterial {
  schemaVersion: number;
  projectCachePolicy: {
    pharoMcpPreparation: "load-when-supported";
  };
  source: HomeImageCacheSource;
  templateMetadata?: HomeImageCacheTemplateMetadata;
  pharoMcp: {
    support: HomeImageCachePharoMcpSupport;
    loadScript: string;
    repository: PharoMcpMetacelloRepository;
  };
  git?: {
    transport: ProjectImageGitConfig["transport"];
  };
}

export interface HomeImageCacheManifest {
  schemaVersion: number;
  key: string;
  createdAt: string;
  updatedAt: string;
  cacheImageName: string;
  source: HomeImageCacheSource;
  templateMetadata?: HomeImageCacheTemplateMetadata;
  pharoMcp: {
    support: HomeImageCachePharoMcpSupport;
    preparationStatus: HomeImageCachePreparationStatus;
    diagnostics?: string[];
  };
  launcherImage?: {
    imageName?: string;
    imagePath?: string;
    pharoVersion?: string;
    architecture?: string;
    vmId?: string;
    originTemplate?: {
      name?: string;
      url?: string;
    };
  };
  paths: {
    entryDirectory: string;
    manifestPath: string;
    lockPath: string;
    preparationScriptPath: string;
    profileStateRoot: string;
  };
}

export type HomeImageCacheManifestReadResult =
  | {
      status: "missing";
      manifestPath: string;
    }
  | {
      status: "ok";
      manifestPath: string;
      manifest: HomeImageCacheManifest;
    }
  | {
      status: "corrupt";
      manifestPath: string;
      error: string;
    };

export interface HomeImageCacheLockRecord {
  key: string;
  owner: string;
  acquiredAt: string;
}

export type HomeImageCacheLockReadResult =
  | {
      status: "missing";
      lockPath: string;
    }
  | {
      status: "ok";
      lockPath: string;
      lock: HomeImageCacheLockRecord;
    }
  | {
      status: "corrupt";
      lockPath: string;
      error: string;
    };

export interface HomeImageCacheLiveOperation {
  toolName: string;
  argumentsValue: Record<string, unknown>;
  profileEnvironment?: Record<string, string>;
  requiresApproval: true;
  reason: string;
}

export interface HomeImageCachePlan {
  status: HomeImageCachePlanStatus;
  key: string;
  projectRoot: string;
  homePath: string;
  cacheRoot: string;
  entryDirectory: string;
  manifestPath: string;
  lockPath: string;
  cacheImageName: string;
  source: HomeImageCacheSource;
  support: HomeImageCachePharoMcpSupport;
  manifest: HomeImageCacheManifestReadResult;
  lock: HomeImageCacheLockReadResult;
  homeProfile: Required<PharoLauncherMcpProfilePaths>;
  keyMaterial: HomeImageCacheKeyMaterial;
  expectedManifest: HomeImageCacheManifest;
  createCacheImage?: HomeImageCacheLiveOperation;
  prepareCacheImage?: HomeImageCacheLiveOperation;
  runtimeCopy?: HomeImageCacheLiveOperation;
  diagnostics: string[];
}

export interface BuildHomeImageCachePlanOptions {
  projectRoot: string;
  config: ProjectConfig;
  imageConfig: ProjectImageConfig;
  imageState?: ProjectImageState;
  workspaceId?: string;
  targetId?: string;
  stateRoot?: string;
  env?: NodeJS.ProcessEnv;
  homeDirectory?: string;
  now?: () => Date;
  templateMetadata?: HomeImageCacheTemplateMetadata;
}

export interface HomeImageCacheFlushPlan {
  homePath: string;
  cacheRoot: string;
  key?: string;
  entries: Array<{
    key: string;
    entryDirectory: string;
    manifestPath: string;
    lockPath: string;
    exists: boolean;
  }>;
}

export class HomeImageCacheError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HomeImageCacheError";
  }
}

function removeUndefined(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(removeUndefined);
  }

  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => entryValue !== undefined)
      .map(([key, entryValue]) => [key, removeUndefined(entryValue)] as const)
      .sort(([left], [right]) => left.localeCompare(right));
    return Object.fromEntries(entries);
  }

  return value;
}

function stableJson(value: unknown): string {
  return JSON.stringify(removeUndefined(value));
}

function sha256Hex(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function safeCacheKey(value: string): string {
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw new HomeImageCacheError(`Invalid home image cache key: ${value}`);
  }

  return value;
}

function toMetacelloRepository(
  repository: ProjectPreparedImageMcpConfig["repository"] | undefined,
): PharoMcpMetacelloRepository {
  return repository ?? defaultPharoMcpMetacelloRepository;
}

function sourceFromProjectImage(
  config: ProjectConfig,
  imageConfig: ProjectImageConfig,
): {
  source: HomeImageCacheSource;
  mcp: ProjectPreparedImageMcpConfig | ProjectImageMcpConfig;
} {
  if (imageConfig.preparedImage?.cacheId) {
    const preparedImage = config.preparedImages?.find(
      (candidate) => candidate.id === imageConfig.preparedImage?.cacheId,
    );
    if (!preparedImage) {
      throw new HomeImageCacheError(
        `Project image ${imageConfig.id} references unknown prepared image cache: ${imageConfig.preparedImage.cacheId}`,
      );
    }

    return {
      source: preparedSource(preparedImage),
      mcp: preparedImage.mcp,
    };
  }

  if (imageConfig.create) {
    return {
      source: createSource(imageConfig.create),
      mcp: imageConfig.mcp,
    };
  }

  throw new HomeImageCacheError(
    `Project image ${imageConfig.id} has no template create or prepared image source`,
  );
}

function createSource(source: ProjectImageCreateConfig): HomeImageCacheSource {
  return {
    kind: "template",
    ...(source.profileId ? { profileId: source.profileId } : {}),
    templateName: source.templateName,
    ...(source.templateCategory
      ? { templateCategory: source.templateCategory }
      : {}),
  };
}

function preparedSource(
  preparedImage: ProjectPreparedImageConfig,
): HomeImageCacheSource {
  return preparedTemplateSource(preparedImage.source);
}

function preparedTemplateSource(
  source: ProjectPreparedImageSourceConfig,
): HomeImageCacheSource {
  return {
    kind: "template",
    ...(source.profileId ? { profileId: source.profileId } : {}),
    templateName: source.templateName,
    ...(source.templateCategory
      ? { templateCategory: source.templateCategory }
      : {}),
  };
}

export function defaultPlexusHomePath(homeDirectory = os.homedir()): string {
  return joinPathLike(homeDirectory, defaultPlexusHomeDirectoryName);
}

export function resolvePlexusHomePath(options: {
  config?: Pick<ProjectConfig, "home">;
  env?: NodeJS.ProcessEnv;
  homeDirectory?: string;
} = {}): string {
  const env = options.env ?? process.env;
  const configured = env[plexusHomeEnvironmentKey] ?? options.config?.home?.path;
  return configured
    ? resolvePathLike(configured)
    : defaultPlexusHomePath(options.homeDirectory);
}

export function homeImageCacheEnabled(
  config: Pick<ProjectConfig, "home">,
): boolean {
  return config.home?.imageCache.enabled ?? true;
}

export function homeImageCacheRootPath(homePath: string): string {
  return joinPathLike(homePath, homeImageCacheDirectoryName);
}

export function homeImageCacheEntryDirectory(
  cacheRoot: string,
  key: string,
): string {
  return joinPathLike(cacheRoot, "entries", safeCacheKey(key));
}

export function homeImageCacheManifestPath(
  cacheRoot: string,
  key: string,
): string {
  return joinPathLike(homeImageCacheEntryDirectory(cacheRoot, key), "manifest.json");
}

export function homeImageCacheLockPath(cacheRoot: string, key: string): string {
  return joinPathLike(cacheRoot, "locks", safeCacheKey(key));
}

export function homeImageCachePreparationScriptPath(
  cacheRoot: string,
  key: string,
): string {
  return joinPathLike(homeImageCacheEntryDirectory(cacheRoot, key), "prepare.st");
}

export function homeImageCacheImageName(key: string): string {
  return `PlexusHomeCache-${safeCacheKey(key).slice(0, 24)}`;
}

export function homeImageCacheProfile(
  homePath: string,
): Required<PharoLauncherMcpProfilePaths> {
  const stateRoot = joinPathLike(
    homePath,
    "profiles",
    "pharo-launcher-mcp",
    "image-cache",
  );
  return {
    profileName: "plexus-home-image-cache",
    stateRoot,
    launcherImage: joinPathLike(stateRoot, "launcher", "PharoLauncher.image"),
    imagesDir: joinPathLike(stateRoot, "images"),
    vmsDir: joinPathLike(stateRoot, "vms"),
    templateSourcesDir: joinPathLike(stateRoot, "templates"),
    initScriptsDir: joinPathLike(stateRoot, "init-scripts"),
    logsDir: joinPathLike(stateRoot, "logs"),
    launcherConfiguration: joinPathLike(
      stateRoot,
      "launcher",
      "pharo-launcher-cli-config.ston",
    ),
  };
}

export function profileEnvironmentFromPaths(
  paths: Required<PharoLauncherMcpProfilePaths>,
): Record<string, string> {
  return {
    PHARO_LAUNCHER_MCP_PROFILE: paths.profileName,
    PHARO_LAUNCHER_MCP_STATE_ROOT: paths.stateRoot,
    PHARO_LAUNCHER_MCP_LAUNCHER_IMAGE: paths.launcherImage,
    PHARO_LAUNCHER_MCP_IMAGES_DIR: paths.imagesDir,
    PHARO_LAUNCHER_MCP_VMS_DIR: paths.vmsDir,
    PHARO_LAUNCHER_MCP_TEMPLATE_SOURCES_DIR: paths.templateSourcesDir,
    PHARO_LAUNCHER_MCP_INIT_SCRIPTS_DIR: paths.initScriptsDir,
    PHARO_LAUNCHER_MCP_LOGS_DIR: paths.logsDir,
    PHARO_LAUNCHER_MCP_LAUNCHER_CONFIGURATION:
      paths.launcherConfiguration,
  };
}

export function profilePathsFromEnvironment(
  environment: Record<string, string> | undefined,
): Required<PharoLauncherMcpProfilePaths> | undefined {
  if (!environment) {
    return undefined;
  }

  const requiredKeys = [
    "PHARO_LAUNCHER_MCP_PROFILE",
    "PHARO_LAUNCHER_MCP_STATE_ROOT",
    "PHARO_LAUNCHER_MCP_LAUNCHER_IMAGE",
    "PHARO_LAUNCHER_MCP_IMAGES_DIR",
    "PHARO_LAUNCHER_MCP_VMS_DIR",
    "PHARO_LAUNCHER_MCP_TEMPLATE_SOURCES_DIR",
    "PHARO_LAUNCHER_MCP_INIT_SCRIPTS_DIR",
    "PHARO_LAUNCHER_MCP_LOGS_DIR",
    "PHARO_LAUNCHER_MCP_LAUNCHER_CONFIGURATION",
  ] as const;
  if (requiredKeys.some((key) => !environment[key])) {
    return undefined;
  }

  return {
    profileName: environment.PHARO_LAUNCHER_MCP_PROFILE,
    stateRoot: environment.PHARO_LAUNCHER_MCP_STATE_ROOT,
    launcherImage: environment.PHARO_LAUNCHER_MCP_LAUNCHER_IMAGE,
    imagesDir: environment.PHARO_LAUNCHER_MCP_IMAGES_DIR,
    vmsDir: environment.PHARO_LAUNCHER_MCP_VMS_DIR,
    templateSourcesDir:
      environment.PHARO_LAUNCHER_MCP_TEMPLATE_SOURCES_DIR,
    initScriptsDir: environment.PHARO_LAUNCHER_MCP_INIT_SCRIPTS_DIR,
    logsDir: environment.PHARO_LAUNCHER_MCP_LOGS_DIR,
    launcherConfiguration:
      environment.PHARO_LAUNCHER_MCP_LAUNCHER_CONFIGURATION,
  };
}

export function inferPharoMajorVersionFromTemplateText(
  value: string | undefined,
): number | undefined {
  if (!value) {
    return undefined;
  }

  const namedMatch = /\b(?:Pharo|Moose)\s*(\d{1,2})(?:\.\d+)?\b/i.exec(value);
  if (namedMatch) {
    return Number.parseInt(namedMatch[1], 10);
  }

  const numericMatch = /^(\d{1,2})(?:\.\d+)?$/.exec(value.trim());
  if (numericMatch) {
    return Number.parseInt(numericMatch[1], 10);
  }

  const launcherVersionMatch = /^(\d{2})0$/.exec(value.trim());
  if (launcherVersionMatch) {
    return Number.parseInt(launcherVersionMatch[1], 10);
  }

  return undefined;
}

export function classifyHomeImageCachePharoMcpSupport(options: {
  config: ProjectConfig;
  source: HomeImageCacheSource;
  templateMetadata?: HomeImageCacheTemplateMetadata;
}): HomeImageCachePharoMcpSupport {
  const policy = resolveProjectRuntimePolicy(options.config).pharoMcp;
  const majorVersion =
    inferPharoMajorVersionFromTemplateText(
      options.templateMetadata?.pharoVersion,
    ) ?? inferPharoMajorVersionFromTemplateText(options.source.templateName);
  if (majorVersion === undefined) {
    return {
      status: "unknown",
      metadataKey: policy.metadataKey,
      supportedMajorVersions: [...policy.supportedMajorVersions],
      reason:
        "PLexus could not infer the Pharo major version from launcher template metadata.",
    };
  }

  const supported = policy.supportedMajorVersions.includes(majorVersion);
  return {
    status: supported ? "supported" : "unsupported",
    metadataKey: policy.metadataKey,
    actualMajorVersion: majorVersion,
    supportedMajorVersions: [...policy.supportedMajorVersions],
    reason: supported
      ? `Pharo ${majorVersion} is supported for Pharo MCP preparation.`
      : `Pharo ${majorVersion} is not supported for Pharo MCP preparation.`,
  };
}

export function homeImageCacheKeyMaterial(options: {
  config: ProjectConfig;
  source: HomeImageCacheSource;
  mcp: ProjectPreparedImageMcpConfig | ProjectImageMcpConfig;
  git?: ProjectImageGitConfig;
  templateMetadata?: HomeImageCacheTemplateMetadata;
}): HomeImageCacheKeyMaterial {
  const support = classifyHomeImageCachePharoMcpSupport({
    config: options.config,
    source: options.source,
    templateMetadata: options.templateMetadata,
  });
  return {
    schemaVersion: homeImageCacheSchemaVersion,
    projectCachePolicy: {
      pharoMcpPreparation: "load-when-supported",
    },
    source: options.source,
    ...(options.templateMetadata ? { templateMetadata: options.templateMetadata } : {}),
    pharoMcp: {
      support,
      loadScript: options.mcp.loadScript,
      repository: toMetacelloRepository(
        "repository" in options.mcp ? options.mcp.repository : undefined,
      ),
    },
    ...(options.git ? { git: { transport: options.git.transport } } : {}),
  };
}

export function deriveHomeImageCacheKey(
  material: HomeImageCacheKeyMaterial,
): string {
  return sha256Hex(stableJson(material));
}

export function readHomeImageCacheManifest(
  manifestPath: string,
): HomeImageCacheManifestReadResult {
  if (!fs.existsSync(manifestPath)) {
    return { status: "missing", manifestPath };
  }

  try {
    return {
      status: "ok",
      manifestPath,
      manifest: JSON.parse(
        fs.readFileSync(manifestPath, "utf8"),
      ) as HomeImageCacheManifest,
    };
  } catch (error) {
    return {
      status: "corrupt",
      manifestPath,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function writeHomeImageCacheManifest(
  manifest: HomeImageCacheManifest,
): void {
  fs.mkdirSync(dirnamePathLike(manifest.paths.manifestPath), { recursive: true });
  const temporaryPath = `${manifest.paths.manifestPath}.tmp-${process.pid}`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  fs.renameSync(temporaryPath, manifest.paths.manifestPath);
}

export function readHomeImageCacheLock(
  lockPath: string,
): HomeImageCacheLockReadResult {
  const lockFile = joinPathLike(lockPath, "lock.json");
  if (!fs.existsSync(lockFile)) {
    if (fs.existsSync(lockPath)) {
      return {
        status: "corrupt",
        lockPath,
        error: "Lock directory exists without lock.json",
      };
    }

    return { status: "missing", lockPath };
  }

  try {
    return {
      status: "ok",
      lockPath,
      lock: JSON.parse(
        fs.readFileSync(lockFile, "utf8"),
      ) as HomeImageCacheLockRecord,
    };
  } catch (error) {
    return {
      status: "corrupt",
      lockPath,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function tryAcquireHomeImageCacheLock(options: {
  lockPath: string;
  key: string;
  owner: string;
  now?: () => Date;
}):
  | { acquired: true; lock: HomeImageCacheLockRecord }
  | { acquired: false; current: HomeImageCacheLockReadResult } {
  fs.mkdirSync(dirnamePathLike(options.lockPath), { recursive: true });
  try {
    fs.mkdirSync(options.lockPath, { recursive: false });
  } catch {
    return {
      acquired: false,
      current: readHomeImageCacheLock(options.lockPath),
    };
  }

  const lock = {
    key: options.key,
    owner: options.owner,
    acquiredAt: (options.now ?? (() => new Date()))().toISOString(),
  };
  fs.writeFileSync(
    joinPathLike(options.lockPath, "lock.json"),
    `${JSON.stringify(lock, null, 2)}\n`,
    "utf8",
  );
  return { acquired: true, lock };
}

export function releaseHomeImageCacheLock(lockPath: string): void {
  fs.rmSync(lockPath, { recursive: true, force: true });
}

export function listHomeImageCacheManifests(
  cacheRoot: string,
): HomeImageCacheManifestReadResult[] {
  const entriesRoot = joinPathLike(cacheRoot, "entries");
  if (!fs.existsSync(entriesRoot)) {
    return [];
  }

  return fs
    .readdirSync(entriesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) =>
      readHomeImageCacheManifest(
        joinPathLike(entriesRoot, entry.name, "manifest.json"),
      ),
    );
}

export function planHomeImageCacheFlush(options: {
  config: ProjectConfig;
  env?: NodeJS.ProcessEnv;
  homeDirectory?: string;
  key?: string;
}): HomeImageCacheFlushPlan {
  const homePath = resolvePlexusHomePath(options);
  const cacheRoot = homeImageCacheRootPath(homePath);
  const keys = options.key
    ? [safeCacheKey(options.key)]
    : fs.existsSync(joinPathLike(cacheRoot, "entries"))
      ? fs
          .readdirSync(joinPathLike(cacheRoot, "entries"), {
            withFileTypes: true,
          })
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name)
      : [];

  return {
    homePath,
    cacheRoot,
    ...(options.key ? { key: options.key } : {}),
    entries: keys.map((key) => {
      const entryDirectory = homeImageCacheEntryDirectory(cacheRoot, key);
      return {
        key,
        entryDirectory,
        manifestPath: homeImageCacheManifestPath(cacheRoot, key),
        lockPath: homeImageCacheLockPath(cacheRoot, key),
        exists: fs.existsSync(entryDirectory),
      };
    }),
  };
}

export function flushHomeImageCache(plan: HomeImageCacheFlushPlan): void {
  for (const entry of plan.entries) {
    fs.rmSync(entry.entryDirectory, { recursive: true, force: true });
    fs.rmSync(entry.lockPath, { recursive: true, force: true });
  }
}

function manifestPreparationStatus(
  support: HomeImageCachePharoMcpSupport,
): HomeImageCachePreparationStatus {
  return support.status === "supported" ? "pending" : "skipped";
}

function planStatus(
  enabled: boolean,
  manifest: HomeImageCacheManifestReadResult,
  lock: HomeImageCacheLockReadResult,
): HomeImageCachePlanStatus {
  if (!enabled) {
    return "disabled";
  }

  if (manifest.status === "ok") {
    return manifest.manifest.pharoMcp.preparationStatus === "failed"
      ? "corrupt"
      : "hit";
  }

  if (manifest.status === "corrupt") {
    return "corrupt";
  }

  return lock.status === "ok" || lock.status === "corrupt"
    ? "in-progress"
    : "miss";
}

function preparationScriptSource(options: {
  cacheId: string;
  projectRoot: string;
  source: HomeImageCacheSource;
  mcp: ProjectPreparedImageMcpConfig | ProjectImageMcpConfig;
}): string {
  const repository = toMetacelloRepository(
    "repository" in options.mcp ? options.mcp.repository : undefined,
  );
  const loadScriptPath = isAbsolutePathLike(options.mcp.loadScript)
    ? resolvePathLike(options.mcp.loadScript)
    : resolvePathLike(options.projectRoot, options.mcp.loadScript);
  const quoted = (value: string) => `'${value.replaceAll("'", "''")}'`;
  const pathString = (value: string) => quoted(value.replace(/\\/g, "/"));

  return `"Generated by PLexus. Do not edit."

| loadScript |

Smalltalk globals at: #PLexusHomeImageCacheKey put: ${quoted(options.cacheId)}.

loadScript := ${pathString(loadScriptPath)} asFileReference.
loadScript exists
  ifTrue: [ loadScript fileIn ]
  ifFalse: [
    Metacello new
      githubUser: ${quoted(repository.githubUser)} project: ${quoted(repository.project)} commitish: ${quoted(repository.commitish)} path: ${quoted(repository.path)};
      baseline: ${quoted(repository.baseline)};
      load ].

(Smalltalk globals includesKey: #MCP)
  ifFalse: [ Error signal: 'MCP class is not available after home image cache preparation.' ].

Smalltalk globals at: #PLexusHomeImageCachePreparedAt put: DateAndTime now asString.
Smalltalk snapshot: true andQuit: true.
`;
}

export function buildHomeImageCachePlan(
  options: BuildHomeImageCachePlanOptions,
): HomeImageCachePlan {
  const { source, mcp } = sourceFromProjectImage(options.config, options.imageConfig);
  const homePath = resolvePlexusHomePath(options);
  const cacheRoot = homeImageCacheRootPath(homePath);
  const keyMaterial = homeImageCacheKeyMaterial({
    config: options.config,
    source,
    mcp,
    git: options.imageConfig.git,
    templateMetadata: options.templateMetadata,
  });
  const key = deriveHomeImageCacheKey(keyMaterial);
  const entryDirectory = homeImageCacheEntryDirectory(cacheRoot, key);
  const manifestPath = homeImageCacheManifestPath(cacheRoot, key);
  const lockPath = homeImageCacheLockPath(cacheRoot, key);
  const preparationScriptPath = homeImageCachePreparationScriptPath(cacheRoot, key);
  const cacheImageName = homeImageCacheImageName(key);
  const homeProfile = homeImageCacheProfile(homePath);
  const manifest = readHomeImageCacheManifest(manifestPath);
  const lock = readHomeImageCacheLock(lockPath);
  const enabled = homeImageCacheEnabled(options.config);
  const status = planStatus(enabled, manifest, lock);
  const diagnostics: string[] = [];

  if (!enabled) {
    diagnostics.push("PLexus home image cache is disabled by project config.");
  }
  if (manifest.status === "corrupt") {
    diagnostics.push(`Home image cache manifest is unreadable: ${manifest.error}`);
  }
  if (lock.status === "ok") {
    diagnostics.push(
      `Home image cache entry is already being prepared by ${lock.lock.owner}.`,
    );
  }
  if (lock.status === "corrupt") {
    diagnostics.push(`Home image cache lock is unreadable: ${lock.error}`);
  }

  const destinationProfile = profilePathsFromEnvironment(
    pharoLauncherMcpProfileEnvironment({
      projectRoot: options.projectRoot,
      config: options.config,
      workspaceId: options.workspaceId ?? "default",
      targetId:
        options.targetId ??
        `${projectConfigId(options.config)}--${options.workspaceId ?? "default"}`,
      stateRoot: options.stateRoot,
    }),
  );
  if (options.imageState && !destinationProfile) {
    diagnostics.push(
      "Runtime copy from the home image cache requires an explicit destination launcher profile.",
    );
  }

  const expectedManifest: HomeImageCacheManifest = {
    schemaVersion: homeImageCacheSchemaVersion,
    key,
    createdAt: (options.now ?? (() => new Date()))().toISOString(),
    updatedAt: (options.now ?? (() => new Date()))().toISOString(),
    cacheImageName,
    source,
    ...(options.templateMetadata ? { templateMetadata: options.templateMetadata } : {}),
    pharoMcp: {
      support: keyMaterial.pharoMcp.support,
      preparationStatus: manifestPreparationStatus(keyMaterial.pharoMcp.support),
      diagnostics,
    },
    paths: {
      entryDirectory,
      manifestPath,
      lockPath,
      preparationScriptPath,
      profileStateRoot: homeProfile.stateRoot,
    },
  };

  const shouldPrepare = status === "miss" || status === "corrupt";
  const createCacheImage =
    enabled && shouldPrepare
      ? {
          toolName: "pharo_launcher_image_create",
          profileEnvironment: profileEnvironmentFromPaths(homeProfile),
          argumentsValue: {
            newImageName: cacheImageName,
            templateName: source.templateName,
            ...(source.templateCategory
              ? { templateCategory: source.templateCategory }
              : {}),
            noLaunch: true,
          },
          requiresApproval: true as const,
          reason:
            "Creating a PLexus home image cache base mutates the explicit home launcher profile.",
        }
      : undefined;
  const prepareCacheImage =
    enabled && shouldPrepare && keyMaterial.pharoMcp.support.status === "supported"
      ? {
          toolName: "pharo_launcher_image_launch",
          profileEnvironment: profileEnvironmentFromPaths(homeProfile),
          argumentsValue: {
            imageName: cacheImageName,
            detached: false,
            script: preparationScriptPath,
          },
          requiresApproval: true as const,
          reason:
            "Preparing a supported Pharo MCP cache image must run headlessly, snapshot, and quit.",
        }
      : undefined;
  const runtimeCopy =
    enabled && options.imageState && destinationProfile && status !== "disabled"
      ? {
          toolName: "pharo_launcher_image_copy_between_profiles",
          argumentsValue: {
            sourceProfile: homeProfile,
            destinationProfile,
            sourceImageName: cacheImageName,
            destinationImageName: options.imageState.imageName,
          },
          requiresApproval: true as const,
          reason:
            "Runtime images must be copies of home cache bases and must stay in the project launcher profile.",
        }
      : undefined;

  return {
    status,
    key,
    projectRoot: options.projectRoot,
    homePath,
    cacheRoot,
    entryDirectory,
    manifestPath,
    lockPath,
    cacheImageName,
    source,
    support: keyMaterial.pharoMcp.support,
    manifest,
    lock,
    homeProfile,
    keyMaterial,
    expectedManifest,
    ...(createCacheImage ? { createCacheImage } : {}),
    ...(prepareCacheImage ? { prepareCacheImage } : {}),
    ...(runtimeCopy ? { runtimeCopy } : {}),
    diagnostics,
  };
}

export function writeHomeImageCachePreparationScript(plan: HomeImageCachePlan): {
  filePath: string;
  source: string;
} {
  const source = preparationScriptSource({
    cacheId: plan.key,
    projectRoot: plan.projectRoot,
    source: plan.source,
    mcp: {
      loadScript: plan.keyMaterial.pharoMcp.loadScript,
      repository: plan.keyMaterial.pharoMcp.repository,
    },
  });
  fs.mkdirSync(dirnamePathLike(plan.expectedManifest.paths.preparationScriptPath), {
    recursive: true,
  });
  fs.writeFileSync(plan.expectedManifest.paths.preparationScriptPath, source, "utf8");
  return {
    filePath: plan.expectedManifest.paths.preparationScriptPath,
    source,
  };
}
