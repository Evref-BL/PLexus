import {
  projectConfigId,
  resolveProjectRuntimePolicy,
  type ProjectConfig,
} from "./projectConfig.js";
import { joinPathLike, resolvePathLike } from "./pathStyle.js";
import {
  defaultPlexusStateRoot,
  sanitizeRuntimeId,
} from "./projectState.js";

export type PharoLauncherMcpProfileOwnership =
  | "plexus-owned"
  | "external"
  | "unknown";

export interface PharoLauncherMcpProfilePaths {
  profileName?: string;
  stateRoot?: string;
  launcherImage?: string;
  imagesDir?: string;
  vmsDir?: string;
  templateSourcesDir?: string;
  initScriptsDir?: string;
  logsDir?: string;
  launcherConfiguration?: string;
}

export interface PharoLauncherMcpProfileDiagnostic
  extends PharoLauncherMcpProfilePaths {
  ownership: PharoLauncherMcpProfileOwnership;
  mode: "project-owned" | "external";
  profileScope: "project" | "explicit-override" | "external" | "unknown";
  environmentKeys: string[];
  reason: string;
}

export interface ResolvePharoLauncherMcpProfileOptions {
  projectRoot: string;
  config: ProjectConfig;
  workspaceId: string;
  targetId: string;
  stateRoot?: string;
  env?: NodeJS.ProcessEnv;
}

const launcherProfileEnvironmentKeys = [
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

function profileName(config: ProjectConfig): string {
  return ["plexus", sanitizeRuntimeId(projectConfigId(config))].join("-");
}

function resolvedPlexusStateRoot(
  projectRoot: string,
  config: ProjectConfig,
  stateRoot: string | undefined,
): string {
  if (stateRoot) {
    return resolvePathLike(stateRoot);
  }

  const runtime = resolveProjectRuntimePolicy(config);
  return runtime.stateRoot.mode === "external" && runtime.stateRoot.path
    ? resolvePathLike(runtime.stateRoot.path)
    : defaultPlexusStateRoot(projectRoot);
}

function defaultProfileRoot(
  projectRoot: string,
  config: ProjectConfig,
  stateRoot: string | undefined,
): string {
  return joinPathLike(
    resolvedPlexusStateRoot(projectRoot, config, stateRoot),
    "profiles",
    "pharo-launcher-mcp",
    sanitizeRuntimeId(projectConfigId(config)),
  );
}

function projectOwnedPaths(
  options: ResolvePharoLauncherMcpProfileOptions,
): Required<PharoLauncherMcpProfilePaths> {
  const runtime = resolveProjectRuntimePolicy(options.config);
  const policy = runtime.launcherProfile;
  const stateRoot = policy.root
    ? resolvePathLike(policy.root)
    : defaultProfileRoot(
        options.projectRoot,
        options.config,
        options.stateRoot,
      );

  return {
    profileName: policy.name ?? profileName(options.config),
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

function environmentFromPaths(
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

function externallySuppliedPaths(
  env: NodeJS.ProcessEnv,
): PharoLauncherMcpProfilePaths {
  return {
    profileName: env.PHARO_LAUNCHER_MCP_PROFILE,
    stateRoot: env.PHARO_LAUNCHER_MCP_STATE_ROOT,
    launcherImage: env.PHARO_LAUNCHER_MCP_LAUNCHER_IMAGE,
    imagesDir: env.PHARO_LAUNCHER_MCP_IMAGES_DIR,
    vmsDir: env.PHARO_LAUNCHER_MCP_VMS_DIR,
    templateSourcesDir: env.PHARO_LAUNCHER_MCP_TEMPLATE_SOURCES_DIR,
    initScriptsDir: env.PHARO_LAUNCHER_MCP_INIT_SCRIPTS_DIR,
    logsDir: env.PHARO_LAUNCHER_MCP_LOGS_DIR,
    launcherConfiguration: env.PHARO_LAUNCHER_MCP_LAUNCHER_CONFIGURATION,
  };
}

function presentEnvironmentKeys(env: NodeJS.ProcessEnv): string[] {
  return launcherProfileEnvironmentKeys.filter((key) => env[key] !== undefined);
}

export function pharoLauncherMcpProfileEnvironment(
  options: ResolvePharoLauncherMcpProfileOptions,
): Record<string, string> | undefined {
  const runtime = resolveProjectRuntimePolicy(options.config);
  if (runtime.launcherProfile.mode !== "project-owned") {
    return undefined;
  }

  return environmentFromPaths(projectOwnedPaths(options));
}

export function describePharoLauncherMcpProfile(
  options: ResolvePharoLauncherMcpProfileOptions,
): PharoLauncherMcpProfileDiagnostic {
  const runtime = resolveProjectRuntimePolicy(options.config);
  if (runtime.launcherProfile.mode === "project-owned") {
    const paths = projectOwnedPaths(options);
    const profileScope =
      runtime.launcherProfile.name || runtime.launcherProfile.root
        ? "explicit-override"
        : "project";
    return {
      ownership: "plexus-owned",
      mode: "project-owned",
      profileScope,
      ...paths,
      environmentKeys: Object.keys(environmentFromPaths(paths)).sort((left, right) =>
        left.localeCompare(right),
      ),
      reason:
        profileScope === "project"
          ? "PLexus derives and passes a project-scoped pharo-launcher-mcp profile."
          : "PLexus passes an explicitly configured project-owned pharo-launcher-mcp profile override.",
    };
  }

  const env = options.env ?? process.env;
  const environmentKeys = presentEnvironmentKeys(env).sort((left, right) =>
    left.localeCompare(right),
  );
  if (environmentKeys.length === 0) {
    return {
      ownership: "unknown",
      mode: "external",
      profileScope: "unknown",
      environmentKeys,
      reason:
        "runtime.launcherProfile.mode is external, but no pharo-launcher-mcp profile environment is visible.",
    };
  }

  return {
    ownership: "external",
    mode: "external",
    profileScope: "external",
    ...externallySuppliedPaths(env),
    environmentKeys,
    reason:
      "runtime.launcherProfile.mode is external, so PLexus preserves the supplied pharo-launcher-mcp profile environment.",
  };
}
