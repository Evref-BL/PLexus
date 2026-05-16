import { createRequire } from "node:module";
import { dirnamePathLike, joinPathLike } from "./pathStyle.js";

export interface PharoLauncherMcpConfig {
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

const require = createRequire(import.meta.url);

export const pharoLauncherMcpPackageName =
  "@evref-bl/pharo-launcher-mcp" as const;
export const pharoLauncherMcpCommandName = "pharo-launcher-mcp" as const;

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

function hasExplicitPharoLauncherMcpEnv(env: NodeJS.ProcessEnv): boolean {
  return Boolean(
    env.PHARO_LAUNCHER_MCP_COMMAND ??
      env.PHARO_LAUNCHER_MCP_ARGS ??
      env.PHARO_LAUNCHER_MCP_ENTRY ??
      env.PHARO_LAUNCHER_MCP_REPO_DIR,
  );
}

function parsePharoLauncherMcpArgs(
  value: string | undefined,
): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  return value.split(" ").filter(Boolean);
}

function defaultPharoLauncherMcpEntryForRepo(repoDir: string): string {
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

  const explicitArgs = parsePharoLauncherMcpArgs(env.PHARO_LAUNCHER_MCP_ARGS);
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
