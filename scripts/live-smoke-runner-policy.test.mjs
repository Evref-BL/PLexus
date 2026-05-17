import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  buildLiveSmokeRunPlan,
  defaultRunId,
  isPathInside,
  parseTimeoutBudget,
} from "./live-smoke-runner-policy.mjs";

const repoRoot = path.resolve("C:/work/PLexus");

function baseOptions(overrides = {}) {
  return {
    approvalProfile: "overnight-live-20260517",
    launcherProfileRoot: "C:/work/launcher-profile",
    artifactRoot: "C:/work/artifacts",
    stateRoot: "C:/work/state",
    projectId: "smoke-open-route-close",
    images: [
      {
        id: "dev",
        copyFromImageName: "MCP12-2",
      },
    ],
    ...overrides,
  };
}

test("requires approval, artifact, and state inputs", () => {
  assert.throws(
    () =>
      buildLiveSmokeRunPlan(
        baseOptions({
          approvalProfile: undefined,
        }),
        { repoRoot },
      ),
    /--approvalProfile is required/,
  );
  assert.throws(
    () =>
      buildLiveSmokeRunPlan(
        baseOptions({
          artifactRoot: undefined,
        }),
        { repoRoot },
      ),
    /--artifactRoot is required/,
  );
  assert.throws(
    () =>
      buildLiveSmokeRunPlan(
        baseOptions({
          stateRoot: undefined,
        }),
        { repoRoot },
      ),
    /--stateRoot is required/,
  );
  assert.throws(
    () =>
      buildLiveSmokeRunPlan(
        baseOptions({
          launcherProfileRoot: undefined,
        }),
        { repoRoot },
      ),
    /--launcherProfileRoot is required/,
  );
});

test("rejects shared PLexus source paths", () => {
  assert.throws(
    () =>
      buildLiveSmokeRunPlan(
        baseOptions({
          stateRoot: path.join(repoRoot, ".plexus"),
        }),
        { repoRoot },
      ),
    /outside the PLexus source checkout/,
  );
});

test("allocates stable run, workspace, target, and artifact ids", () => {
  const plan = buildLiveSmokeRunPlan(baseOptions(), {
    repoRoot,
    now: new Date("2026-05-17T01:23:45.000Z"),
    pid: 1234,
  });

  assert.equal(plan.runId, "smoke-2026-05-17T01-23-45-000Z-1234");
  assert.equal(plan.workspaceId, plan.runId);
  assert.equal(
    plan.targetId,
    `smoke-open-route-close--${plan.workspaceId}`,
  );
  assert.equal(
    plan.artifactDirectory,
    path.join(path.resolve("C:/work/artifacts"), plan.runId),
  );
});

test("enforces configured workspace and target prefixes", () => {
  assert.doesNotThrow(() =>
    buildLiveSmokeRunPlan(
      baseOptions({
        workspaceId: "dogfood-overnight-1",
        targetId: "dogfood-overnight-target-1",
        requiredWorkspacePrefix: "dogfood-overnight",
        requiredTargetPrefix: "dogfood-overnight",
      }),
      { repoRoot },
    ),
  );
  assert.throws(
    () =>
      buildLiveSmokeRunPlan(
        baseOptions({
          workspaceId: "manual-1",
          requiredWorkspacePrefix: "dogfood-overnight",
        }),
        { repoRoot },
      ),
    /--workspaceId must start/,
  );
});

test("rejects a target image that aliases the copy source", () => {
  assert.throws(
    () =>
      buildLiveSmokeRunPlan(
        baseOptions({
          images: [
            {
              id: "dev",
              imageName: "MCP12-2",
              copyFromImageName: "MCP12-2",
            },
          ],
        }),
        { repoRoot },
      ),
    /must differ from copyFromImageName/,
  );
});

test("parses timeout budget overrides", () => {
  assert.equal(parseTimeoutBudget().openMs, 300_000);
  assert.equal(parseTimeoutBudget('{"openMs":1000}').openMs, 1000);
  assert.throws(
    () => parseTimeoutBudget('{"openMs":0}'),
    /openMs must be a positive integer/,
  );
  assert.throws(
    () => parseTimeoutBudget('{"unknownMs":1}'),
    /Unknown timeout budget key/,
  );
});

test("detects nested paths", () => {
  assert.equal(isPathInside("C:/work/root", "C:/work/root/file.txt"), true);
  assert.equal(isPathInside("C:/work/root", "C:/work/other/file.txt"), false);
  assert.match(defaultRunId(new Date("2026-05-17T00:00:00Z"), 1), /^smoke-/);
});
