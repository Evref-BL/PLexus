#!/usr/bin/env node
import { ProjectCloseError } from "./lifecycle/projectClose.js";
import { PlexusProjectLifecycle } from "./lifecycle/projectLifecycle.js";
import { ProjectOpenError } from "./lifecycle/projectOpen.js";
import {
  scopedImageLeaseOptionsFromEnvironment,
  startScopedPharoLauncherServer,
} from "./launcher/scopedPharoLauncherServer.js";
import {
  parseProjectLifecycleServerCliOptions,
  startProjectLifecycleServerFromCli,
} from "./mcp/server.js";

function usage(): string {
  return [
    "Usage:",
    "  plexus project open <path> [--workspace-id <id>] [--target-id <id>] [--state-root <path>] [--display-mode <headless|interactive>]",
    "  plexus project close <path> [--workspace-id <id>] [--state-root <path>] [--repository-workspace-cleanup-policy <preserve|archive|delete-disposable>] [--repository-workspace-archive-root <path>]",
    "  plexus project cleanup <path> [--workspace-id <id>] [--state-root <path>] [--confirm] [--delete-state] [--keep-launcher-images] [--repository-workspace-cleanup-policy <preserve|archive|delete-disposable>] [--repository-workspace-archive-root <path>]",
    "  plexus project status <path> [--workspace-id <id>] [--state-root <path>]",
    "  plexus mcp project [serve|http|--http] [--host <host>] [--port <port>] [--mcp-path <path>]",
    "  plexus mcp pharo-launcher [--project-path <path>] [--workspace-id <id>] [--target-id <id>] [--state-root <path>]",
    "",
    "Environment:",
    "  PLEXUS_STATE_ROOT       Optional runtime state root.",
    "  PLEXUS_WORKSPACE_ID     Optional runtime workspace id.",
    "  VIBE_KANBAN_WORKSPACE_ID Optional runtime workspace id.",
    "  PLEXUS_TARGET_ID        Optional runtime target id.",
    "  PLEXUS_IMAGE_LEASE_OWNER_ID Optional scoped image lease owner id.",
    "  PLEXUS_IMAGE_LEASE_OWNER_KIND Optional lease owner kind.",
    "  PLEXUS_IMAGE_LEASE_PURPOSE Optional lease purpose.",
    "  PLEXUS_PROJECT_MCP_PORT Optional project MCP HTTP service port.",
    "  PLEXUS_PROJECT_MCP_PATH Optional project MCP HTTP service path.",
  ].join("\n");
}

interface ParsedCommand {
  scope?: string;
  command?: string;
  projectPath?: string;
  stateRoot?: string;
  workspaceId?: string;
  targetId?: string;
  displayMode?: "headless" | "interactive";
  repositoryWorkspaceCleanupPolicy?: "preserve" | "archive" | "delete-disposable";
  repositoryWorkspaceArchiveRoot?: string;
  confirm?: boolean;
  deleteStateFile?: boolean;
  deleteLauncherImages?: boolean;
}

type ParsedDisplayMode = NonNullable<ParsedCommand["displayMode"]>;
type ParsedRepositoryWorkspaceCleanupPolicy = NonNullable<
  ParsedCommand["repositoryWorkspaceCleanupPolicy"]
>;

function applyFlagOption(parsed: ParsedCommand, arg: string): boolean {
  switch (arg) {
    case "--confirm":
      parsed.confirm = true;
      return true;
    case "--delete-state":
      parsed.deleteStateFile = true;
      return true;
    case "--keep-launcher-images":
      parsed.deleteLauncherImages = false;
      return true;
    default:
      return false;
  }
}

function requiredOptionValue(rest: string[], index: number): string {
  const arg = rest[index];
  const value = rest[index + 1];
  if (!value) {
    throw new Error(`${arg} requires a value`);
  }

  return value;
}

function parseDisplayMode(value: string): ParsedDisplayMode {
  if (value !== "headless" && value !== "interactive") {
    throw new Error("--display-mode must be headless or interactive");
  }

  return value;
}

function parseRepositoryWorkspaceCleanupPolicy(
  value: string,
): ParsedRepositoryWorkspaceCleanupPolicy {
  if (
    value !== "preserve" &&
    value !== "archive" &&
    value !== "delete-disposable"
  ) {
    throw new Error(
      "--repository-workspace-cleanup-policy must be preserve, archive, or delete-disposable",
    );
  }

  return value;
}

