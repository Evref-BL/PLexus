#!/usr/bin/env node
import { spawnSync } from "node:child_process";
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
    imageSpecs: [],
    stepSpecs: [],
    scenario: "basic",
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
      case "--imageSpecJson":
        options.imageSpecs.push(jsonObjectFromString(next(), "--imageSpecJson"));
        break;
      case "--projectRoot":
        options.projectRoot = next();
        break;
      case "--stateRoot":
        options.stateRoot = next();
        break;
      case "--fixtureRoot":
        options.fixtureRoot = next();
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
      case "--stepJson":
        options.stepSpecs.push(jsonObjectFromString(next(), "--stepJson"));
        break;
      case "--scenario":
        options.scenario = next();
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
  options.fixtureRoot ??= process.env.PLEXUS_SMOKE_FIXTURE_ROOT;
  options.workspaceId ??=
    process.env.PLEXUS_SMOKE_WORKSPACE_ID ??
    `smoke-${new Date().toISOString().replaceAll(/[^0-9A-Za-z]+/g, "-")}-${process.pid}`;
  options.targetId ??= process.env.PLEXUS_SMOKE_TARGET_ID;
  options.loadScript ??=
    process.env.PLEXUS_SMOKE_LOAD_SCRIPT ??
    path.join(repoRoot, "pharo", "load-mcp.st");

  appendJsonArrayEnv(
    options.imageSpecs,
    process.env.PLEXUS_SMOKE_IMAGE_SPECS_JSON,
    "PLEXUS_SMOKE_IMAGE_SPECS_JSON",
  );
  appendJsonArrayEnv(
    options.stepSpecs,
    process.env.PLEXUS_SMOKE_STEPS_JSON,
    "PLEXUS_SMOKE_STEPS_JSON",
  );

  return options;
}

function usage() {
  return [
    "Usage:",
    "  npm run smoke:open-route-close -- --copyFromImageName <ExistingImage>",
    "  npm run smoke:open-route-close -- --imageName <ExistingDisposableImage>",
    "  npm run smoke:open-route-close -- --imageSpecJson '{\"id\":\"dev\",\"copyFromImageName\":\"MCP12-2\"}' --imageSpecJson '{\"id\":\"peer\",\"copyFromImageName\":\"MCP12-2\"}'",
    "",
    "Required:",
    "  One image source via --copyFromImageName, --imageName, --imageSpecJson, or matching PLEXUS_SMOKE_* env vars",
    "",
    "Optional:",
    "  --projectRoot <path>          Defaults to an owned temp project",
    "  --stateRoot <path>            Defaults to an owned temp state root",
    "  --fixtureRoot <path>          Defaults to an owned temp root for scenario repos",
    "  --workspaceId <id>            Defaults to a unique smoke id",
    "  --targetId <id>               Overrides the runtime target id",
    "  --projectId <id>              Defaults to smoke-open-route-close",
    "  --imageId <id>                Defaults to dev for the legacy one-image path",
    "  --port <number>               Defaults to PLexus allocation",
    "  --loadScript <path>           Defaults to pharo/load-mcp.st in this repo",
    "  --toolName <name>             Defaults to evaluate",
    "  --toolArgumentsJson <json>    Defaults to {\"expression\":\"3 + 4\"}",
    "  --expectedText <text>         Defaults to 7 for the legacy/default probe",
    "  --stepJson <json>             Adds a routed tool step; use forEachImage=true to fan out",
    "  --scenario <name>             basic or project-edit-export",
    "  --keepTemp                   Keep generated temp project/state/fixture dirs",
    "",
    "Image spec JSON fields:",
    "  id, imageName, copyFromImageName, port, loadScript, active",
    "",
    "Step JSON fields:",
    "  imageId, forEachImage, toolName, arguments, expectedText",
  ].join("\n");
}

function jsonObjectFromString(value, label) {
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(
      `${label} must be valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} must decode to a JSON object`);
  }

  return parsed;
}

