#!/usr/bin/env node
import { closeProject, ProjectCloseError } from "./projectClose.js";
import { openProject, ProjectOpenError } from "./projectOpen.js";
import { startScopedPharoLauncherServer } from "./scopedPharoLauncherServer.js";

function usage(): string {
  return [
    "Usage:",
    "  plexus project open <path> [--workspace-id <id>] [--target-id <id>] [--state-root <path>]",
    "  plexus project close <path> [--workspace-id <id>] [--state-root <path>]",
    "  plexus mcp pharo-launcher [--project-path <path>] [--workspace-id <id>] [--target-id <id>] [--state-root <path>]",
    "",
    "Environment:",
    "  PLEXUS_STATE_ROOT       Optional runtime state root.",
    "  PLEXUS_WORKSPACE_ID     Optional runtime workspace id.",
    "  VIBE_KANBAN_WORKSPACE_ID Optional runtime workspace id.",
    "  PLEXUS_TARGET_ID        Optional runtime target id.",
  ].join("\n");
}

interface ParsedCommand {
  scope?: string;
  command?: string;
  projectPath?: string;
  stateRoot?: string;
  workspaceId?: string;
  targetId?: string;
}

function parseCommand(argv: string[]): ParsedCommand {
  const [scope, command] = argv;
  const projectCommandHasPath = scope === "project";
  const projectPath = projectCommandHasPath ? argv[2] : undefined;
  const rest = projectCommandHasPath ? argv.slice(3) : argv.slice(2);
  const parsed: ParsedCommand = { scope, command, projectPath };

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    const value = rest[index + 1];
    if (!value) {
      throw new Error(`${arg} requires a value`);
    }

    switch (arg) {
      case "--project-path":
      case "--state-root":
        if (arg === "--project-path") {
          parsed.projectPath = value;
        } else {
          parsed.stateRoot = value;
        }
        break;
      case "--workspace-id":
        parsed.workspaceId = value;
        break;
      case "--target-id":
        parsed.targetId = value;
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }

    index += 1;
  }

  return parsed;
}

async function main(argv: string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(usage());
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
    });
    return 0;
  }

  if (
    parsed.scope !== "project" ||
    (parsed.command !== "open" && parsed.command !== "close") ||
    !parsed.projectPath
  ) {
    console.error(usage());
    return 2;
  }

  try {
    if (parsed.command === "open") {
      const result = await openProject({
        projectRoot: parsed.projectPath,
        stateRoot,
        workspaceId,
        targetId: parsed.targetId ?? process.env.PLEXUS_TARGET_ID,
      });

      console.log(
        JSON.stringify(
          {
            ok: result.ok,
            statePath: result.statePath,
            images: result.state.images,
          },
          null,
          2,
        ),
      );
      return 0;
    }

    const result = await closeProject({
      projectRoot: parsed.projectPath,
      stateRoot,
      workspaceId,
    });

    console.log(
      JSON.stringify(
        {
          ok: result.ok,
          statePath: result.statePath,
          images: result.state?.images ?? [],
          stoppedImages: result.stoppedImages,
        },
        null,
        2,
      ),
    );
    return 0;
  } catch (error) {
    if (error instanceof ProjectOpenError) {
      console.error(
        JSON.stringify(
          {
            ok: false,
            statePath: error.result.statePath,
            failures: error.result.failures,
            images: error.result.state.images,
          },
          null,
          2,
        ),
      );
      return 1;
    }

    if (error instanceof ProjectCloseError) {
      console.error(
        JSON.stringify(
          {
            ok: false,
            statePath: error.result.statePath,
            failures: error.result.failures,
            images: error.result.state?.images ?? [],
            stoppedImages: error.result.stoppedImages,
          },
          null,
          2,
        ),
      );
      return 1;
    }

    console.error(error instanceof Error ? error.message : String(error));
    return 1;
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
