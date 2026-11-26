import path from "node:path";
import { profileRoot } from "../home.js";

/**
 * PLexus's one launcher profile.
 *
 * One profile, so the launcher image, the VMs and the templates, which are
 * large and the same for every image, exist once per home.
 */
export function homeProfile(home: string): { stateRoot: string; name: string } {
  return { stateRoot: profileRoot(home), name: "plexus" };
}

/** Where the profile keeps its template sources list. */
export function homeTemplateSources(home: string): string {
  return path.join(profileRoot(home), "templates", "sources.list");
}
