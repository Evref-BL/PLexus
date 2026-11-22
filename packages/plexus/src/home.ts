import os from "node:os";
import path from "node:path";

/** Where the `plexus` command keeps everything: `$PLEXUS_HOME`, or `~/.plexus`. */
export function plexusHome(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.PLEXUS_HOME;
  return configured ? path.resolve(configured) : defaultHome();
}

/** Where an `Images` given no home keeps everything. */
export function defaultHome(): string {
  return path.join(os.homedir(), ".plexus");
}

/** The one Pharo Launcher profile: its images, VMs and templates. */
export function profileRoot(home: string): string {
  return path.join(home, "profiles");
}

/** The images: one directory each, named after the image. */
export function storeRoot(home: string): string {
  return path.join(profileRoot(home), "images");
}

/**
 * Templates with MCP loaded, copied by a create, which every PLexus release
 * sharing the home keeps until none has used them for a while. PLexus 0.16
 * to 0.20 keep theirs in `<home>/bases` itself, and each removes every entry
 * there named after a pin other than its own, which `shared` is not.
 */
export function basesRoot(home: string): string {
  return path.join(home, "bases", "shared");
}

/**
 * Where a directory is assembled before it is renamed into place, and where
 * one goes to be removed. It sits beside the store so that both moves are
 * renames on one filesystem.
 */
export function tmpRoot(home: string): string {
  return path.join(home, "tmp");
}
