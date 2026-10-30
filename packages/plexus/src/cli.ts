#!/usr/bin/env node
import { startPlexusAgentServer } from "./mcp/agentServer.js";
import {
  ScopedPharoLauncher,
  scopedImageLeaseOptionsFromEnvironment,
  startScopedPharoLauncherServer,
} from "./launcher/scopedPharoLauncherServer.js";

/**
 * The image is the unit of work, so it is the unit of the CLI. `start` rather
 * than the launcher's `launch`: the commoner word wins over the domain's.
 */
async function runImageCommand(
  parsed: ParsedCommand,
  stateRoot: string | undefined,
  workspaceId: string | undefined,
): Promise<number> {
  const projectRoot =
    parsed.projectPath ?? process.env.PLEXUS_PROJECT_ROOT ?? process.cwd();
  const launcher = new ScopedPharoLauncher({
    projectRoot,
    ...(workspaceId === undefined ? {} : { workspaceId }),
    ...(stateRoot === undefined ? {} : { stateRoot }),
    imageLease: scopedImageLeaseOptionsFromEnvironment(process.env),
  });

  const needsImageId = (): string => {
    if (!parsed.imageId) {
      throw new Error(`plexus image ${parsed.command} requires an image id`);
    }
    return parsed.imageId;
  };

  try {
    // One command is one operation, so it opens one launcher client however
    // many steps it takes.
    return await launcher.runOperation(async () => {
      switch (parsed.command) {
        case "list":
          return print(await launcher.listImages());
        case "create":
          return print(await launcher.createImage(needsImageId()));
        case "start":
          return print(
            await launcher.startImage(needsImageId(), parsed.displayMode),
          );
        case "stop":
          return print(await launcher.stopImage(needsImageId()));
        case "delete":
          return print(await launcher.deleteImage(needsImageId()));
        default:
          console.error(usage());
          return 2;
      }
    });
  } catch (error) {
    console.error(
      JSON.stringify(
        { ok: false, error: error instanceof Error ? error.message : String(error) },
        null,
        2,
      ),
    );
    return 1;
  }
}

function print(value: unknown): number {
  console.log(JSON.stringify(value, null, 2));
  return 0;
}

function usage(): string {
  return [
    "Usage:",
    "  plexus image list|create|start|stop|delete <imageId> [--project-path <path>] [--workspace-id <id>] [--state-root <path>] [--display-mode <headless|interactive>]",
    "  plexus mcp   (agent front door: images and the running image's Pharo tools, over stdio)",
    "  plexus mcp pharo-launcher [--project-path <path>] [--workspace-id <id>] [--state-root <path>]",
    "",
    "Environment:",
    "  PLEXUS_PROJECT_ROOT     Project root; defaults to the working directory.",
    "  PLEXUS_STATE_ROOT       Optional runtime state root.",
    "  PLEXUS_WORKSPACE_ID     Optional runtime workspace id.",
    "  PLEXUS_IMAGE_LEASE_OWNER_ID Optional scoped image lease owner id.",
    "  PLEXUS_IMAGE_LEASE_OWNER_KIND Optional lease owner kind.",
    "  PLEXUS_IMAGE_LEASE_PURPOSE Optional lease purpose.",
  ].join("\n");
}

interface ParsedCommand {
  scope?: string;
  command?: string;
  projectPath?: string;
  imageId?: string;
  stateRoot?: string;
  workspaceId?: string;
  displayMode?: "headless" | "interactive";
  confirm?: boolean;
  deleteStateFile?: boolean;
  deleteLauncherImages?: boolean;
}

type ParsedDisplayMode = NonNullable<ParsedCommand["displayMode"]>;

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
    case "--display-mode":
      parsed.displayMode = parseDisplayMode(value);
      return;
    default:
      throw new Error(`Unknown option: ${arg}`);
  }
}

function parseCommand(argv: string[]): ParsedCommand {
  const [scope, command] = argv;
  const projectCommandHasPath = scope === "project";
  const projectPath = projectCommandHasPath ? argv[2] : undefined;
  // `image <verb> <imageId>`: the image is the subject, the project is context.
  const imageId =
    scope === "image" && argv[2] && !argv[2].startsWith("--")
      ? argv[2]
      : undefined;
  const consumed = projectCommandHasPath || imageId ? 3 : 2;
  const rest = argv.slice(consumed);
  const parsed: ParsedCommand = { scope, command, projectPath, imageId };

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


async function main(argv: string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(usage());
    return 0;
  }

  // `plexus mcp` with no sub-noun is the agent front door: one stdio server,
  // started and owned by the agent host, project taken from the cwd.
  if (argv[0] === "mcp" && argv[1] === undefined) {
    await startPlexusAgentServer({
      projectRoot: process.env.PLEXUS_PROJECT_ROOT ?? process.cwd(),
      ...(process.env.PLEXUS_WORKSPACE_ID === undefined
        ? {}
        : { workspaceId: process.env.PLEXUS_WORKSPACE_ID }),
      ...(process.env.PLEXUS_STATE_ROOT === undefined
        ? {}
        : { stateRoot: process.env.PLEXUS_STATE_ROOT }),
      imageLease: scopedImageLeaseOptionsFromEnvironment(process.env),
    });
    return 0;
  }

  const parsed = parseCommand(argv);
  const workspaceId =
    parsed.workspaceId ??
    process.env.PLEXUS_WORKSPACE_ID;
  const stateRoot = parsed.stateRoot ?? process.env.PLEXUS_STATE_ROOT;

  if (parsed.scope === "image") {
    return await runImageCommand(parsed, stateRoot, workspaceId);
  }

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
      imageLease: scopedImageLeaseOptionsFromEnvironment(process.env),
    });
    return 0;
  }

  console.error(usage());
  return 2;
}

main(process.argv.slice(2))
  .then((exitCode) => {
    process.exitCode = exitCode;
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
