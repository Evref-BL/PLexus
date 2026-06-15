import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  claimPort,
  inspectPortClaim,
  listPortClaims,
  PortClaimConflictError,
  reapStalePortClaims,
  releasePortClaim,
  withPortClaim,
} from "../../src/ports/portClaims.js";
import type { ClaimPortOptions, PortClaimRecord } from "../../src/ports/portClaims.js";

const tempDirs: string[] = [];
const fixedNow = () => new Date("2026-05-17T10:00:00.000Z");

function makeTempDir(prefix: string): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(tempDir);
  return tempDir;
}

function claimOptions(
  claimsRoot: string,
  overrides: Partial<ClaimPortOptions> = {},
): ClaimPortOptions {
  const base: ClaimPortOptions = {
    claimsRoot,
    projectId: "project-123",
    projectName: "My Project",
    workspaceId: "worktree-a",
    targetId: "project-123--worktree-a",
    purpose: "image-mcp",
    now: fixedNow,
  };

  return {
    ...base,
    ...overrides,
  } as ClaimPortOptions;
}

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("host-local port claims", () => {
  it("claims, inspects, and releases a requested port", async () => {
    const claimsRoot = makeTempDir("plexus-port-claims-");

    const claim = await claimPort(
      claimOptions(claimsRoot, {
        claimId: "claim-a",
        requestedPort: 7123,
        pid: 1234,
      }),
    );

    expect(claim).toEqual({
      schemaVersion: 1,
      claimId: "claim-a",
      projectId: "project-123",
      projectName: "My Project",
      workspaceId: "worktree-a",
      targetId: "project-123--worktree-a",
      purpose: "image-mcp",
      requestedPort: 7123,
      assignedPort: 7123,
      pid: 1234,
      claimedAt: "2026-05-17T10:00:00.000Z",
    });
    await expect(
      inspectPortClaim({ claimsRoot, port: 7123 }),
    ).resolves.toMatchObject({
      status: "claimed",
      record: claim,
    });

    await expect(releasePortClaim({ claimsRoot, claim })).resolves.toEqual({
      released: true,
      port: 7123,
    });
    await expect(inspectPortClaim({ claimsRoot, port: 7123 })).resolves.toEqual({
      status: "available",
      port: 7123,
    });
  });

  it("allows only one concurrent owner for the same requested port", async () => {
    const claimsRoot = makeTempDir("plexus-port-claims-");

    const attempts = await Promise.allSettled([
      claimPort(
        claimOptions(claimsRoot, {
          claimId: "claim-a",
          requestedPort: 7124,
        }),
      ),
      claimPort(
        claimOptions(claimsRoot, {
          claimId: "claim-b",
          workspaceId: "worktree-b",
          targetId: "project-123--worktree-b",
          requestedPort: 7124,
        }),
      ),
    ]);

    const successes = attempts.filter(
      (attempt): attempt is PromiseFulfilledResult<PortClaimRecord> =>
        attempt.status === "fulfilled",
    );
    const failures = attempts.filter(
      (attempt): attempt is PromiseRejectedResult =>
        attempt.status === "rejected",
    );

    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);
    expect(failures[0].reason).toBeInstanceOf(PortClaimConflictError);
    await expect(listPortClaims({ claimsRoot })).resolves.toEqual([
      successes[0].value,
    ]);
  });

  it("reaps a stale process owner before a fresh claim", async () => {
    const claimsRoot = makeTempDir("plexus-port-claims-");
    await claimPort(
      claimOptions(claimsRoot, {
        claimId: "stale",
        requestedPort: 7125,
        pid: 2222,
      }),
    );

    const result = await reapStalePortClaims({
      claimsRoot,
      checks: {
        isProcessAlive: async (pid) => pid !== 2222,
        isPortListening: async () => false,
      },
    });

    expect(result.reaped.map((claim) => claim.claimId)).toEqual(["stale"]);
    await expect(
      claimPort(
        claimOptions(claimsRoot, {
          claimId: "fresh",
          requestedPort: 7125,
          pid: 3333,
        }),
      ),
    ).resolves.toMatchObject({
      claimId: "fresh",
      assignedPort: 7125,
    });
  });

  it("does not reap a stale process owner while the host still listens", async () => {
    const claimsRoot = makeTempDir("plexus-port-claims-");
    const claim = await claimPort(
      claimOptions(claimsRoot, {
        claimId: "claimed-but-listening",
        requestedPort: 7126,
        pid: 2222,
      }),
    );

    const result = await reapStalePortClaims({
      claimsRoot,
      checks: {
        isProcessAlive: async () => false,
        isPortListening: async () => true,
      },
    });

    expect(result.reaped).toEqual([]);
    expect(result.kept).toEqual([
      {
        claim,
        reason: "port-listening",
      },
    ]);
    await expect(
      claimPort(
        claimOptions(claimsRoot, {
          claimId: "blocked",
          requestedPort: 7126,
          checks: {
            isProcessAlive: async () => false,
            isPortListening: async () => true,
          },
        }),
      ),
    ).rejects.toBeInstanceOf(PortClaimConflictError);
  });

  it("lists inspection output with project and target metadata sorted by port", async () => {
    const claimsRoot = makeTempDir("plexus-port-claims-");
    const claimB = await claimPort(
      claimOptions(claimsRoot, {
        claimId: "claim-b",
        requestedPort: 7131,
        workspaceId: "worktree-b",
        targetId: "project-123--worktree-b",
        purpose: "gateway",
      }),
    );
    const claimA = await claimPort(
      claimOptions(claimsRoot, {
        claimId: "claim-a",
        requestedPort: 7130,
      }),
    );

    await expect(listPortClaims({ claimsRoot })).resolves.toEqual([
      claimA,
      claimB,
    ]);
    await expect(inspectPortClaim({ claimsRoot, port: 7131 })).resolves.toEqual({
      status: "claimed",
      port: 7131,
      record: {
        ...claimB,
        purpose: "gateway",
        workspaceId: "worktree-b",
        targetId: "project-123--worktree-b",
      },
    });
  });

  it("releases a successful operation claim", async () => {
    const claimsRoot = makeTempDir("plexus-port-claims-");

    const result = await withPortClaim(
      claimOptions(claimsRoot, {
        claimId: "transient",
        requestedPort: 7132,
      }),
      async (claim) => {
        await expect(
          inspectPortClaim({ claimsRoot, port: claim.assignedPort }),
        ).resolves.toMatchObject({
          status: "claimed",
          record: claim,
        });
        return claim.assignedPort;
      },
    );

    expect(result).toBe(7132);
    await expect(inspectPortClaim({ claimsRoot, port: 7132 })).resolves.toEqual({
      status: "available",
      port: 7132,
    });
  });

  it("releases a failed operation claim", async () => {
    const claimsRoot = makeTempDir("plexus-port-claims-");

    await expect(
      withPortClaim(
        claimOptions(claimsRoot, {
          claimId: "transient",
          requestedPort: 7133,
        }),
        async () => {
          throw new Error("operation failed");
        },
      ),
    ).rejects.toThrow("operation failed");
    await expect(inspectPortClaim({ claimsRoot, port: 7133 })).resolves.toEqual({
      status: "available",
      port: 7133,
    });
  });
});
