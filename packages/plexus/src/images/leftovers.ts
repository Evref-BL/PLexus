import fs from "node:fs";
import path from "node:path";
import { storeRoot, tmpRoot } from "../home.js";
import { buildPrefix } from "./names.js";
import { isPidAlive, ownerOf, removeDirectory } from "./store.js";

/**
 * Remove what a PLexus that was killed left: builds in the store, which no
 * list shows and which weigh gigabytes, and what it was assembling or
 * removing in tmp. Each is named after the process that made it, so what
 * belongs to a process that is gone goes, and a running one keeps its own.
 * Nothing here fails the caller: what cannot go now is tried again next time.
 */
export function removeLeftovers(home: string): void {
  removeOrphans(storeRoot(home), (entry) => entry.startsWith(buildPrefix), (dir) =>
    removeDirectory(home, dir),
  );
  removeOrphans(tmpRoot(home), () => true, (entry) =>
    fs.rmSync(entry, { recursive: true, force: true }),
  );
}

function removeOrphans(
  root: string,
  candidate: (entry: string) => boolean,
  remove: (entry: string) => void,
): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(root);
  } catch {
    return;
  }
  for (const entry of entries) {
    const owner = ownerOf(entry);
    if (!candidate(entry) || owner === undefined || isPidAlive(owner)) {
      continue;
    }
    try {
      remove(path.join(root, entry));
    } catch {
      // A file held open, as Windows keeps them: the next create tries again.
    }
  }
}
