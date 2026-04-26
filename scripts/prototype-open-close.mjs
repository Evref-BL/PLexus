#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  closeProject,
  createStdioMcpPlClient,
  loadProjectState,
  openProject,
} from "@plexus/core";

function parseArgs(argv) {
  const options = {
    projectId: "prototype-open-close",
    imageId: "dev",
    pollIntervalMs: 500,
    processTimeoutMs: 30_000,
    healthTimeoutMs: 90_000,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) {
        throw new Error(`${arg} requires a value`);
      }
      return argv[index];
    };

    switch (arg) {
      case "--help":
      case "-h":
        options.help = true;
        break;
      case "--imageName":
        options.imageName = next();
        break;
      case "--projectRoot":
        options.projectRoot = next();
        break;
      case "--stateRoot":
        options.stateRoot = next();
        break;
      case "--workspaceId":
        options.workspaceId = next();
        break;
      case "--targetId":
        options.targetId = next();
        break;
      case "--projectId":
        options.projectId = next();
        break;
      case "--imageId":
        options.imageId = next();
        break;
      case "--port":
        options.port = Number(next());
        break;
      case "--loadScript":
        options.loadScript = next();
        break;
      case "--pollIntervalMs":
        options.pollIntervalMs = Number(next());
        break;
      case "--processTimeoutMs":
        options.processTimeoutMs = Number(next());
        break;
      case "--healthTimeoutMs":
        options.healthTimeoutMs = Number(next());
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  options.imageName ??= process.env.PLEXUS_TEST_IMAGE_NAME;
  options.projectRoot ??=
    process.env.PLEXUS_TEST_PROJECT_ROOT ??
    path.join(os.tmpdir(), "plexus-prototype-open-close-project");
  options.stateRoot ??=
    process.env.PLEXUS_TEST_STATE_ROOT ??
    path.join(os.tmpdir(), "plexus-prototype-open-close-state");
  options.workspaceId ??=
    process.env.PLEXUS_TEST_WORKSPACE_ID ??
    process.env.PLEXUS_WORKSPACE_ID ??
    process.env.VIBE_KANBAN_WORKSPACE_ID;
  options.targetId ??=
    process.env.PLEXUS_TEST_TARGET_ID ?? process.env.PLEXUS_TARGET_ID;
  options.loadScript ??=
    process.env.PLEXUS_TEST_LOAD_SCRIPT ?? "pharo/load-mcp.st";

  return options;
}

function usage() {
  return [
    "Usage:",
    "  npm run prototype:open-close -- --imageName <PharoLauncherImageName> [--port 7123]",
    "",
    "Required:",
    "  --imageName, or PLEXUS_TEST_IMAGE_NAME",
    "",
    "Optional:",
    "  --projectRoot <path>        Defaults to a temp prototype project",
    "  --stateRoot <path>          Defaults to a temp prototype state root",
    "  --workspaceId <id>          Isolates state under one worktree workspace",
    "  --targetId <id>             Overrides the runtime target id",
    "  --projectId <id>            Defaults to prototype-open-close",
    "  --imageId <id>              Defaults to dev",
    "  --port <number>             Defaults to PLexus allocation",
    "  --loadScript <path>         Defaults to pharo/load-mcp.st",
    "  --processTimeoutMs <ms>     Defaults to 30000",
    "  --healthTimeoutMs <ms>      Defaults to 90000",
  ].join("\n");
}

function assertValidOptions(options) {
  if (!options.imageName) {
    throw new Error("Missing --imageName or PLEXUS_TEST_IMAGE_NAME");
  }

  if (
    options.port !== undefined &&
    (!Number.isInteger(options.port) || options.port < 1 || options.port > 65_535)
  ) {
    throw new Error("--port must be an integer between 1 and 65535");
  }
}

function writePrototypeProjectConfig(options) {
  const projectRoot = path.resolve(options.projectRoot);
  const stateRoot = path.resolve(options.stateRoot);
  fs.mkdirSync(projectRoot, { recursive: true });
  fs.mkdirSync(stateRoot, { recursive: true });

  const mcp = {
    loadScript: options.loadScript,
    ...(options.port ? { port: options.port } : {}),
  };
  const config = {
    name: "plexus-prototype-open-close",
    kanban: {
      provider: "vibe-kanban",
      projectId: options.projectId,
    },
    images: [
      {
        id: options.imageId,
        imageName: options.imageName,
        active: true,
        mcp,
      },
    ],
  };

  fs.writeFileSync(
    path.join(projectRoot, "plexus.project.json"),
    `${JSON.stringify(config, null, 2)}\n`,
    "utf8",
  );

  return { projectRoot, stateRoot };
}

