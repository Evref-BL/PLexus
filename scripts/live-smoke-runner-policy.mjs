import fs from "node:fs";
import path from "node:path";

export const defaultTimeoutBudget = {
  setupMs: 30_000,
  imagePrepareMs: 120_000,
  openMs: 300_000,
  routingMs: 120_000,
  scenarioMs: 300_000,
  closeMs: 60_000,
  cleanupMs: 60_000,
};

const timeoutBudgetKeys = Object.keys(defaultTimeoutBudget);

export function sanitizeRuntimeId(value) {
  const sanitized = String(value ?? "")
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return sanitized || "default";
}

export function defaultProjectOwnedLauncherProfileName(projectId) {
  return ["plexus", sanitizeRuntimeId(projectId)].join("-");
}

export function defaultProjectOwnedLauncherProfileRoot({ stateRoot, projectId }) {
  return path.join(
    path.resolve(requiredString(stateRoot, "stateRoot")),
    "profiles",
    "pharo-launcher-mcp",
    sanitizeRuntimeId(requiredString(projectId, "projectId")),
  );
}

export function projectOwnedLauncherProfileEnvironment({
  stateRoot,
  projectId,
  launcherProfile,
  launcherProfileRoot,
}) {
  const root = path.resolve(
    launcherProfileRoot === undefined
      ? defaultProjectOwnedLauncherProfileRoot({ stateRoot, projectId })
      : requiredString(launcherProfileRoot, "--launcherProfileRoot"),
  );
  const profile =
    launcherProfile === undefined
      ? defaultProjectOwnedLauncherProfileName(projectId)
      : requiredString(launcherProfile, "--launcherProfile");

  return {
    PHARO_LAUNCHER_MCP_PROFILE: profile,
    PHARO_LAUNCHER_MCP_STATE_ROOT: root,
    PHARO_LAUNCHER_MCP_LAUNCHER_IMAGE: path.join(
      root,
      "launcher",
      "PharoLauncher.image",
    ),
    PHARO_LAUNCHER_MCP_IMAGES_DIR: path.join(root, "images"),
    PHARO_LAUNCHER_MCP_VMS_DIR: path.join(root, "vms"),
    PHARO_LAUNCHER_MCP_TEMPLATE_SOURCES_DIR: path.join(root, "templates"),
    PHARO_LAUNCHER_MCP_INIT_SCRIPTS_DIR: path.join(root, "init-scripts"),
    PHARO_LAUNCHER_MCP_LOGS_DIR: path.join(root, "logs"),
    PHARO_LAUNCHER_MCP_LAUNCHER_CONFIGURATION: path.join(
      root,
      "launcher",
      "pharo-launcher-cli-config.ston",
    ),
  };
}

export function defaultRunId(now = new Date(), pid = process.pid) {
  return sanitizeRuntimeId(
    `smoke-${now.toISOString().replaceAll(/[^0-9A-Za-z]+/g, "-")}-${pid}`,
  );
}

