import fs from "node:fs";
import path from "node:path";

export interface SourceBuildStaleness {
  packageRoot: string;
  sourceFile: string;
  sourceMtimeMs: number;
  distFile: string;
  distMtimeMs: number;
}

export interface SourceBuildPreflightOptions {
  packageName: string;
  buildCommand: string;
  env?: NodeJS.ProcessEnv;
}

const staleBuildBypassEnv = "PLEXUS_ALLOW_STALE_DIST";

function isBypassEnabled(env: NodeJS.ProcessEnv): boolean {
  const value = env[staleBuildBypassEnv];
  if (!value) {
    return false;
  }

  return ["1", "true", "yes"].includes(value.trim().toLowerCase());
}

function sourceFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return sourceFiles(filePath);
    }

    return entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".test.ts") &&
      !entry.name.endsWith(".d.ts")
      ? [filePath]
      : [];
  });
}

function newestSourceFile(sourceRoot: string):
  | { filePath: string; mtimeMs: number }
  | undefined {
  let newest: { filePath: string; mtimeMs: number } | undefined;
  for (const filePath of sourceFiles(sourceRoot)) {
    const mtimeMs = fs.statSync(filePath).mtimeMs;
    if (!newest || mtimeMs > newest.mtimeMs) {
      newest = { filePath, mtimeMs };
    }
  }

  return newest;
}

function packageRootAboveDist(distFile: string): string | undefined {
  let directory = path.dirname(distFile);
  while (true) {
    if (path.basename(directory) === "dist") {
      return path.dirname(directory);
    }

    const parent = path.dirname(directory);
    if (parent === directory) {
      return undefined;
    }
    directory = parent;
  }
}

export function findStaleSourceBuild(
  distEntrypointPath: string,
): SourceBuildStaleness | undefined {
  const distFile = path.resolve(distEntrypointPath);
  // Walk up to the "dist" directory rather than assuming the entrypoint sits
  // directly inside it: a bin can live deeper, as this one does.
  const packageRoot = packageRootAboveDist(distFile);
  if (packageRoot === undefined) {
    return undefined;
  }

  const sourceRoot = path.join(packageRoot, "src");
  if (
    !fs.existsSync(path.join(packageRoot, "package.json")) ||
    !fs.existsSync(sourceRoot)
  ) {
    return undefined;
  }

  const newestSource = newestSourceFile(sourceRoot);
  if (!newestSource) {
    return undefined;
  }

  const distMtimeMs = fs.statSync(distFile).mtimeMs;
  if (newestSource.mtimeMs <= distMtimeMs) {
    return undefined;
  }

  return {
    packageRoot,
    sourceFile: newestSource.filePath,
    sourceMtimeMs: newestSource.mtimeMs,
    distFile,
    distMtimeMs,
  };
}

export function assertFreshSourceBuildForEntrypoint(
  distEntrypointPath: string,
  options: SourceBuildPreflightOptions,
): void {
  const staleness = findStaleSourceBuild(distEntrypointPath);
  if (!staleness || isBypassEnabled(options.env ?? process.env)) {
    return;
  }

  throw new Error(
    [
      `${options.packageName} build output is older than its source checkout.`,
      `Newest source: ${staleness.sourceFile}`,
      `Entrypoint: ${staleness.distFile}`,
      `Run ${options.buildCommand} from ${staleness.packageRoot} or set ${staleBuildBypassEnv}=true to bypass.`,
    ].join("\n"),
  );
}