function appendJsonArrayEnv(target, value, name) {
  if (!value || value.trim().length === 0) {
    return;
  }

  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(
      `${name} must be a JSON array: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  if (!Array.isArray(parsed)) {
    throw new Error(`${name} must be a JSON array`);
  }

  for (const entry of parsed) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`${name} entries must be JSON objects`);
    }
    target.push(entry);
  }
}

function assertValidOptions(options) {
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

  options.images = normalizeImageSpecs(options);
  options.steps = normalizeStepSpecs(options);

  if (!["basic", "project-edit-export"].includes(options.scenario)) {
    throw new Error("--scenario must be basic or project-edit-export");
  }
}

function normalizeImageSpecs(options) {
  const rawImages =
    options.imageSpecs.length > 0
      ? options.imageSpecs
      : [
          {
            id: options.imageId,
            imageName: options.imageName,
            copyFromImageName: options.copyFromImageName,
            port: options.port,
            loadScript: options.loadScript,
            active: true,
          },
        ];

  if (rawImages.length === 0) {
    throw new Error("Missing image source");
  }

  const ids = new Set();
  return rawImages.map((rawImage, index) => {
    const id = stringProperty(rawImage, "id") ?? `image-${index + 1}`;
    if (ids.has(id)) {
      throw new Error(`Duplicate image id: ${id}`);
    }
    ids.add(id);

    const imageName = stringProperty(rawImage, "imageName");
    const copyFromImageName = stringProperty(rawImage, "copyFromImageName");
    if (!imageName && !copyFromImageName) {
      throw new Error(
        `Image ${id} is missing imageName or copyFromImageName`,
      );
    }

    const port = numberProperty(rawImage, "port");
    if (
      port !== undefined &&
      (!Number.isInteger(port) || port < 1 || port > 65_535)
    ) {
      throw new Error(`Image ${id} port must be an integer between 1 and 65535`);
    }
    const active = booleanProperty(rawImage, "active") ?? true;
    if (!active) {
      throw new Error(`Image ${id} must be active for this smoke`);
    }

    return {
      id,
      imageName,
      copyFromImageName,
      port,
      loadScript: stringProperty(rawImage, "loadScript") ?? options.loadScript,
      active,
      copied: false,
      index,
    };
  });
}

function normalizeStepSpecs(options) {
  return options.stepSpecs.map((rawStep, index) => {
    const toolName = stringProperty(rawStep, "toolName");
    if (!toolName) {
      throw new Error(`Step ${index + 1} is missing toolName`);
    }

    const argumentsValue = rawStep.arguments ?? {};
    if (
      !argumentsValue ||
      typeof argumentsValue !== "object" ||
      Array.isArray(argumentsValue)
    ) {
      throw new Error(`Step ${index + 1} arguments must be a JSON object`);
    }

    const forEachImage = booleanProperty(rawStep, "forEachImage") ?? false;
    const imageId = stringProperty(rawStep, "imageId");
    if (!forEachImage && !imageId && options.images.length > 1) {
      throw new Error(
        `Step ${index + 1} must set imageId or forEachImage=true for multi-image runs`,
      );
    }

    return {
      imageId,
      forEachImage,
      toolName,
      arguments: argumentsValue,
      expectedText: stringProperty(rawStep, "expectedText"),
      label: stringProperty(rawStep, "label") ?? `step-${index + 1}`,
    };
  });
}

function stringProperty(value, key) {
  const property = value[key];
  if (property === undefined) {
    return undefined;
  }
  if (typeof property !== "string" || property.length === 0) {
    throw new Error(`${key} must be a non-empty string`);
  }
  return property;
}

function numberProperty(value, key) {
  const property = value[key];
  if (property === undefined) {
    return undefined;
  }
  if (typeof property !== "number") {
    throw new Error(`${key} must be a number`);
  }
  return property;
}

function booleanProperty(value, key) {
  const property = value[key];
  if (property === undefined) {
    return undefined;
  }
  if (typeof property !== "boolean") {
    throw new Error(`${key} must be a boolean`);
  }
  return property;
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
  const fixtureRoot = path.resolve(
    options.fixtureRoot ?? ownedTempDirectory("plexus-smoke-fixtures-"),
  );
  fs.mkdirSync(projectRoot, { recursive: true });
  fs.mkdirSync(stateRoot, { recursive: true });
  fs.mkdirSync(fixtureRoot, { recursive: true });

  const config = {
    name: "plexus-smoke-open-route-close",
    kanban: {
      provider: "vibe-kanban",
      projectId: options.projectId,
    },
    images: options.images.map((image) => ({
      id: image.id,
      imageName: image.imageName,
      active: image.active,
      mcp: {
        loadScript: image.loadScript,
        ...(image.port ? { port: image.port } : {}),
      },
    })),
  };

  fs.writeFileSync(
    path.join(projectRoot, "plexus.project.json"),
    `${JSON.stringify(config, null, 2)}\n`,
    "utf8",
  );

  return {
    projectRoot,
    stateRoot,
    fixtureRoot,
    ownsProjectRoot: options.projectRoot === undefined,
    ownsStateRoot: options.stateRoot === undefined,
    ownsFixtureRoot: options.fixtureRoot === undefined,
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
  if (value && typeof value === "object" && Array.isArray(value.content)) {
    return value.content
      .map((entry) =>
        entry && typeof entry === "object" && typeof entry.text === "string"
          ? entry.text
          : JSON.stringify(entry),
      )
      .join("\n");
  }

  return JSON.stringify(value);
}

function assertRoutedToolSucceeded(value, label) {
  if (value && typeof value === "object" && value.isError === true) {
    throw new Error(`${label} returned an MCP error: ${routeOutputText(value)}`);
  }
}

function assertOutputContains(value, expectedText, label) {
  if (!expectedText) {
    return;
  }

  const output = routeOutputText(value);
  if (!output.includes(expectedText)) {
    throw new Error(
      `${label} output did not contain expected text ${JSON.stringify(
        expectedText,
      )}. Output: ${output}`,
    );
  }
}

async function routeStep(gateway, targetId, step) {
  const routeResult = await gateway.handleTool("plexus_route_to_image", {
    targetId,
    imageId: step.imageId,
    toolName: step.toolName,
    arguments: step.arguments,
  });
  const routedData = requireGatewayOk(routeResult, step.label);
  assertRoutedToolSucceeded(routedData, step.label);
  assertOutputContains(routedData, step.expectedText, step.label);
  textResult("route ok", `${step.imageId}/${step.toolName}`);
  textResult("routed output", routeOutputText(routedData));
  return routedData;
}

async function runDefaultRouteProbes(gateway, targetId, options) {
  for (const image of options.images) {
    await routeStep(gateway, targetId, {
      label: `default probe ${image.id}`,
      imageId: image.id,
      toolName: options.toolName,
      arguments: options.toolArguments,
      expectedText: options.expectedText,
    });
  }
}

async function runConfiguredSteps(gateway, targetId, options) {
  for (const step of options.steps) {
    const imageTargets = step.forEachImage
      ? options.images.map((image) => image.id)
      : [step.imageId ?? options.images[0].id];

    for (const imageId of imageTargets) {
      await routeStep(gateway, targetId, {
        ...step,
        imageId,
        label: `${step.label} ${imageId}`,
      });
    }
  }
}

async function runMultiImageIsolationProbe(gateway, targetId, options) {
  if (options.images.length < 2) {
    return;
  }

  const tokens = new Map();
  for (const image of options.images) {
    const result = await routeStep(gateway, targetId, {
      label: `isolation token ${image.id}`,
      imageId: image.id,
      toolName: "evaluate",
      arguments: {
        expression:
          "Smalltalk globals at: #PLexusSmokeIsolationToken put: UUID new asString",
      },
    });
    tokens.set(image.id, routeOutputText(result));
  }

  if (new Set(tokens.values()).size !== tokens.size) {
    throw new Error(
      `Expected distinct image-local isolation tokens, got ${JSON.stringify([
        ...tokens.entries(),
      ])}`,
    );
  }

  const firstImage = options.images[0];
  const repeated = await routeStep(gateway, targetId, {
    label: `isolation repeat ${firstImage.id}`,
    imageId: firstImage.id,
    toolName: "evaluate",
    arguments: {
      expression:
        "Smalltalk globals at: #PLexusSmokeIsolationToken ifAbsent: [ 'missing' ]",
    },
  });
  assertOutputContains(repeated, tokens.get(firstImage.id), "isolation repeat");
}

async function runProjectEditExportScenario(gateway, targetId, projectPaths, options) {
  if (options.images.length === 0) {
    return;
  }

  for (const image of options.images) {
    const safeId = image.id.replaceAll(/[^0-9A-Za-z]+/g, "");
    const suffix = `${safeId || "Image"}${Date.now()}${process.pid}`;
    const classPrefix = `PlexusSmoke${suffix}`;
    const packageName = `${classPrefix}Core`;
    const testPackageName = `${classPrefix}Tests`;
    const className = `${classPrefix}Subject`;
    const testClassName = `${classPrefix}SubjectTest`;
    const repositoryName = `${classPrefix}Repository`;
    const repositoryRoot = path.join(projectPaths.fixtureRoot, image.id);

    initializeGitRepository(repositoryRoot);
    textResult("scenario repository", repositoryRoot);

    await routeStep(gateway, targetId, {
      label: `create class ${image.id}`,
      imageId: image.id,
      toolName: "edit-class",
      arguments: {
        operation: "create",
        className,
        superclassName: "Object",
        packageName,
        tag: "Smoke",
        slots: ["value"],
        classComment: "Created by the PLexus project-edit-export smoke.",
      },
      expectedText: className,
    });

    await routeStep(gateway, targetId, {
      label: `create method ${image.id}`,
      imageId: image.id,
      toolName: "edit-method",
      arguments: {
        operation: "create",
        className,
        methodSource: "answer\n\t^ 42",
        protocol: "accessing",
      },
      expectedText: "answer",
    });

    await routeStep(gateway, targetId, {
      label: `work in image ${image.id}`,
      imageId: image.id,
      toolName: "evaluate",
      arguments: {
        expression: `${className} new answer`,
      },
      expectedText: "42",
    });

    await routeStep(gateway, targetId, {
      label: `create test class ${image.id}`,
      imageId: image.id,
      toolName: "edit-class",
      arguments: {
        operation: "create",
        className: testClassName,
        superclassName: "TestCase",
        packageName: testPackageName,
        tag: "Smoke",
        classComment: "Created by the PLexus project-edit-export smoke.",
      },
      expectedText: testClassName,
    });

    await routeStep(gateway, targetId, {
      label: `create test method ${image.id}`,
      imageId: image.id,
      toolName: "edit-method",
      arguments: {
        operation: "create",
        className: testClassName,
        methodSource: `testAnswer\n\tself assert: ${className} new answer equals: 42`,
        protocol: "tests",
      },
      expectedText: "testAnswer",
    });

    await routeStep(gateway, targetId, {
      label: `run tests ${image.id}`,
      imageId: image.id,
      toolName: "run-tests",
      arguments: {
        tests: [{ className: testClassName }],
        timeoutSeconds: 30,
      },
      expectedText: "Executed",
    });

    await routeStep(gateway, targetId, {
      label: `create repository ${image.id}`,
      imageId: image.id,
      toolName: "edit-repository",
      arguments: {
        operation: "create",
        name: repositoryName,
        location: repositoryRoot,
        packageNames: [packageName, testPackageName],
      },
      expectedText: repositoryName,
    });

    await routeStep(gateway, targetId, {
      label: `diff repository ${image.id}`,
      imageId: image.id,
      toolName: "edit-repository",
      arguments: {
        operation: "diff",
        repositoryName,
      },
      expectedText: packageName,
    });

    await routeStep(gateway, targetId, {
      label: `export repository ${image.id}`,
      imageId: image.id,
      toolName: "edit-repository",
      arguments: {
        operation: "export",
        repositoryName,
      },
      expectedText: "export",
    });

    assertExportedRepository(repositoryRoot, [packageName, testPackageName]);
  }
}

function initializeGitRepository(repositoryRoot) {
  fs.mkdirSync(repositoryRoot, { recursive: true });
  runHostCommand("git", ["init"], repositoryRoot, "git init");
}

function assertExportedRepository(repositoryRoot, packageNames) {
  const files = listFiles(repositoryRoot);
  for (const packageName of packageNames) {
    if (!files.some((file) => file.includes(packageName))) {
      throw new Error(
        `Export did not write files for package ${packageName} under ${repositoryRoot}`,
      );
    }
  }

  const status = runHostCommand(
    "git",
    ["status", "--short"],
    repositoryRoot,
    "git status",
  ).stdout.trim();
  if (!status) {
    throw new Error(`Expected exported repository to have git status changes`);
  }
  textResult("git status", status.replaceAll("\n", " | "));

  const headResult = spawnSync("git", ["rev-parse", "--verify", "HEAD"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  if (headResult.status === 0) {
    throw new Error("Scenario unexpectedly created a Git commit");
  }
  textResult("git commits", "none");
}

function listFiles(directory) {
  const results = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name === ".git") {
        continue;
      }
      const fullPath = path.join(current, entry.name);
      const relativePath = path.relative(directory, fullPath);
      results.push(relativePath);
      if (entry.isDirectory()) {
        walk(fullPath);
      }
    }
  };
  walk(directory);
  return results;
}

function runHostCommand(command, args, cwd, label) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
  });

  if (result.error) {
    throw new Error(`${label} failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `${label} exited ${result.status}: ${result.stderr || result.stdout}`,
    );
  }

  return result;
}

