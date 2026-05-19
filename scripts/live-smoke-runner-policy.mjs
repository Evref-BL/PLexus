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

function requiredPath(value, label) {
  return path.resolve(requiredString(value, label));
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
