import { PlexusError } from "../errors.js";

const namePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

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

export function checkScope(scope: unknown): string | undefined {
  return scope === undefined || scope === "" ? undefined : check(scope, "Scope");
}

/** The directory and file base name of an image in the store. */
export function diskName(name: unknown, scope: string | undefined): string {
  const checked = check(name, "Image name");
  const disk = scope === undefined ? checked : `${scope}-${checked}`;
  if (disk.startsWith(buildPrefix)) {
    throw new PlexusError(
      "invalid-name",
      `Image name ${JSON.stringify(checked)} is not valid: ${buildPrefix} names the bases PLexus builds.`,
    );
  }
  return disk;
}

/**
 * The name a directory of the store answers to in this scope, or nothing
 * when it is out of scope or is not an image's.
 */
export function nameOfDisk(disk: string, scope: string | undefined): string | undefined {
  if (disk.startsWith(buildPrefix)) {
    return undefined;
  }
  if (scope === undefined) {
    return disk;
  }
  const prefix = `${scope}-`;
  return disk.startsWith(prefix) && disk.length > prefix.length
    ? disk.slice(prefix.length)
    : undefined;
}
