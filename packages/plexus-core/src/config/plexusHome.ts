import os from "node:os";
import type {
  ProjectConfig,
  ProjectHomeDependencyRepositoryNetworkPolicy,
  ProjectHomeImageCacheNetworkPolicy,
} from "./projectConfig.js";
import { joinPathLike, resolvePathLike } from "../support/pathStyle.js";

export const plexusHomeEnvironmentKey = "PLEXUS_HOME";
export const defaultPlexusHomeDirectoryName = ".plexus";
export const homeImageCacheDirectoryName = "image-cache";
export const homeDependencyRepositoriesDirectoryName = "repositories";
export const homeDependencyIcebergDirectoryName = "iceberg";

export function defaultPlexusHomePath(homeDirectory = os.homedir()): string {
  return joinPathLike(homeDirectory, defaultPlexusHomeDirectoryName);
}

export function resolvePlexusHomePath(options: {
  config?: Pick<ProjectConfig, "home">;
  env?: NodeJS.ProcessEnv;
  homeDirectory?: string;
} = {}): string {
  const env = options.env ?? process.env;
  const configured = env[plexusHomeEnvironmentKey] ?? options.config?.home?.path;
  return configured
    ? resolvePathLike(configured)
    : defaultPlexusHomePath(options.homeDirectory);
}

export function homeImageCacheEnabled(
  config: Pick<ProjectConfig, "home">,
): boolean {
  return config.home?.imageCache.enabled ?? true;
}

export function homeImageCacheNetworkPolicy(
  config: Pick<ProjectConfig, "home">,
): ProjectHomeImageCacheNetworkPolicy {
  return config.home?.imageCache.networkPolicy ?? "online";
}

export function homeDependencyRepositoryCachePath(homePath: string): string {
  return joinPathLike(
    homePath,
    homeDependencyRepositoriesDirectoryName,
    homeDependencyIcebergDirectoryName,
  );
}

export function homeDependencyRepositoryNetworkPolicy(
  config: Pick<ProjectConfig, "home">,
): ProjectHomeDependencyRepositoryNetworkPolicy {
  return config.home?.dependencyRepositories?.networkPolicy ?? "online";
}
