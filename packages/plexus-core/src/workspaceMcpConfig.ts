import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { resolvePathLike } from "./pathStyle.js";
import { loadProjectConfig, type ProjectConfig } from "./projectConfig.js";
import {
  defaultTargetId,
  defaultWorkspaceId,
  type PharoMcpContractReference,
} from "./projectState.js";

export const defaultPharoLauncherMcpServerName = "pharo-launcher";
export const defaultPharoMcpServerName = "gateway";

export interface WorkspaceMcpServerConfig {
  command: string;
  args: string[];
  env?: Record<string, string>;
  [key: string]: unknown;
}

export interface WorkspaceMcpConfig {
  servers: Record<string, WorkspaceMcpServerConfig>;
}

export interface PlexusWorkspaceMcpScope {
  projectRoot: string;
  projectId: string;
  workspaceId: string;
  targetId: string;
  stateRoot?: string;
}

export interface BuildPlexusWorkspaceMcpConfigOptions {
  projectRoot: string;
  projectConfig?: ProjectConfig;
  workspaceId?: string;
  targetId?: string;
  stateRoot?: string;
  plexusCommand?: string;
  plexusGatewayCommand?: string;
  pharoTools: readonly Tool[];
  pharoMcpContract?: PharoMcpContractReference;
  pharoLauncherServerName?: string;
  pharoServerName?: string;
}

function optionalJsonEnv(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  return JSON.stringify(value);
}

export function resolvePlexusWorkspaceMcpScope(
  options: Omit<BuildPlexusWorkspaceMcpConfigOptions, "pharoTools">,
): PlexusWorkspaceMcpScope {
  const projectRoot = resolvePathLike(options.projectRoot);
  const config = options.projectConfig ?? loadProjectConfig(projectRoot);
  const workspaceId = options.workspaceId ?? defaultWorkspaceId(projectRoot);
  const targetId =
    options.targetId ?? defaultTargetId(config.kanban.projectId, workspaceId);

  return {
    projectRoot,
    projectId: config.kanban.projectId,
    workspaceId,
    targetId,
    ...(options.stateRoot
      ? { stateRoot: resolvePathLike(options.stateRoot) }
      : {}),
  };
}

function scopeEnv(scope: PlexusWorkspaceMcpScope): Record<string, string> {
  return {
    PLEXUS_PROJECT_ROOT: scope.projectRoot,
    PLEXUS_PROJECT_ID: scope.projectId,
    PLEXUS_WORKSPACE_ID: scope.workspaceId,
    VIBE_KANBAN_WORKSPACE_ID: scope.workspaceId,
    PLEXUS_TARGET_ID: scope.targetId,
    ...(scope.stateRoot ? { PLEXUS_STATE_ROOT: scope.stateRoot } : {}),
  };
}

export function buildPharoLauncherMcpServerConfig(
  options: BuildPlexusWorkspaceMcpConfigOptions,
): WorkspaceMcpServerConfig {
  const scope = resolvePlexusWorkspaceMcpScope(options);

  return {
    command: options.plexusCommand ?? "plexus",
    args: ["mcp", "pharo-launcher"],
    env: {
      ...scopeEnv(scope),
      PLEXUS_AGENT_MCP_SURFACE: "pharo-launcher",
    },
  };
}

export function buildPharoMcpServerConfig(
  options: BuildPlexusWorkspaceMcpConfigOptions,
): WorkspaceMcpServerConfig {
  const scope = resolvePlexusWorkspaceMcpScope(options);
  const contractJson = optionalJsonEnv(options.pharoMcpContract);

  return {
    command: options.plexusGatewayCommand ?? "plexus-gateway",
    args: ["--stdio"],
    env: {
      ...scopeEnv(scope),
      PLEXUS_GATEWAY_SURFACE: "gateway",
      PLEXUS_PHARO_TOOLS_JSON: JSON.stringify(options.pharoTools),
      ...(contractJson ? { PLEXUS_PHARO_MCP_CONTRACT_JSON: contractJson } : {}),
    },
  };
}

export function mergeWorkspaceMcpServers(
  existingServers: Record<string, WorkspaceMcpServerConfig>,
  generatedServers: Record<string, WorkspaceMcpServerConfig>,
): Record<string, WorkspaceMcpServerConfig> {
  return {
    ...existingServers,
    ...generatedServers,
  };
}

export function buildPlexusWorkspaceMcpConfig(
  options: BuildPlexusWorkspaceMcpConfigOptions & {
    existingServers?: Record<string, WorkspaceMcpServerConfig>;
  },
): WorkspaceMcpConfig {
  const pharoLauncherServerName =
    options.pharoLauncherServerName ?? defaultPharoLauncherMcpServerName;
  const pharoServerName = options.pharoServerName ?? defaultPharoMcpServerName;
  const generatedServers = {
    [pharoLauncherServerName]: buildPharoLauncherMcpServerConfig(options),
    [pharoServerName]: buildPharoMcpServerConfig(options),
  };

  return {
    servers: mergeWorkspaceMcpServers(
      options.existingServers ?? {},
      generatedServers,
    ),
  };
}
