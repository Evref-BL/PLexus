import fs from "node:fs";
import path from "node:path";

import { loadPharoLauncherConfig } from "@evref-bl/pharo-launcher-mcp/dist/config.js";
import { defaultLauncherDir } from "@evref-bl/pharo-launcher-mcp/dist/platform.js";

import type {
  ProjectHomeImageCacheNetworkPolicy,
  ProjectLauncherTemplateCatalogPolicy,
  ProjectLauncherTemplateCatalogSource,
} from "../config/projectConfig.js";

const defaultTemplateSourcesUrl =
  "https://files.pharo.org/pharo-launcher/sources.list";
const templateSourcesFileName = "sources.list";

interface TemplateCatalogCandidate {
  kind: "explicit-path" | "active-profile" | "user-profile" | "installation";
  path: string;
}

export type ScopedTemplateCatalogBootstrapResult =
  | {
      ok: true;
      action: "disabled" | "already-present" | "seeded" | "downloaded";
      refreshTemplateCatalog: boolean;
      source?: string;
      sourcePath?: string;
      serverSourcesUrl?: string;
      bytes?: number;
      copiedEntries?: number;
    }
  | {
      ok: false;
      message: string;
      details: {
        destinationDirectory?: string;
        source: ProjectLauncherTemplateCatalogSource;
        networkPolicy: ProjectHomeImageCacheNetworkPolicy;
        searchedPaths: string[];
        serverSourcesUrl?: string;
        error?: string;
      };
    };

export interface PrepareScopedTemplateCatalogOptions {
  destinationDirectory?: string;
  policy?: ProjectLauncherTemplateCatalogPolicy;
  networkPolicy: ProjectHomeImageCacheNetworkPolicy;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  fetch?: typeof fetch;
}

