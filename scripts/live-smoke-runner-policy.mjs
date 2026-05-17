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
  const launcherProfileRoot = requiredPath(
    options.launcherProfileRoot,
    "--launcherProfileRoot",
  );
  const launcherProfile = options.launcherProfile ?? approvalProfile;
  const runId = sanitizeRuntimeId(
    options.runId ?? defaultRunId(context.now ?? new Date(), context.pid ?? process.pid),
  );
  const workspaceId = sanitizeRuntimeId(options.workspaceId ?? runId);
  const targetId = sanitizeRuntimeId(
    options.targetId ?? `${options.projectId}--${workspaceId}`,
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
    runId,
    workspaceId,
    targetId,
    artifactRoot: resolvedArtifactRoot,
    artifactDirectory: path.join(resolvedArtifactRoot, runId),
    timeoutBudget: parseTimeoutBudget(options.timeoutBudgetJson),
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