function generatedSmokeImageName(image) {
  const id = image.id.replaceAll(/[^0-9A-Za-z]+/g, "");
  return `PlexusSmoke${id || "Image"}${Date.now()}${process.pid}${image.index}`;
}

async function prepareImages(client, options) {
  for (const image of options.images) {
    if (image.copyFromImageName) {
      image.imageName ??= generatedSmokeImageName(image);
      textResult("copy source image", `${image.id}=${image.copyFromImageName}`);
      textResult("copy target image", `${image.id}=${image.imageName}`);

      if (!(await imageExists(client, image.copyFromImageName))) {
        throw new Error(
          `Source image does not exist in PharoLauncher: ${image.copyFromImageName}`,
        );
      }

      if (await imageExists(client, image.imageName)) {
        throw new Error(
          `Target smoke image already exists in PharoLauncher: ${image.imageName}`,
        );
      }

      const copyResult = await client.callTool("pharo_launcher_image_copy", {
        imageName: image.copyFromImageName,
        newImageName: image.imageName,
      });
      launcherData(copyResult);
      image.copied = true;
      textResult("image copied", image.id);

      if (!(await waitForImageExists(client, image.imageName))) {
        throw new Error(
          `Copied image did not become visible in PharoLauncher: ${
            image.imageName
          }. Copy result: ${JSON.stringify(copyResult)}`,
        );
      }
    }

    if (!(await imageExists(client, image.imageName))) {
      throw new Error(`Image does not exist in PharoLauncher: ${image.imageName}`);
    }

    const preExistingProcess = await processForImage(client, image.imageName);
    if (preExistingProcess) {
      throw new Error(
        `Image ${image.id} is already running with pid ${preExistingProcess.pid}; stop it before running this smoke.`,
      );
    }
  }
}