export function parseTimeoutBudget(value) {
  if (!value) {
    return { ...defaultTimeoutBudget };
  }

  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(
      `--timeoutBudgetJson must be valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("--timeoutBudgetJson must decode to a JSON object");
  }

  const budget = { ...defaultTimeoutBudget };
  for (const [key, rawValue] of Object.entries(parsed)) {
    if (!timeoutBudgetKeys.includes(key)) {
      throw new Error(`Unknown timeout budget key: ${key}`);
    }
    if (!Number.isInteger(rawValue) || rawValue <= 0) {
      throw new Error(`${key} must be a positive integer timeout in ms`);
    }
    budget[key] = rawValue;
  }

  return budget;
}

export function isPathInside(parent, candidate) {
  const normalizedParent = comparablePath(path.resolve(parent));
  const normalizedCandidate = comparablePath(path.resolve(candidate));
  const relative = path.relative(normalizedParent, normalizedCandidate);
  return (
    relative === "" ||
    (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

export function buildLiveSmokeRunPlan(options, context = {}) {
  const repoRoot = path.resolve(requiredString(context.repoRoot, "repoRoot"));
  const approvalProfile = requiredString(
    options.approvalProfile,
    "--approvalProfile",
  );
  const artifactRoot = requiredPath(options.artifactRoot, "--artifactRoot");
  const stateRoot = requiredPath(options.stateRoot, "--stateRoot");
  const projectId = requiredString(options.projectId, "--projectId");
  const launcherProfileEnvironment = projectOwnedLauncherProfileEnvironment({
    stateRoot,
    projectId,
    launcherProfile: options.launcherProfile,
    launcherProfileRoot: options.launcherProfileRoot,
  });
  const launcherProfileRoot =
    launcherProfileEnvironment.PHARO_LAUNCHER_MCP_STATE_ROOT;
  const launcherProfile =
    launcherProfileEnvironment.PHARO_LAUNCHER_MCP_PROFILE;
  const runId = sanitizeRuntimeId(
    options.runId ?? defaultRunId(context.now ?? new Date(), context.pid ?? process.pid),
  );
  const workspaceId = sanitizeRuntimeId(options.workspaceId ?? runId);
  const targetId = sanitizeRuntimeId(
    options.targetId ?? `${projectId}--${workspaceId}`,
  );

  validatePrefix(
    workspaceId,
    options.requiredWorkspacePrefix,
    "--workspaceId",
    "--requiredWorkspacePrefix",
  );
  validatePrefix(
    targetId,
    options.requiredTargetPrefix,
    "--targetId",
    "--requiredTargetPrefix",
  );

  assertDisposablePath(stateRoot, "--stateRoot", repoRoot);
  assertDisposablePath(artifactRoot, "--artifactRoot", repoRoot);
  assertDisposablePath(launcherProfileRoot, "--launcherProfileRoot", repoRoot);
  if (options.projectRoot) {
    assertDisposablePath(options.projectRoot, "--projectRoot", repoRoot);
  }
  if (options.fixtureRoot) {
    assertDisposablePath(options.fixtureRoot, "--fixtureRoot", repoRoot);
  }
  if (options.homePath) {
    assertDisposablePath(options.homePath, "--homePath", repoRoot);
  }

  validateDisposableImages(options.images ?? []);

  const resolvedArtifactRoot = path.resolve(artifactRoot);
  return {
    approvalProfile,
    launcherProfile,
    launcherProfileRoot,
    launcherProfileEnvironment,
    runId,
    workspaceId,
    targetId,
    artifactRoot: resolvedArtifactRoot,
    artifactDirectory: path.join(resolvedArtifactRoot, runId),
    timeoutBudget: parseTimeoutBudget(options.timeoutBudgetJson),
  };
}

export function mcpPharoTonelLoadScriptSource(repoDir) {
  const sourceDirectory = path.join(path.resolve(repoDir), "src");
  return [
    '"Load MCP-Pharo from an explicit local Tonel checkout for this PLexus smoke run."',
    "Metacello new",
    "  baseline: 'MCP';",
    `  repository: ${smalltalkString(`tonel://${sourceDirectory.replaceAll("\\", "/")}`)};`,
    "  load: 'Core'.",
    "",
  ].join("\n");
}

export function usesDefaultSmokeLoadScript({
  imageLoadScriptExplicit,
  loadScriptExplicit,
}) {
  return !imageLoadScriptExplicit && !loadScriptExplicit;
}

function templateName(value) {
  return typeof value?.name === "string" && value.name.trim().length > 0
    ? value.name.trim()
    : undefined;
}

function templateCategory(value) {
  return typeof value?.category === "string" && value.category.trim().length > 0
    ? value.category.trim()
    : undefined;
}

function templateCategoryMatches(requestedCategory, candidateCategory) {
  if (!requestedCategory) {
    return true;
  }

  return (
    !candidateCategory ||
    candidateCategory === "uncategorized" ||
    candidateCategory === requestedCategory
  );
}

function templateMatchesRequestedName(requestedName, candidateName) {
  return (
    candidateName === requestedName ||
    candidateName.startsWith(`${requestedName} (`)
  );
}

function describeTemplate(candidate) {
  const name = templateName(candidate);
  if (!name) {
    return undefined;
  }

  const category = templateCategory(candidate);
  return category ? `${category}/${name}` : name;
}

function sourceTemplateFromCandidate(candidate) {
  const name = templateName(candidate);
  if (!name) {
    return undefined;
  }

  const category = templateCategory(candidate);
  return {
    name,
    ...(category && category !== "uncategorized" ? { category } : {}),
  };
}

export function resolveRequestedSourceTemplate(request, templates) {
  const requestedName = requiredString(request?.name, "sourceTemplateName");
  const requestedCategory =
    typeof request?.category === "string" && request.category.trim().length > 0
      ? request.category.trim()
      : undefined;
  const candidates = Array.isArray(templates) ? templates : [];
  const exact = candidates.find((candidate) => {
    const candidateName = templateName(candidate);
    return (
      candidateName === requestedName &&
      templateCategoryMatches(requestedCategory, templateCategory(candidate))
    );
  });
  const legacyNameMatch =
    exact ??
    candidates.find((candidate) => {
      const candidateName = templateName(candidate);
      return (
        candidateName !== undefined &&
        templateMatchesRequestedName(requestedName, candidateName) &&
        templateCategoryMatches(requestedCategory, templateCategory(candidate))
      );
    });
  const resolved = sourceTemplateFromCandidate(legacyNameMatch);
  if (resolved) {
    return resolved;
  }

  const requested = requestedCategory
    ? `${requestedCategory}/${requestedName}`
    : requestedName;
  const available = candidates
    .map(describeTemplate)
    .filter(Boolean)
    .join(", ");
  throw new Error(
    [
      `Requested source template was not found: ${requested}`,
      available
        ? `Available templates: ${available}`
        : "No named templates were returned.",
    ].join("\n"),
  );
}

export function defaultSmokeImageSpec(options) {
  return {
    id: options.imageId,
    imageName: options.imageName,
    copyFromImageName: options.copyFromImageName,
    port: options.port,
    ...(options.loadScriptExplicit ? { loadScript: options.loadScript } : {}),
    active: true,
  };
}

export function assertMcpPharoRepoDir(repoDir) {
  const resolvedRepoDir = path.resolve(requiredString(repoDir, "--mcpPharoRepoDir"));
  const baselinePath = path.join(
    resolvedRepoDir,
    "src",
    "BaselineOfMCP",
    "BaselineOfMCP.class.st",
  );
  if (!fs.existsSync(baselinePath)) {
    throw new Error(
      `--mcpPharoRepoDir must point at an MCP-Pharo checkout with src/BaselineOfMCP/BaselineOfMCP.class.st: ${resolvedRepoDir}`,
    );
  }

  return resolvedRepoDir;
}

export function resolveSmokeLoadScriptPath(image, options, context = {}) {
  const loadScript = requiredString(
    image.loadScript,
    `image ${image.id ?? "(unknown)"} loadScript`,
  );
  if (path.isAbsolute(loadScript)) {
    return path.resolve(loadScript);
  }

  if (!options.projectRoot) {
    throw new Error(
      `Image ${image.id} loadScript is relative (${loadScript}) but --projectRoot is not set; pass an absolute --loadScript, set --projectRoot, or use --mcpPharoRepoDir.`,
    );
  }

  return path.resolve(options.projectRoot ?? context.repoRoot, loadScript);
}

export function assertSmokeLoadScriptsReady(options, context = {}) {
  const checked = [];
  for (const image of options.images ?? []) {
    const resolvedPath = resolveSmokeLoadScriptPath(image, options, context);
    const exists = fs.existsSync(resolvedPath);
    checked.push({
      imageId: image.id,
      loadScript: image.loadScript,
      resolvedPath,
      exists,
      gitTransport: image.git?.transport,
    });

    if (!exists && !options.allowRemoteMcpFallback) {
      throw new Error(
        [
          `Image ${image.id} MCP load script does not exist before image startup: ${resolvedPath}`,
          "Pass --loadScript pointing at a real script, use --mcpPharoRepoDir to generate a local Tonel load script, or pass --allowRemoteMcpFallback to explicitly use the configured remote Metacello fallback.",
        ].join("\n"),
      );
    }
  }

  return checked;
}

export function smokeProjectConfig(options) {
  return {
    id: requiredString(options.projectId, "projectId"),
    name: "plexus-smoke-open-route-close",
    ...(options.homePath
      ? {
          home: {
            path: path.resolve(options.homePath),
            imageCache: {
              enabled: true,
            },
          },
        }
      : {}),
    images: (options.images ?? []).map((image) => ({
      id: image.id,
      imageName: image.imageName,
      active: image.active,
      ...(image.create ? { create: image.create } : {}),
      mcp: {
        loadScript: image.loadScript,
        ...(image.port ? { port: image.port } : {}),
      },
      ...(image.git ? { git: image.git } : {}),
    })),
  };
}

export function assertKeepOpenShowcaseBoundary(options) {
  if (!options.keepOpen) {
    return;
  }

  const stateRoot = requiredPath(options.stateRoot, "--stateRoot");
  const launcherProfileRoot = requiredPath(
    options.launcherProfileRoot,
    "--launcherProfileRoot",
  );
  if (!isPathInside(stateRoot, launcherProfileRoot)) {
    throw new Error(
      "--launcherProfileRoot must be inside --stateRoot for keep-open mode",
    );
  }

  const images = options.images ?? [];
  if (images.length === 0) {
    throw new Error("Keep-open mode requires at least one image");
  }
  for (const image of images) {
    if (!image.copyFromImageName && !options.createSourceFromTemplate) {
      throw new Error(
        `Keep-open mode requires copied or template-created disposable images; image ${image.id} only references an existing imageName`,
      );
    }
  }
}

export function buildKeepOpenCleanupContext({
  projectPaths,
  options,
  openData,
}) {
  const projectRoot = requiredString(
    projectPaths?.projectRoot,
    "projectPaths.projectRoot",
  );
  const stateRoot = requiredString(projectPaths?.stateRoot, "projectPaths.stateRoot");
  const workspaceId = requiredString(options?.workspaceId, "options.workspaceId");
  const targetId = requiredString(
    openData?.state?.targetId ?? options?.targetId,
    "openData.state.targetId",
  );
  const copiedImages = (options?.images ?? [])
    .filter((image) => image.copied && image.imageName)
    .map((image) => ({
      id: image.id,
      imageName: image.imageName,
    }));
  const cleanupImageNames = [
    ...copiedImages.map((image) => image.imageName),
    ...(options?.createdSourceImageName ? [options.createdSourceImageName] : []),
  ];

  const closeCommand = [
    "plexus",
    "project",
    "close",
    projectRoot,
    "--workspace-id",
    workspaceId,
    "--state-root",
    stateRoot,
  ];
  const statusCommand = [
    "plexus",
    "project",
    "status",
    projectRoot,
    "--workspace-id",
    workspaceId,
    "--state-root",
    stateRoot,
  ];

  return {
    mode: "keep-open",
    reason:
      "Runner was asked to retain the scoped disposable project and images after successful smoke validation.",
    closeCommand,
    closeCommandString: shellCommand(closeCommand),
    statusCommand,
    statusCommandString: shellCommand(statusCommand),
    mcpCloseCall: {
      tool: "plexus_project_close",
      arguments: {
        projectPath: projectRoot,
        stateRoot,
        workspaceId,
      },
    },
    launcherCleanup: {
      profile: options?.launcherProfile,
      profileRoot: options?.launcherProfileRoot,
      environment: options?.launcherProfileEnvironment,
      deleteImageToolCalls: cleanupImageNames.map((imageName) => ({
        tool: "pharo_launcher_image_delete",
        arguments: {
          imageName,
          force: true,
          confirm: true,
        },
      })),
    },
    routeControl: {
      targetId,
      controlEndpoint: openData?.state?.gateway?.controlEndpoint,
      routeStatusTool: "plexus_gateway_status",
      routeStatusArguments: {
        targetId,
        refreshHealth: true,
      },
    },
    retained: {
      artifactDirectory: options?.artifactDirectory,
      eventsPath: options?.artifactEventsPath,
      projectRoot,
      stateRoot,
      fixtureRoot: projectPaths?.fixtureRoot,
      launcherProfile: options?.launcherProfile,
      launcherProfileRoot: options?.launcherProfileRoot,
      statePath: openData?.statePath,
      copiedImages,
      createdSourceImageName: options?.createdSourceImageName,
      images: (openData?.state?.images ?? []).map((image) => ({
        id: image.id,
        imageName: image.imageName,
        assignedPort: image.assignedPort,
        pid: image.pid,
        status: image.status,
      })),
    },
  };
}

export function collectLauncherLogFiles({ logsDir, imageNames = [] }) {
  if (!logsDir || !fs.existsSync(logsDir)) {
    return [];
  }

  const imageSegments = imageNames
    .filter((imageName) => typeof imageName === "string" && imageName.length > 0)
    .map(safeFileSegment);
  if (imageSegments.length === 0) {
    return [];
  }

  return fs
    .readdirSync(logsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(logsDir, entry.name))
    .filter(
      (filePath) =>
        /\.(?:out|err)\.log$/.test(path.basename(filePath)) &&
        imageSegments.some((segment) => path.basename(filePath).includes(segment)),
    )
    .sort();
}

export function formatToolFailure(label, result, context = {}) {
  const lines = [
    `${label} failed: ${result?.error ?? JSON.stringify(result)}`,
  ];
  const failures = result?.diagnostics?.projectOpen?.failures;
  if (Array.isArray(failures) && failures.length > 0) {
    lines.push("project open failures:");
    for (const failure of failures) {
      lines.push(
        `- ${failure.imageId}/${failure.imageName}: ${failure.message}`,
      );
    }
  }

  if (context.launcherLogFiles?.length > 0) {
    lines.push("launcher logs:");
    for (const filePath of context.launcherLogFiles) {
      lines.push(`- ${filePath}`);
    }
  }

  if (result?.diagnostics) {
    lines.push(`diagnostics: ${JSON.stringify(result.diagnostics, null, 2)}`);
  }

  return lines.join("\n");
}

export function assertFreshPharoLauncherMcpHealth(healthResult, runtime = {}) {
  const runtimeLabel = pharoLauncherMcpRuntimeLabel(runtime);
  const remediation =
    "Use --pharoLauncherMcpRepoDir, PLEXUS_SMOKE_PHARO_LAUNCHER_MCP_REPO_DIR, or PHARO_LAUNCHER_MCP_REPO_DIR to run the smoke against the current pharo-launcher-mcp component source or packed artifact.";

  const discovery = assertPharoLauncherMcpDiscoveryMetadata(
    healthResult,
    runtime,
  );

  const health = healthResult.health;
  if (healthResult.ok !== true || health.ok !== true) {
    throw new Error(
      `pharo-launcher-mcp preflight failed before image mutation for ${runtimeLabel}. ${remediation} Health: ${JSON.stringify(healthResult)}`,
    );
  }

  return discovery;
}

export function assertPharoLauncherMcpDiscoveryMetadata(
  healthResult,
  runtime = {},
) {
  const runtimeLabel = pharoLauncherMcpRuntimeLabel(runtime);
  const remediation =
    "Use --pharoLauncherMcpRepoDir, PLEXUS_SMOKE_PHARO_LAUNCHER_MCP_REPO_DIR, or PHARO_LAUNCHER_MCP_REPO_DIR to run the smoke against the current pharo-launcher-mcp component source or packed artifact.";

  if (!healthResult || typeof healthResult !== "object") {
    throw new Error(
      `pharo-launcher-mcp preflight failed before image mutation: --health did not return a JSON object for ${runtimeLabel}. ${remediation}`,
    );
  }

  const health = healthResult.health;
  if (!health || typeof health !== "object") {
    throw new Error(
      `pharo-launcher-mcp preflight failed before image mutation: --health did not return health details for ${runtimeLabel}. ${remediation}`,
    );
  }

  const discovery = health.config?.discovery;
  if (!discovery || typeof discovery.source !== "string") {
    throw new Error(
      `pharo-launcher-mcp preflight failed before image mutation: ${runtimeLabel} does not report launcher discovery metadata. This usually means PLexus is resolving a stale installed @evref-bl/pharo-launcher-mcp package instead of the current component source. ${remediation}`,
    );
  }

  return {
    discoverySource: discovery.source,
  };
}

function requiredString(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} is required for live smoke runs`);
  }
  return value.trim();
}

