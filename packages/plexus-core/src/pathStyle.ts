import path from "node:path";

export function isWindowsAbsolutePath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\");
}

export function isPosixAbsolutePath(value: string): boolean {
  return value.startsWith("/");
}

export function isAbsolutePathLike(value: string): boolean {
  return isWindowsAbsolutePath(value) || isPosixAbsolutePath(value);
}

export function pathApiForPath(value: string): path.PlatformPath {
  if (isWindowsAbsolutePath(value)) {
    return path.win32;
  }

  if (isPosixAbsolutePath(value)) {
    return path.posix;
  }

  return path;
}

export function resolvePathLike(value: string, ...segments: string[]): string {
  return pathApiForPath(value).resolve(value, ...segments);
}

export function joinPathLike(value: string, ...segments: string[]): string {
  return pathApiForPath(value).join(value, ...segments);
}

export function dirnamePathLike(value: string): string {
  return pathApiForPath(value).dirname(value);
}

export function basenamePathLike(value: string): string {
  const pathApi = pathApiForPath(value);
  return pathApi.basename(pathApi.resolve(value));
}
