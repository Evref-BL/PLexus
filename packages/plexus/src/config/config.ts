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
    // Resolving the package name gives its export, which is the library the
    // functions live in. What runs as a command — and what answers --health —
    // is the bin, and since the two were split those are different files. The
    // export loaded as a CLI prints nothing and exits 0, which reads as a
    // health check that returned no JSON.
    const manifestPath = require.resolve(
      `${pharoLauncherMcpPackageName}/package.json`,
    );
    const manifest = require(manifestPath) as {
      bin?: Record<string, string> | string;
    };
    const bin =
      typeof manifest.bin === "string"
        ? manifest.bin
        : manifest.bin?.[pharoLauncherMcpCommandName];

    return bin === undefined
      ? undefined
      : joinPathLike(dirnamePathLike(manifestPath), bin);
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

function parseCommandArgs(value: string | undefined): string[] | undefined {
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