function nonEmptyFile(filePath: string): boolean {
  try {
    const stat = fs.statSync(filePath);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

function readableDirectory(directoryPath: string): boolean {
  try {
    const stat = fs.statSync(directoryPath);
    if (!stat.isDirectory()) {
      return false;
    }

    fs.accessSync(directoryPath, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function hasInstalledTemplates(directoryPath: string): boolean {
  if (!readableDirectory(directoryPath)) {
    return false;
  }

  return fs.readdirSync(directoryPath, { withFileTypes: true }).some((entry) => {
    if (entry.name === templateSourcesFileName) {
      return false;
    }

    return (
      (entry.isFile() && entry.name.toLowerCase().endsWith(".ston")) ||
      entry.isDirectory()
    );
  });
}

function hasInstalledTemplateSeed(catalogPath: string): boolean {
  if (
    nonEmptyFile(catalogPath) &&
    path.basename(catalogPath).toLowerCase().endsWith(".ston")
  ) {
    return true;
  }

  return hasInstalledTemplates(catalogPath);
}

function hasTemplateCatalogSeed(catalogPath: string): boolean {
  if (nonEmptyFile(catalogPath)) {
    return true;
  }

  if (!readableDirectory(catalogPath)) {
    return false;
  }

  return (
    nonEmptyFile(path.join(catalogPath, templateSourcesFileName)) ||
    hasInstalledTemplates(catalogPath)
  );
}

function sourcePolicy(
  policy: ProjectLauncherTemplateCatalogPolicy | undefined,
): ProjectLauncherTemplateCatalogSource {
  if (policy?.source) {
    return policy.source;
  }

  return policy?.path ? "path" : "user-or-server";
}

function catalogCandidatePaths(rootPath: string): string[] {
  return [
    path.join(rootPath, "templates"),
    path.join(rootPath, "template-sources"),
    path.join(rootPath, "templateSources"),
    path.join(rootPath, templateSourcesFileName),
    path.join(rootPath, "Contents", "Resources", "templates"),
    path.join(rootPath, "Contents", "Resources", templateSourcesFileName),
  ];
}

function uniqueCandidates(
  candidates: TemplateCatalogCandidate[],
  destinationDirectory: string,
): TemplateCatalogCandidate[] {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const resolved = path.resolve(candidate.path);
    if (
      resolved === path.resolve(destinationDirectory) ||
      seen.has(resolved)
    ) {
      return false;
    }

    seen.add(resolved);
    return true;
  });
}

function candidatePaths(options: {
  policy?: ProjectLauncherTemplateCatalogPolicy;
  source: ProjectLauncherTemplateCatalogSource;
  destinationDirectory: string;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
}): TemplateCatalogCandidate[] {
  if (options.source === "server" || options.source === "none") {
    return [];
  }

  if (options.source === "path") {
    return options.policy?.path
      ? [
          {
            kind: "explicit-path",
            path: options.policy.path,
          },
        ]
      : [];
  }

  const launcherConfig = loadPharoLauncherConfig(options.env, options.platform);
  const candidates: TemplateCatalogCandidate[] = [];
  if (options.policy?.path) {
    candidates.push({
      kind: "explicit-path",
      path: options.policy.path,
    });
  }
  if (launcherConfig.profile?.templateSourcesDir) {
    candidates.push({
      kind: "active-profile",
      path: launcherConfig.profile.templateSourcesDir,
    });
  }

  for (const pathCandidate of catalogCandidatePaths(
    defaultLauncherDir(options.env, options.platform),
  )) {
    candidates.push({
      kind: "user-profile",
      path: pathCandidate,
    });
  }
  for (const pathCandidate of catalogCandidatePaths(launcherConfig.launcherDir)) {
    candidates.push({
      kind: "installation",
      path: pathCandidate,
    });
  }

  return uniqueCandidates(candidates, options.destinationDirectory);
}

function copyIfPresent(sourcePath: string, destinationPath: string): number {
  if (!fs.existsSync(sourcePath)) {
    return 0;
  }

  fs.cpSync(sourcePath, destinationPath, {
    force: true,
    recursive: true,
  });
  return 1;
}

function seedCatalogFromPath(
  sourcePath: string,
  destinationDirectory: string,
): number {
  fs.mkdirSync(destinationDirectory, { recursive: true });

  const stat = fs.statSync(sourcePath);
  if (stat.isFile()) {
    const targetName =
      path.basename(sourcePath) === templateSourcesFileName
        ? templateSourcesFileName
        : path.basename(sourcePath);
    fs.copyFileSync(sourcePath, path.join(destinationDirectory, targetName));
    return stat.size;
  }

  let copied = 0;
  copied += copyIfPresent(
    path.join(sourcePath, templateSourcesFileName),
    path.join(destinationDirectory, templateSourcesFileName),
  );
  for (const entry of fs.readdirSync(sourcePath, { withFileTypes: true })) {
    if (entry.name === templateSourcesFileName) {
      continue;
    }
    if (!entry.isDirectory() && !entry.name.toLowerCase().endsWith(".ston")) {
      continue;
    }

    copied += copyIfPresent(
      path.join(sourcePath, entry.name),
      path.join(destinationDirectory, entry.name),
    );
  }

  return copied;
}

async function downloadServerSources(options: {
  url: string;
  destinationDirectory: string;
  fetch?: typeof fetch;
}): Promise<number> {
  const fetchSources = options.fetch ?? fetch;
  const response = await fetchSources(options.url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`.trim());
  }

  const body = await response.text();
  if (body.trim().length === 0) {
    throw new Error("downloaded template source list was empty");
  }

  fs.mkdirSync(options.destinationDirectory, { recursive: true });
  const sourcesPath = path.join(
    options.destinationDirectory,
    templateSourcesFileName,
  );
  const tempPath = `${sourcesPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tempPath, body, "utf8");
    fs.renameSync(tempPath, sourcesPath);
  } finally {
    fs.rmSync(tempPath, { force: true });
  }

  return Buffer.byteLength(body, "utf8");
}

function failure(options: {
  message: string;
  destinationDirectory: string;
  source: ProjectLauncherTemplateCatalogSource;
  networkPolicy: ProjectHomeImageCacheNetworkPolicy;
  searchedPaths: string[];
  serverSourcesUrl?: string;
  error?: string;
}): ScopedTemplateCatalogBootstrapResult {
  return {
    ok: false,
    message: options.message,
    details: {
      destinationDirectory: options.destinationDirectory,
      source: options.source,
      networkPolicy: options.networkPolicy,
      searchedPaths: options.searchedPaths,
      ...(options.serverSourcesUrl
        ? { serverSourcesUrl: options.serverSourcesUrl }
        : {}),
      ...(options.error ? { error: options.error } : {}),
    },
  };
}

export async function prepareScopedTemplateCatalog(
  options: PrepareScopedTemplateCatalogOptions,
): Promise<ScopedTemplateCatalogBootstrapResult> {
  const source = sourcePolicy(options.policy);
  if (source === "none") {
    return {
      ok: true,
      action: "disabled",
      refreshTemplateCatalog: false,
    };
  }

  const destinationDirectory = options.destinationDirectory;
  if (!destinationDirectory) {
    return {
      ok: true,
      action: "disabled",
      refreshTemplateCatalog: false,
    };
  }

  if (hasInstalledTemplateSeed(destinationDirectory)) {
    return {
      ok: true,
      action: "already-present",
      refreshTemplateCatalog: false,
    };
  }
  if (hasTemplateCatalogSeed(destinationDirectory)) {
    if (options.networkPolicy === "local-only") {
      return failure({
        message:
          "Scoped template catalogue has no installed templates and local-only policy forbids refresh",
        destinationDirectory,
        source,
        networkPolicy: options.networkPolicy,
        searchedPaths: [],
      });
    }

    return {
      ok: true,
      action: "already-present",
      refreshTemplateCatalog: true,
    };
  }

  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const candidates = candidatePaths({
    policy: options.policy,
    source,
    destinationDirectory,
    env,
    platform,
  });
  const searchedPaths = candidates.map((candidate) => candidate.path);
  const candidate = candidates.find((item) => hasTemplateCatalogSeed(item.path));
  if (candidate) {
    if (
      options.networkPolicy === "local-only" &&
      !hasInstalledTemplateSeed(candidate.path)
    ) {
      return failure({
        message:
          "Scoped template catalogue has no installed templates and local-only policy forbids refresh",
        destinationDirectory,
        source,
        networkPolicy: options.networkPolicy,
        searchedPaths,
      });
    }

    const copiedEntries = seedCatalogFromPath(
      candidate.path,
      destinationDirectory,
    );
    return {
      ok: true,
      action: "seeded",
      source: candidate.kind,
      sourcePath: candidate.path,
      copiedEntries,
      refreshTemplateCatalog: options.networkPolicy === "online",
    };
  }

  if (source === "path" || source === "user") {
    return failure({
      message: "Scoped template catalogue source was not readable",
      destinationDirectory,
      source,
      networkPolicy: options.networkPolicy,
      searchedPaths,
    });
  }
  if (options.networkPolicy === "local-only") {
    return failure({
      message:
        "Scoped template catalogue is missing and local-only policy forbids server bootstrap",
      destinationDirectory,
      source,
      networkPolicy: options.networkPolicy,
      searchedPaths,
    });
  }

  const serverSourcesUrl =
    options.policy?.serverSourcesUrl ?? defaultTemplateSourcesUrl;
  try {
    const bytes = await downloadServerSources({
      url: serverSourcesUrl,
      destinationDirectory,
      fetch: options.fetch,
    });
    return {
      ok: true,
      action: "downloaded",
      serverSourcesUrl,
      bytes,
      refreshTemplateCatalog: true,
    };
  } catch (error) {
    return failure({
      message: "Scoped template catalogue server bootstrap failed",
      destinationDirectory,
      source,
      networkPolicy: options.networkPolicy,
      searchedPaths,
      serverSourcesUrl,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
