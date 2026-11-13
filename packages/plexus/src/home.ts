import os from "node:os";
import path from "node:path";

/** Where PLexus keeps everything: `$PLEXUS_HOME`, or `~/.plexus`. */
export function plexusHome(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.PLEXUS_HOME;
  return configured
    ? path.resolve(configured)
    : path.join(os.homedir(), ".plexus");
}

/** The one Pharo Launcher profile: its images, VMs and templates. */
export function profileRoot(home: string): string {
  return path.join(home, "profiles");
}

/** The images: one directory each, named after the image. */
export function storeRoot(home: string): string {
  return path.join(profileRoot(home), "images");
}

/** Templates with MCP loaded, copied by a create. */
export function basesRoot(home: string): string {
  return path.join(home, "bases");
}

/**
 * Where a directory is assembled before it is renamed into place, and where
 * one goes to be removed. It sits beside the store so that both moves are
 * renames on one filesystem.
 */
export function tmpRoot(home: string): string {
  return path.join(home, "tmp");
}