function smalltalkString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function safeFileSegment(value) {
  const cleaned = String(value).replaceAll(/[^A-Za-z0-9._-]+/g, "-");
  return cleaned.length > 0 ? cleaned : "image";
}

function requiredPath(value, label) {
  return path.resolve(requiredString(value, label));
}

function shellCommand(args) {
  return args.map(shellQuote).join(" ");
}

function shellQuote(value) {
  const text = String(value);
  if (/^[A-Za-z0-9_./:=@+-]+$/.test(text)) {
    return text;
  }

  return `'${text.replaceAll("'", "'\\''")}'`;
}

function pharoLauncherMcpRuntimeLabel(runtime) {
  const source = typeof runtime.source === "string" ? runtime.source : "unknown";
  const pathValue =
    typeof runtime.repoDir === "string"
      ? runtime.repoDir
      : typeof runtime.packageDir === "string"
        ? runtime.packageDir
        : typeof runtime.entry === "string"
          ? runtime.entry
          : runtime.command;
  return `${source}${pathValue ? ` runtime at ${pathValue}` : " runtime"}`;
}

function comparablePath(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function assertDisposablePath(value, label, repoRoot) {
  const resolved = path.resolve(value);
  if (path.parse(resolved).root === resolved) {
    throw new Error(`${label} must not point at a filesystem root`);
  }
  if (isPathInside(repoRoot, resolved)) {
    throw new Error(`${label} must be outside the PLexus source checkout`);
  }
}

function validatePrefix(value, prefix, valueLabel, prefixLabel) {
  if (!prefix) {
    return;
  }
  if (!value.startsWith(prefix)) {
    throw new Error(`${valueLabel} must start with ${prefixLabel} ${prefix}`);
  }
}

function validateDisposableImages(images) {
  for (const image of images) {
    if (
      image.imageName &&
      image.copyFromImageName &&
      image.imageName === image.copyFromImageName
    ) {
      throw new Error(
        `Image ${image.id} target imageName must differ from copyFromImageName`,
      );
    }
  }
}