function textResult(label, value) {
  console.log(`${label}: ${value}`);
}

function launcherData(result) {
  if (!result?.ok) {
    throw new Error(JSON.stringify(result, null, 2));
  }

  return result.data;
}

function processMatchesImage(process, imageName) {
  return (
    process.imageName === imageName ||
    path.basename(process.imagePath ?? "", ".image") === imageName ||
    process.commandLine?.includes(`${imageName}.image`) ||
    process.commandLine?.includes(imageName)
  );
}

async function imageExists(client, imageName) {
  const result = await client.callTool("pharo_launcher_image_info", {
    imageName,
    format: "ston",
  });
  return result?.ok === true;
}

async function processForImage(client, imageName) {
  const result = await client.callTool("pharo_launcher_process_list", {});
  const processes = launcherData(result) ?? [];
  return processes.find((process) => processMatchesImage(process, imageName));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return 0;
  }

  assertValidOptions(options);
  const { projectRoot, stateRoot } = writePrototypeProjectConfig(options);
  const client = await createStdioMcpPlClient();
  let openedByThisScript = false;
  let attemptedOpen = false;

  try {
    textResult("projectRoot", projectRoot);
    textResult("stateRoot", stateRoot);
    textResult("workspaceId", options.workspaceId ?? "(derived from projectRoot)");
    textResult("targetId", options.targetId ?? "(derived from project/workspace)");
    textResult("imageName", options.imageName);

    if (!(await imageExists(client, options.imageName))) {
      throw new Error(`Image does not exist in PharoLauncher: ${options.imageName}`);
    }
    textResult("image exists", "yes");

    const preExistingProcess = await processForImage(client, options.imageName);
    if (preExistingProcess) {
      throw new Error(
        `Image is already running with pid ${preExistingProcess.pid}; stop it before running this prototype.`,
      );
    }
    textResult("pre-existing process", "none");

    attemptedOpen = true;
    const openResult = await openProject({
      projectRoot,
      stateRoot,
      workspaceId: options.workspaceId,
      targetId: options.targetId,
      poll: {
        intervalMs: options.pollIntervalMs,
        processTimeoutMs: options.processTimeoutMs,
        healthTimeoutMs: options.healthTimeoutMs,
      },
    });
    openedByThisScript = true;
    textResult("open ok", openResult.ok);
    textResult("statePath", openResult.statePath);

    const runningProcess = await processForImage(client, options.imageName);
    if (!runningProcess) {
      throw new Error("Process was not visible after project open");
    }
    textResult("running pid", runningProcess.pid);

    const stateAfterOpen = loadProjectState(openResult.statePath);
    const imageState = stateAfterOpen?.images.find(
      (image) => image.id === options.imageId,
    );
    textResult("assigned port", imageState?.assignedPort ?? "unknown");
    textResult("image status", imageState?.status ?? "unknown");

    const closeResult = await closeProject({
      projectRoot,
      stateRoot,
      workspaceId: options.workspaceId,
    });
    openedByThisScript = false;
    textResult("close ok", closeResult.ok);

    const processAfterClose = await processForImage(client, options.imageName);
    if (processAfterClose) {
      throw new Error(
        `Process is still running after project close: pid ${processAfterClose.pid}`,
      );
    }
    textResult("process after close", "gone");
    return 0;
  } finally {
    if (openedByThisScript || attemptedOpen) {
      const stillRunning = await processForImage(client, options.imageName);
      if (stillRunning) {
        console.error(
          `cleanup: killing ${options.imageName} with pid ${stillRunning.pid}`,
        );
        try {
          await client.callTool("pharo_launcher_process_kill", {
            imageName: options.imageName,
            confirm: true,
          });
        } catch (error) {
          console.error(
            `cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }

    await client.close?.();
  }
}

main()
  .then((exitCode) => {
    process.exitCode = exitCode;
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    console.error("");
    console.error(usage());
    process.exitCode = 1;
  });
