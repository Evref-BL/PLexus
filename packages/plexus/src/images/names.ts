import path from "node:path";
import { PlexusError } from "../errors.js";

const namePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

// The first dash of a disk name ends its scope. A scope that could hold one
// would make `shop-api-dev` both image `api-dev` of `shop` and image `dev` of
// `shop-api`, and each scope would list, stop and delete the other's.
const scopePattern = /^[A-Za-z0-9][A-Za-z0-9._]{0,63}$/;

/** The disk names of bases being built, which share the store with images. */
export const buildPrefix = "plexus-build-";

function check(value: unknown, what: string): string {
  if (typeof value !== "string" || !namePattern.test(value)) {
    throw new PlexusError(
      "invalid-name",
      `${what} ${JSON.stringify(value)} is not valid: use 1 to 64 letters, digits, dots, dashes or underscores, starting with a letter or a digit.`,
    );
  }
  return value;
}

/**
 * The scope a caller gave, or nothing for none. An empty scope is refused
 * rather than read as none, since none reaches every image in the store.
 */
export function checkScope(scope: unknown): string | undefined {
  if (scope === undefined) {
    return undefined;
  }
  if (typeof scope !== "string" || !scopePattern.test(scope)) {
    throw new PlexusError(
      "invalid-name",
      `Scope ${JSON.stringify(scope)} is not valid: use 1 to 64 letters, digits, dots or underscores, starting with a letter or a digit. A dash separates the scope from the image name, so a scope holds none.`,
    );
  }
  return scope;
}

/**
 * The scope of a project: its directory's name, with each run of characters
 * a scope cannot hold made one `_`, leading ones dropped, cut to 64 and
 * trailing `_` dropped; `default` when nothing is left.
 */
export function scopeOfProject(directory: string): string {
  const sanitized = path
    .basename(path.resolve(directory))
    .replace(/[^A-Za-z0-9._]+/g, "_")
    .replace(/^[^A-Za-z0-9]+/, "")
    .slice(0, 64)
    .replace(/_+$/, "");
  return sanitized || "default";
}

/** The directory and file base name of an image in the store. */
export function diskName(name: unknown, scope: string | undefined): string {
  const checked = check(name, "Image name");
  const disk = scope === undefined ? checked : `${scope}-${checked}`;
  if (startsWithIgnoringCase(disk, buildPrefix)) {
    throw new PlexusError(
      "invalid-name",
      `Image name ${JSON.stringify(checked)} is not valid: ${buildPrefix} names the bases PLexus builds.`,
    );
  }
  return disk;
}

/**
 * The name a directory of the store answers to in this scope, or nothing
 * when it is out of scope or is not an image's. Case is ignored, as macOS
 * and Windows ignore it in a path: there, `Shop-dev` is the directory
 * `shop-dev` is, so scopes `Shop` and `shop` are one scope on every system.
 */
export function nameOfDisk(disk: string, scope: string | undefined): string | undefined {
  if (startsWithIgnoringCase(disk, buildPrefix)) {
    return undefined;
  }
  if (scope === undefined) {
    return disk;
  }
  const prefix = `${scope}-`;
  return startsWithIgnoringCase(disk, prefix) && disk.length > prefix.length
    ? disk.slice(prefix.length)
    : undefined;
}

function startsWithIgnoringCase(text: string, prefix: string): boolean {
  return text.slice(0, prefix.length).toLowerCase() === prefix.toLowerCase();
}
