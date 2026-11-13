/**
 * A claim is a file naming the process that holds it and since when: a
 * start's launch lock, a create's building marker. A claim whose process is
 * gone, or that has been held longer than its work can take, is stale, so a
 * process that was killed never blocks an image for good.
 */
import fs from "node:fs";
import type { ImagesContext } from "./context.js";
import { errorCode, isPidAlive, ownedName } from "./store.js";

export interface ClaimHolder {
  pid: number;
  at: string;
}

// A held claim names no holder while its creator has not written it yet.
export type ClaimState =
  | { state: "free" }
  | { state: "held"; holder?: ClaimHolder }
  | { state: "stale"; content: string };

// An exclusive create makes the file empty, and the claim is written into it
// right after: a claim that cannot be read yet is its creator's this long.
const writingMs = 10_000;

/** What this process writes to hold a claim. */
export function claimContent(context: ImagesContext): string {
  return JSON.stringify({ pid: process.pid, at: new Date(context.now()).toISOString() });
}

export function readClaim(context: ImagesContext, file: string, maxAgeMs: number): ClaimState {
  let content: string;
  let writtenAt: number;
  let descriptor: number;
  try {
    descriptor = fs.openSync(file, "r");
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return { state: "free" };
    }
    throw error;
  }
  try {
    content = fs.readFileSync(descriptor, "utf8");
    writtenAt = fs.fstatSync(descriptor).mtimeMs;
  } finally {
    fs.closeSync(descriptor);
  }

  const holder = parseHolder(content);
  if (holder === undefined) {
    return context.now() - writtenAt < writingMs ? { state: "held" } : { state: "stale", content };
  }
  const age = context.now() - Date.parse(holder.at);
  return isPidAlive(holder.pid) && age < maxAgeMs
    ? { state: "held", holder }
    : { state: "stale", content };
}

/**
 * Hold the claim `file` names, taking it over from a holder that is gone.
 * Answers how to release it, or who holds it instead.
 */
export function takeClaim(
  context: ImagesContext,
  file: string,
  maxAgeMs: number,
): { release: () => void } | { heldBy?: ClaimHolder } {
  const content = claimContent(context);
  // Each round either creates the claim, finds it held, or removes a stale
  // one; losing every round to other processes is losing to a live holder.
  for (let round = 0; round < 3; round += 1) {
    try {
      fs.writeFileSync(file, content, { flag: "wx" });
      return { release: () => removeClaim(file, content) };
    } catch (error) {
      if (errorCode(error) !== "EEXIST") {
        throw error;
      }
    }
    const found = readClaim(context, file, maxAgeMs);
    if (found.state === "held") {
      return found.holder === undefined ? {} : { heldBy: found.holder };
    }
    if (found.state === "stale") {
      removeClaim(file, found.content);
    }
  }
  return {};
}

/**
 * Remove the claim if it still says `content`. Two processes can find the
 * same stale claim, and the first to remove it may have made its own by the
 * time the second removes: so the claim is moved aside first, and one that
 * says something else is put back.
 */
export function removeClaim(file: string, content: string): void {
  const aside = ownedName(`${file}-`);
  try {
    fs.renameSync(file, aside);
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return;
    }
    throw error;
  }
  try {
    const moved = fs.readFileSync(aside, "utf8");
    if (moved !== content) {
      try {
        fs.writeFileSync(file, moved, { flag: "wx" });
      } catch (error) {
        // A third process claimed it meanwhile, and holds it now.
        if (errorCode(error) !== "EEXIST") {
          throw error;
        }
      }
    }
  } finally {
    fs.rmSync(aside, { force: true });
  }
}

function parseHolder(content: string): ClaimHolder | undefined {
  try {
    const parsed = JSON.parse(content) as Partial<ClaimHolder>;
    return Number.isInteger(parsed.pid) && typeof parsed.at === "string"
      ? { pid: parsed.pid as number, at: parsed.at }
      : undefined;
  } catch {
    return undefined;
  }
}
