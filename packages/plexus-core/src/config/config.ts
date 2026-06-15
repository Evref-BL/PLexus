import { createRequire } from "node:module";
import { dirnamePathLike, joinPathLike } from "../support/pathStyle.js";

export interface PharoLauncherMcpConfig {
  source: "env" | "package" | "command";
  command: string;
  args: string[];
  entry?: string;
  packageDir?: string;
  repoDir?: string;
}

export interface PlexusGatewayConfig {
  source: "env" | "package" | "command";
  command: string;
  args: string[];
  entry?: string;
  packageDir?: string;
  repoDir?: string;
}

export interface LoadPharoLauncherMcpConfigOptions {
  resolveInstalledEntry?: () => string | undefined;
}

export interface LoadPlexusGatewayConfigOptions {
  resolveInstalledEntry?: () => string | undefined;
}

const require = createRequire(import.meta.url);

export const pharoLauncherMcpPackageName =
  "@evref-bl/pharo-launcher-mcp" as const;
export const pharoLauncherMcpCommandName = "pharo-launcher-mcp" as const;
export const plexusGatewayPackageName = "@evref-bl/plexus-gateway" as const;
export const plexusGatewayCommandName = "plexus-gateway" as const;

function packageDirFromEntry(entry: string): string {
  return dirnamePathLike(dirnamePathLike(entry));
}

function resolveInstalledPharoLauncherMcpEntry(): string | undefined {
  try {
    return require.resolve(pharoLauncherMcpPackageName);
  } catch {
    return undefined;
  }
}

function resolveInstalledPlexusGatewayEntry(): string | undefined {
  try {
    return require.resolve(plexusGatewayPackageName);
  } catch {
    return undefined;
  }
}

function hasExplicitPharoLauncherMcpEnv(env: NodeJS.ProcessEnv): boolean {
  return Boolean(
    env.PHARO_LAUNCHER_MCP_COMMAND ??
      env.PHARO_LAUNCHER_MCP_ARGS ??
      env.PHARO_LAUNCHER_MCP_ENTRY ??
      env.PHARO_LAUNCHER_MCP_REPO_DIR,
  );
}

function hasExplicitPlexusGatewayEnv(env: NodeJS.ProcessEnv): boolean {
  return Boolean(
    env.PLEXUS_GATEWAY_COMMAND ??
      env.PLEXUS_GATEWAY_ARGS ??
      env.PLEXUS_GATEWAY_ENTRY ??
      env.PLEXUS_GATEWAY_REPO_DIR,
  );
}

function parseCommandArgs(value: string | undefined): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  return value.split(" ").filter(Boolean);
}

function defaultPharoLauncherMcpEntryForRepo(repoDir: string): string {
  return joinPathLike(repoDir, "dist", "index.js");
}

function defaultPlexusGatewayEntryForRepo(repoDir: string): string {
  return joinPathLike(repoDir, "dist", "index.js");
}

export function loadPharoLauncherMcpConfig(
  env: NodeJS.ProcessEnv = process.env,
  options: LoadPharoLauncherMcpConfigOptions = {},
): PharoLauncherMcpConfig {
  if (!hasExplicitPharoLauncherMcpEnv(env)) {
    const installedEntry = (
      options.resolveInstalledEntry ?? resolveInstalledPharoLauncherMcpEntry
    )();
    if (installedEntry) {
      return {
        source: "package",
        command: process.execPath,
        args: [installedEntry],
        entry: installedEntry,
        packageDir: packageDirFromEntry(installedEntry),
      };
    }

    return {
      source: "command",
      command: pharoLauncherMcpCommandName,
      args: [],
    };
  }

  const explicitArgs = parseCommandArgs(env.PHARO_LAUNCHER_MCP_ARGS);
  const repoDir = env.PHARO_LAUNCHER_MCP_REPO_DIR;
  const entry =
    env.PHARO_LAUNCHER_MCP_ENTRY ??
    (repoDir ? defaultPharoLauncherMcpEntryForRepo(repoDir) : undefined);

  return {
    source: "env",
    ...(repoDir ? { repoDir } : {}),
    ...(entry ? { entry } : {}),
    command: env.PHARO_LAUNCHER_MCP_COMMAND ?? process.execPath,
    args: explicitArgs ?? (entry ? [entry] : []),
  };
}

export function loadPlexusGatewayConfig(
  env: NodeJS.ProcessEnv = process.env,
  options: LoadPlexusGatewayConfigOptions = {},
): PlexusGatewayConfig {
  if (!hasExplicitPlexusGatewayEnv(env)) {
    const installedEntry = (
      options.resolveInstalledEntry ?? resolveInstalledPlexusGatewayEntry
    )();
    if (installedEntry) {
      return {
        source: "package",
        command: process.execPath,
        args: [installedEntry],
        entry: installedEntry,
        packageDir: packageDirFromEntry(installedEntry),
      };
    }

    return {
      source: "command",
      command: plexusGatewayCommandName,
      args: [],
    };
  }

  const explicitArgs = parseCommandArgs(env.PLEXUS_GATEWAY_ARGS);
  const repoDir = env.PLEXUS_GATEWAY_REPO_DIR;
  const entry =
    env.PLEXUS_GATEWAY_ENTRY ??
    (repoDir ? defaultPlexusGatewayEntryForRepo(repoDir) : undefined);

  return {
    source: "env",
    ...(repoDir ? { repoDir } : {}),
    ...(entry ? { entry } : {}),
    command: env.PLEXUS_GATEWAY_COMMAND ?? process.execPath,
    args: explicitArgs ?? (entry ? [entry] : []),
  };
}