function applyValueOption(
  parsed: ParsedCommand,
  arg: string,
  value: string,
): void {
  switch (arg) {
    case "--project-path":
      parsed.projectPath = value;
      return;
    case "--state-root":
      parsed.stateRoot = value;
      return;
    case "--workspace-id":
      parsed.workspaceId = value;
      return;
    case "--target-id":
      parsed.targetId = value;
      return;
    case "--display-mode":
      parsed.displayMode = parseDisplayMode(value);
      return;
    case "--repository-workspace-cleanup-policy":
      parsed.repositoryWorkspaceCleanupPolicy =
        parseRepositoryWorkspaceCleanupPolicy(value);
      return;
    case "--repository-workspace-archive-root":
      parsed.repositoryWorkspaceArchiveRoot = value;
      return;
    default:
      throw new Error(`Unknown option: ${arg}`);
  }
}

function parseCommand(argv: string[]): ParsedCommand {
  const [scope, command] = argv;
  const projectCommandHasPath = scope === "project";
  const projectPath = projectCommandHasPath ? argv[2] : undefined;
  const rest = projectCommandHasPath ? argv.slice(3) : argv.slice(2);
  const parsed: ParsedCommand = { scope, command, projectPath };

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (applyFlagOption(parsed, arg)) {
        continue;
    }

    applyValueOption(parsed, arg, requiredOptionValue(rest, index));
    index += 1;
  }

  return parsed;
}

type ProjectLifecycleCommandName = "open" | "close" | "cleanup" | "status";

interface ProjectLifecycleCliCommand extends ParsedCommand {
  scope: "project";
  command: ProjectLifecycleCommandName;
  projectPath: string;
}

function projectLifecycleCommand(
  parsed: ParsedCommand,
): ProjectLifecycleCliCommand | undefined {
  if (parsed.scope !== "project" || !parsed.projectPath) {
    return undefined;
  }

  switch (parsed.command) {
    case "open":
    case "close":
    case "cleanup":
    case "status":
      return parsed as ProjectLifecycleCliCommand;
    default:
      return undefined;
  }
}

function repositoryWorkspaceOptions(parsed: ParsedCommand): {
  repositoryWorkspaceCleanupPolicy?: ParsedRepositoryWorkspaceCleanupPolicy;
  repositoryWorkspaceArchiveRoot?: string;
} {
  return {
    ...(parsed.repositoryWorkspaceCleanupPolicy
      ? {
          repositoryWorkspaceCleanupPolicy:
            parsed.repositoryWorkspaceCleanupPolicy,
        }
      : {}),
    ...(parsed.repositoryWorkspaceArchiveRoot
      ? { repositoryWorkspaceArchiveRoot: parsed.repositoryWorkspaceArchiveRoot }
      : {}),
  };
}

function printJson(value: unknown, error = false): void {
  const output = JSON.stringify(value, null, 2);
  if (error) {
    console.error(output);
    return;
  }

  console.log(output);
}

async function runOpenCommand(
  parsed: ProjectLifecycleCliCommand,
  stateRoot: string | undefined,
  workspaceId: string | undefined,
): Promise<number> {
  const lifecycle = new PlexusProjectLifecycle();
  const lifecycleResult = await lifecycle.open({
    projectPath: parsed.projectPath,
    stateRoot,
    workspaceId,
    targetId: parsed.targetId ?? process.env.PLEXUS_TARGET_ID,
    displayMode: parsed.displayMode,
  });
  if (!lifecycleResult.ok || !lifecycleResult.data) {
    printJson(lifecycleResult, true);
    return 1;
  }

  const result = lifecycleResult.data;
  printJson({
    ok: result.ok,
    statePath: result.statePath,
    gateway: result.state.gateway,
    images: result.state.images,
  });
  return 0;
}

async function runStatusCommand(
  parsed: ProjectLifecycleCliCommand,
  stateRoot: string | undefined,
  workspaceId: string | undefined,
): Promise<number> {
  const lifecycle = new PlexusProjectLifecycle();
  const status = await lifecycle.status({
    projectPath: parsed.projectPath,
    stateRoot,
    workspaceId,
  });
  printJson(status);
  return status.ok ? 0 : 1;
}