function validateOpenedState(stateAfterOpen, options) {
  const ports = new Set();
  const pids = new Set();
  for (const image of options.images) {
    const imageState = stateAfterOpen?.images.find(
      (candidate) => candidate.id === image.id,
    );
    if (!imageState) {
      throw new Error(`State after open is missing image ${image.id}`);
    }
    textResult(
      "image state",
      `${image.id} status=${imageState.status} port=${
        imageState.assignedPort ?? "unknown"
      } pid=${imageState.pid ?? "unknown"}`,
    );
    if (image.active && imageState.status !== "running") {
      throw new Error(`Image ${image.id} status is ${imageState.status}, not running`);
    }
    if (imageState.assignedPort) {
      ports.add(imageState.assignedPort);
    }
    if (imageState.pid) {
      pids.add(imageState.pid);
    }
  }

  if (ports.size !== options.images.length) {
    throw new Error("Opened images did not receive distinct ports");
  }
  if (pids.size !== options.images.length) {
    throw new Error("Opened images did not receive distinct processes");
  }
}

async function assertClosed(client, gateway, openData, projectPaths, options) {
  const closeResult = await gateway.handleTool("plexus_project_close", {
    projectPath: projectPaths.projectRoot,
    stateRoot: projectPaths.stateRoot,
    workspaceId: options.workspaceId,
  });
  requireGatewayOk(closeResult, "plexus_project_close");
  textResult("close ok", closeResult.ok);

  for (const image of options.images) {
    const processAfterClose = await processForImage(client, image.imageName);
    if (processAfterClose) {
      throw new Error(
        `Process is still running after project close for ${image.id}: pid ${processAfterClose.pid}`,
      );
    }
    textResult("process after close", `${image.id}=gone`);
  }

  const statusAfterClose = await gateway.handleTool("plexus_project_status", {
    targetId: openData.state.targetId,
    refreshHealth: true,
  });
  const closedRoute = requireGatewayOk(statusAfterClose, "plexus_project_status");
  for (const image of options.images) {
    const closedImage = closedRoute.images?.find(
      (candidate) => candidate.id === image.id,
    );
    const routeSummary = closedImage
      ? `${closedImage.status}, routable=${closedImage.routable?.ok === true}`
      : "not registered";
    if (closedImage?.routable?.ok) {
      throw new Error(`Closed image ${image.id} route is still routable`);
    }
    textResult("route after close", `${image.id}=${routeSummary}`);
  }
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
  let opened = false;
  let projectPaths;
  let openData;

  try {
    await prepareImages(client, options);

    projectPaths = writeSmokeProjectConfig(options);
    textResult("projectRoot", projectPaths.projectRoot);
    textResult("stateRoot", projectPaths.stateRoot);
    textResult("fixtureRoot", projectPaths.fixtureRoot);
    textResult("workspaceId", options.workspaceId);
    textResult("targetId", options.targetId ?? "(derived from project/workspace)");
    for (const image of options.images) {
      textResult("imageName", `${image.id}=${image.imageName}`);
    }

    const openResult = await gateway.handleTool("plexus_project_open", {
      projectPath: projectPaths.projectRoot,
      stateRoot: projectPaths.stateRoot,
      workspaceId: options.workspaceId,
      ...(options.targetId ? { targetId: options.targetId } : {}),
    });
    openData = requireGatewayOk(openResult, "plexus_project_open");
    opened = true;
    textResult("open ok", openResult.ok);
    textResult("statePath", openData.statePath);

    validateOpenedState(loadProjectState(openData.statePath), options);
    await runDefaultRouteProbes(gateway, openData.state.targetId, options);
    await runMultiImageIsolationProbe(gateway, openData.state.targetId, options);
    await runConfiguredSteps(gateway, openData.state.targetId, options);

    if (options.scenario === "project-edit-export") {
      await runProjectEditExportScenario(
        gateway,
        openData.state.targetId,
        projectPaths,
        options,
      );
    }

    await assertClosed(client, gateway, openData, projectPaths, options);
    opened = false;

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

    for (const image of options.images ?? []) {
      if (image.imageName) {
        await cleanupStep(`process cleanup ${image.id}`, async () => {
          const stillRunning = await processForImage(client, image.imageName);
          if (stillRunning) {
            console.error(
              `cleanup: killing ${image.imageName} with pid ${stillRunning.pid}`,
            );
            await client.callTool("pharo_launcher_process_kill", {
              imageName: image.imageName,
              confirm: true,
            });
          }
        });
      }
    }

    for (const image of options.images ?? []) {
      await cleanupStep(`copied image delete ${image.id}`, async () => {
        if (image.copied) {
          console.error(`cleanup: deleting copied image ${image.imageName}`);
          await client.callTool("pharo_launcher_image_delete", {
            imageName: image.imageName,
            force: true,
            confirm: true,
          });
        }
      });
    }

    await cleanupStep("temp directory cleanup", async () => {
      if (projectPaths && !options.keepTemp) {
        if (projectPaths.ownsProjectRoot) {
          removeOwnedDirectory(projectPaths.projectRoot);
        }
        if (projectPaths.ownsStateRoot) {
          removeOwnedDirectory(projectPaths.stateRoot);
        }
        if (projectPaths.ownsFixtureRoot) {
          removeOwnedDirectory(projectPaths.fixtureRoot);
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
