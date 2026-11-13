import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readClaim, removeClaim, takeClaim } from "../../src/images/claims.js";
import { FakeLauncher, tempHome, testContext } from "../support/fakeLauncher.js";

function setup() {
  const home = tempHome();
  const context = testContext(home, new FakeLauncher(home));
  return { home, context, file: path.join(home, "launch.lock") };
}

describe("a claim", () => {
  it("is held by one taker at a time, and released by it", () => {
    const { home, context, file } = setup();
    const first = takeClaim(context, file, 60_000);
    expect("release" in first).toBe(true);
    expect(takeClaim(context, file, 60_000)).toEqual({
      heldBy: { pid: process.pid, at: new Date(context.now()).toISOString() },
    });

    (first as { release: () => void }).release();
    expect(readClaim(context, file, 60_000)).toEqual({ state: "free" });
    expect(fs.readdirSync(home)).toEqual([]);
  });

  it("is not removed by a release once another process holds it", () => {
    const { context, file } = setup();
    const taken = takeClaim(context, file, 60_000) as { release: () => void };
    const theirs = JSON.stringify({ pid: process.pid, at: "2026-11-13T12:00:01.000Z" });
    fs.writeFileSync(file, theirs);

    taken.release();
    expect(fs.readFileSync(file, "utf8")).toBe(theirs);
  });

  it("puts back a claim made in place of the stale one it removes", () => {
    const { home, context, file } = setup();
    const stale = JSON.stringify({ pid: 2_147_483_646, at: "2026-11-13T12:00:00.000Z" });
    const fresh = JSON.stringify({ pid: process.pid, at: "2026-11-13T12:00:00.000Z" });
    fs.writeFileSync(file, fresh);

    removeClaim(file, stale);
    expect(fs.readFileSync(file, "utf8")).toBe(fresh);
    expect(fs.readdirSync(home)).toEqual(["launch.lock"]);

    removeClaim(file, fresh);
    expect(fs.readdirSync(home)).toEqual([]);
  });
});
