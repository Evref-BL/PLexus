import path from "node:path";
import { createRequire } from "node:module";

export interface McpPlConfig {
  source: "env" | "package" | "command";
  command: string;
  args: string[];
  entry?: string;
  packageDir?: string;
  repoDir?: string;
}

const require = createRequire(import.meta.url);

function packageDirFromEntry(entry: string): string {
  return path.dirname(path.dirname(entry));
}

function resolveInstalledMcpPlEntry(): string | undefined {
  try {
    return require.resolve("@evref-bl/mcp-pl");
  } catch {
    return undefined;
  }
}

function hasExplicitMcpPlEnv(env: NodeJS.ProcessEnv): boolean {
  return Boolean(
    env.MCP_PL_COMMAND ??
      env.MCP_PL_ARGS ??
      env.MCP_PL_ENTRY ??
      env.MCP_PL_REPO_DIR,
  );
}

function parseMcpPlArgs(value: string | undefined): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  return value.split(" ").filter(Boolean);
}

function isWindowsPath(value: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith("\\\\");
}

function defaultMcpPlEntryForRepo(repoDir: string): string {
  const pathApi = isWindowsPath(repoDir)
    ? path.win32
    : repoDir.startsWith("/")
      ? path.posix
      : path;

  return pathApi.join(repoDir, "dist", "index.js");
}

export function loadMcpPlConfig(
  env: NodeJS.ProcessEnv = process.env,
): McpPlConfig {
  if (!hasExplicitMcpPlEnv(env)) {
    const installedEntry = resolveInstalledMcpPlEntry();
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
      command: "mcp-pl",
      args: [],
    };
  }

  const explicitArgs = parseMcpPlArgs(env.MCP_PL_ARGS);
  const repoDir = env.MCP_PL_REPO_DIR;
  const entry =
    env.MCP_PL_ENTRY ??
    (repoDir ? defaultMcpPlEntryForRepo(repoDir) : undefined);

  return {
    source: "env",
    ...(repoDir ? { repoDir } : {}),
    ...(entry ? { entry } : {}),
    command: env.MCP_PL_COMMAND ?? process.execPath,
    args: explicitArgs ?? (entry ? [entry] : []),
  };
}
