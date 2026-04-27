#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createStdioPharoLauncherMcpClient,
  loadProjectState,
} from "@plexus/core";
import { PlexusGateway } from "@plexus/gateway";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = path.dirname(path.dirname(scriptPath));

function parseArgs(argv) {
  const options = {
    projectId: "smoke-open-route-close",
    imageId: "dev",
    pollIntervalMs: 500,
    processTimeoutMs: 30_000,
    healthTimeoutMs: 120_000,
    toolName: "evaluate",
    toolArgumentsJson: '{"expression":"3 + 4"}',
    expectedText: "7",
    keepTemp: false,
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
      case "--copyFromImageName":
        options.copyFromImageName = next();
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
      case "--toolName":
        options.toolName = next();
        break;
      case "--toolArgumentsJson":
        options.toolArgumentsJson = next();
        break;
      case "--expectedText":
        options.expectedText = next();
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
      case "--keepTemp":
        options.keepTemp = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  options.copyFromImageName ??= process.env.PLEXUS_SMOKE_COPY_FROM_IMAGE_NAME;
  options.imageName ??= process.env.PLEXUS_SMOKE_IMAGE_NAME;
  options.projectRoot ??= process.env.PLEXUS_SMOKE_PROJECT_ROOT;
  options.stateRoot ??= process.env.PLEXUS_SMOKE_STATE_ROOT;
  options.workspaceId ??=
    process.env.PLEXUS_SMOKE_WORKSPACE_ID ??
    `smoke-${new Date().toISOString().replaceAll(/[^0-9A-Za-z]+/g, "-")}-${process.pid}`;
  options.targetId ??= process.env.PLEXUS_SMOKE_TARGET_ID;
  options.loadScript ??=
    process.env.PLEXUS_SMOKE_LOAD_SCRIPT ??
    path.join(repoRoot, "pharo", "load-mcp.st");

  return options;
}

function usage() {
  return [
    "Usage:",
    "  npm run smoke:open-route-close -- --copyFromImageName <ExistingImage>",
    "  npm run smoke:open-route-close -- --imageName <ExistingDisposableImage>",
    "",
    "Required:",
    "  --copyFromImageName or --imageName, or matching PLEXUS_SMOKE_* env vars",
    "",
    "Optional:",
    "  --projectRoot <path>          Defaults to an owned temp project",
    "  --stateRoot <path>            Defaults to an owned temp state root",
    "  --workspaceId <id>            Defaults to a unique smoke id",
    "  --targetId <id>               Overrides the runtime target id",
    "  --projectId <id>              Defaults to smoke-open-route-close",
    "  --imageId <id>                Defaults to dev",
    "  --port <number>               Defaults to PLexus allocation",
    "  --loadScript <path>           Defaults to pharo/load-mcp.st in this repo",
    "  --toolName <name>             Defaults to evaluate",
    "  --toolArgumentsJson <json>    Defaults to {\"expression\":\"3 + 4\"}",
    "  --expectedText <text>         Defaults to 7",
    "  --keepTemp                   Keep generated temp project/state dirs",
  ].join("\n");
}

function assertValidOptions(options) {
  if (!options.imageName && !options.copyFromImageName) {
    throw new Error("Missing --imageName or --copyFromImageName");
  }

  if (
    options.port !== undefined &&
    (!Number.isInteger(options.port) || options.port < 1 || options.port > 65_535)
  ) {
    throw new Error("--port must be an integer between 1 and 65535");
  }

  try {
    options.toolArguments = JSON.parse(options.toolArgumentsJson);
  } catch (error) {
    throw new Error(
      `--toolArgumentsJson must be valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  if (
    !options.toolArguments ||
    typeof options.toolArguments !== "object" ||
    Array.isArray(options.toolArguments)
  ) {
    throw new Error("--toolArgumentsJson must decode to a JSON object");
  }
}

function ownedTempDirectory(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function removeOwnedDirectory(directory) {
  const resolvedDirectory = path.resolve(directory);
  const tempRoot = path.resolve(os.tmpdir());
  const comparableDirectory =
    process.platform === "win32" ? resolvedDirectory.toLowerCase() : resolvedDirectory;
  const comparableTempRoot =
    process.platform === "win32" ? tempRoot.toLowerCase() : tempRoot;

  if (!comparableDirectory.startsWith(`${comparableTempRoot}${path.sep}`)) {
    throw new Error(`Refusing to remove non-temp directory: ${resolvedDirectory}`);
  }

  fs.rmSync(resolvedDirectory, { recursive: true, force: true });
}

function writeSmokeProjectConfig(options) {
  const projectRoot = path.resolve(
    options.projectRoot ?? ownedTempDirectory("plexus-smoke-project-"),
  );
  const stateRoot = path.resolve(
    options.stateRoot ?? ownedTempDirectory("plexus-smoke-state-"),
  );
  fs.mkdirSync(projectRoot, { recursive: true });
  fs.mkdirSync(stateRoot, { recursive: true });

  const mcp = {
    loadScript: options.loadScript,
    ...(options.port ? { port: options.port } : {}),
  };
  const config = {
    name: "plexus-smoke-open-route-close",
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

  return {
    projectRoot,
    stateRoot,
    ownsProjectRoot: options.projectRoot === undefined,
    ownsStateRoot: options.stateRoot === undefined,
  };
}

function textResult(label, value) {
  console.log(`${label}: ${value}`);
}

function sleep(durationMs) {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
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

async function listImages(client, nameFilter) {
  const result = await client.callTool("pharo_launcher_image_list", {
    ...(nameFilter ? { nameFilter } : {}),
    format: "ston",
  });
  return launcherData(result) ?? [];
}

function imageListContains(images, imageName) {
  return images.some(
    (image) =>
      image.name === imageName ||
      path.basename(image.imagePath ?? "", ".image") === imageName,
  );
}

async function imageExists(client, imageName) {
  const filteredImages = await listImages(client, imageName);
  if (imageListContains(filteredImages, imageName)) {
    return true;
  }

  return imageListContains(await listImages(client), imageName);
}

async function waitForImageExists(client, imageName, timeoutMs = 30_000) {
  const startedAt = Date.now();

  while (Date.now() - startedAt <= timeoutMs) {
    if (await imageExists(client, imageName)) {
      return true;
    }
    await sleep(500);
  }

  return false;
}

async function processForImage(client, imageName) {
  const result = await client.callTool("pharo_launcher_process_list", {});
  const processes = launcherData(result) ?? [];
  return processes.find((process) => processMatchesImage(process, imageName));
}

function requireGatewayOk(result, label) {
  if (!result?.ok) {
    throw new Error(`${label} failed: ${result?.error ?? JSON.stringify(result)}`);
  }

  return result.data;
}

function routeOutputText(value) {
  return JSON.stringify(value);
}

async function cleanupStep(label, action) {
  try {
    await action();
  } catch (error) {
    console.error(
      `cleanup warning (${label}): ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return 0;
  }

  assertValidOptions(options);
  const client = await createStdioPharoLauncherMcpClient();
  const gateway = new PlexusGateway();
  let copiedImage = false;
  let opened = false;
  let projectPaths;

  try {
    if (options.copyFromImageName) {
      options.imageName ??= `PlexusSmoke${Date.now()}${process.pid}`;
      textResult("copy source image", options.copyFromImageName);
      textResult("copy target image", options.imageName);

      if (!(await imageExists(client, options.copyFromImageName))) {
        throw new Error(
          `Source image does not exist in PharoLauncher: ${options.copyFromImageName}`,
        );
      }

      if (await imageExists(client, options.imageName)) {
        throw new Error(
          `Target smoke image already exists in PharoLauncher: ${options.imageName}`,
        );
      }

      const copyResult = await client.callTool("pharo_launcher_image_copy", {
        imageName: options.copyFromImageName,
        newImageName: options.imageName,
      });
      launcherData(copyResult);
      copiedImage = true;
      textResult("image copied", "yes");

      if (!(await waitForImageExists(client, options.imageName))) {
        throw new Error(
          `Copied image did not become visible in PharoLauncher: ${
            options.imageName
          }. Copy result: ${JSON.stringify(copyResult)}`,
        );
      }
    }

    if (!(await imageExists(client, options.imageName))) {
      throw new Error(`Image does not exist in PharoLauncher: ${options.imageName}`);
    }

    const preExistingProcess = await processForImage(client, options.imageName);
    if (preExistingProcess) {
      throw new Error(
        `Image is already running with pid ${preExistingProcess.pid}; stop it before running this smoke.`,
      );
    }

    projectPaths = writeSmokeProjectConfig(options);
    textResult("projectRoot", projectPaths.projectRoot);
    textResult("stateRoot", projectPaths.stateRoot);
    textResult("workspaceId", options.workspaceId);
    textResult("targetId", options.targetId ?? "(derived from project/workspace)");
    textResult("imageName", options.imageName);

    const openResult = await gateway.handleTool("plexus_project_open", {
      projectPath: projectPaths.projectRoot,
      stateRoot: projectPaths.stateRoot,
      workspaceId: options.workspaceId,
      ...(options.targetId ? { targetId: options.targetId } : {}),
    });
    const openData = requireGatewayOk(openResult, "plexus_project_open");
    opened = true;
    textResult("open ok", openResult.ok);
    textResult("statePath", openData.statePath);

    const stateAfterOpen = loadProjectState(openData.statePath);
    const imageState = stateAfterOpen?.images.find(
      (image) => image.id === options.imageId,
    );
    textResult("assigned port", imageState?.assignedPort ?? "unknown");
    textResult("image status", imageState?.status ?? "unknown");

    const routeResult = await gateway.handleTool("plexus_route_to_image", {
      targetId: openData.state.targetId,
      imageId: options.imageId,
      toolName: options.toolName,
      arguments: options.toolArguments,
    });
    const routedData = requireGatewayOk(routeResult, "plexus_route_to_image");
    textResult("route ok", routeResult.ok);
    textResult("routed tool", options.toolName);
    textResult("routed output", routeOutputText(routedData));

    if (
      options.expectedText &&
      !routeOutputText(routedData).includes(options.expectedText)
    ) {
      throw new Error(
        `Routed output did not contain expected text ${JSON.stringify(
          options.expectedText,
        )}`,
      );
    }

    const closeResult = await gateway.handleTool("plexus_project_close", {
      projectPath: projectPaths.projectRoot,
      stateRoot: projectPaths.stateRoot,
      workspaceId: options.workspaceId,
    });
    requireGatewayOk(closeResult, "plexus_project_close");
    opened = false;
    textResult("close ok", closeResult.ok);

    const processAfterClose = await processForImage(client, options.imageName);
    if (processAfterClose) {
      throw new Error(
        `Process is still running after project close: pid ${processAfterClose.pid}`,
      );
    }
    textResult("process after close", "gone");

    const statusAfterClose = await gateway.handleTool("plexus_project_status", {
      targetId: openData.state.targetId,
      refreshHealth: true,
    });
    const closedRoute = requireGatewayOk(statusAfterClose, "plexus_project_status");
    const closedImage = closedRoute.images?.find(
      (image) => image.id === options.imageId,
    );
    const routeSummary = closedImage
      ? `${closedImage.status}, routable=${closedImage.routable?.ok === true}`
      : "not registered";
    if (closedImage?.routable?.ok) {
      throw new Error("Closed image route is still routable");
    }
    textResult("route after close", routeSummary);

    return 0;
  } finally {
    if (opened && projectPaths) {
      await cleanupStep("project close", async () => {
        await gateway.handleTool("plexus_project_close", {
          projectPath: projectPaths.projectRoot,
          stateRoot: projectPaths.stateRoot,
          workspaceId: options.workspaceId,
        });
      });
    }

    if (options.imageName) {
      await cleanupStep("process cleanup", async () => {
        const stillRunning = await processForImage(client, options.imageName);
        if (stillRunning) {
          console.error(
            `cleanup: killing ${options.imageName} with pid ${stillRunning.pid}`,
          );
          await client.callTool("pharo_launcher_process_kill", {
            imageName: options.imageName,
            confirm: true,
          });
        }
      });
    }

    await cleanupStep("copied image delete", async () => {
      if (copiedImage) {
        console.error(`cleanup: deleting copied image ${options.imageName}`);
        await client.callTool("pharo_launcher_image_delete", {
          imageName: options.imageName,
          force: true,
          confirm: true,
        });
      }
    });

    await cleanupStep("temp directory cleanup", async () => {
      if (projectPaths && !options.keepTemp) {
        if (projectPaths.ownsProjectRoot) {
          removeOwnedDirectory(projectPaths.projectRoot);
        }
        if (projectPaths.ownsStateRoot) {
          removeOwnedDirectory(projectPaths.stateRoot);
        }
      }
    });

    await cleanupStep("mcp client close", async () => client.close?.());
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