async function runCleanupCommand(
  parsed: ProjectLifecycleCliCommand,
  stateRoot: string | undefined,
  workspaceId: string | undefined,
): Promise<number> {
  const lifecycle = new PlexusProjectLifecycle();
  const cleanup = await lifecycle.cleanup({
    projectPath: parsed.projectPath,
    stateRoot,
    workspaceId,
    confirm: parsed.confirm,
    deleteStateFile: parsed.deleteStateFile,
    deleteLauncherImages: parsed.deleteLauncherImages,
    ...repositoryWorkspaceOptions(parsed),
  });
  printJson(cleanup);
  return cleanup.ok ? 0 : 1;
}

async function runCloseCommand(
  parsed: ProjectLifecycleCliCommand,
  stateRoot: string | undefined,
  workspaceId: string | undefined,
): Promise<number> {
  const lifecycle = new PlexusProjectLifecycle();
  const lifecycleResult = await lifecycle.close({
    projectPath: parsed.projectPath,
    stateRoot,
    workspaceId,
    ...repositoryWorkspaceOptions(parsed),
  });
  if (!lifecycleResult.ok || !lifecycleResult.data) {
    printJson(lifecycleResult, true);
    return 1;
  }

  const result = lifecycleResult.data;
  printJson({
    ok: result.ok,
    statePath: result.statePath,
    gateway: result.state?.gateway,
    images: result.state?.images ?? [],
    stoppedImages: result.stoppedImages,
    repositoryWorkspaceCleanups: result.repositoryWorkspaceCleanups,
  });
  return 0;
}

async function runProjectLifecycleCommand(
  parsed: ProjectLifecycleCliCommand,
  stateRoot: string | undefined,
  workspaceId: string | undefined,
): Promise<number> {
  switch (parsed.command) {
    case "open":
      return runOpenCommand(parsed, stateRoot, workspaceId);
    case "status":
      return runStatusCommand(parsed, stateRoot, workspaceId);
    case "cleanup":
      return runCleanupCommand(parsed, stateRoot, workspaceId);
    case "close":
      return runCloseCommand(parsed, stateRoot, workspaceId);
  }
}

function handleProjectLifecycleError(error: unknown): number {
  if (error instanceof ProjectOpenError) {
    printJson(
      {
        ok: false,
        statePath: error.result.statePath,
        failures: error.result.failures,
        images: error.result.state.images,
      },
      true,
    );
    return 1;
  }

  if (error instanceof ProjectCloseError) {
    printJson(
      {
        ok: false,
        statePath: error.result.statePath,
        failures: error.result.failures,
        images: error.result.state?.images ?? [],
        stoppedImages: error.result.stoppedImages,
        repositoryWorkspaceCleanups: error.result.repositoryWorkspaceCleanups,
      },
      true,
    );
    return 1;
  }

  console.error(error instanceof Error ? error.message : String(error));
  return 1;
}

async function main(argv: string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(usage());
    return 0;
  }

  if (argv[0] === "mcp" && argv[1] === "project") {
    await startProjectLifecycleServerFromCli(
      parseProjectLifecycleServerCliOptions(argv.slice(2)),
    );
    return 0;
  }

  const parsed = parseCommand(argv);
  const workspaceId =
    parsed.workspaceId ??
    process.env.PLEXUS_WORKSPACE_ID ??
    process.env.VIBE_KANBAN_WORKSPACE_ID;
  const stateRoot = parsed.stateRoot ?? process.env.PLEXUS_STATE_ROOT;

  if (parsed.scope === "mcp" && parsed.command === "pharo-launcher") {
    const projectPath = parsed.projectPath ?? process.env.PLEXUS_PROJECT_ROOT;
    if (!projectPath) {
      console.error("plexus mcp pharo-launcher requires --project-path or PLEXUS_PROJECT_ROOT");
      return 2;
    }

    await startScopedPharoLauncherServer({
      projectRoot: projectPath,
      stateRoot,
      workspaceId,
      targetId: parsed.targetId ?? process.env.PLEXUS_TARGET_ID,
      imageLease: scopedImageLeaseOptionsFromEnvironment(process.env),
    });
    return 0;
  }

  const lifecycleCommand = projectLifecycleCommand(parsed);
  if (!lifecycleCommand) {
    console.error(usage());
    return 2;
  }

  try {
    return await runProjectLifecycleCommand(
      lifecycleCommand,
      stateRoot,
      workspaceId,
    );
  } catch (error) {
    return handleProjectLifecycleError(error);
  }
}

main(process.argv.slice(2))
  .then((exitCode) => {
    process.exitCode = exitCode;
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
