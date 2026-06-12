import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  gatewayPortClaimPurpose,
  type ProjectGatewayProcessManager,
  type ProjectGatewayProcessStopOptions,
} from "./projectGateway.js";
import {
  imageMcpPortClaimPurpose,
} from "./imagePortClaims.js";
import type { PharoLauncherMcpToolClient } from "./pharoLauncherMcpClient.js";
import { claimPort, inspectPortClaim } from "./portClaims.js";
import { cleanupProjectOwnedResources } from "./projectCleanup.js";
import {
  imageMcpEndpointHandoffPath,
} from "./projectImageMcpEndpoint.js";
import {
  saveProjectState,
  type ProjectImageRepositoryWorkspaceState,
  type ProjectState,
} from "./projectState.js";

const tempDirs: string[] = [];
const fixedNow = () => new Date("2026-04-25T11:00:00.000Z");
const checks = {
  isPortListening: () => false,
  isProcessAlive: () => false,
};
const gitEnv = {
  GIT_AUTHOR_NAME: "PLexus Test",
  GIT_AUTHOR_EMAIL: "plexus-test@example.invalid",
  GIT_COMMITTER_NAME: "PLexus Test",
  GIT_COMMITTER_EMAIL: "plexus-test@example.invalid",
};

interface ToolCall {
  name: string;
  argumentsValue: Record<string, unknown>;
}

class FakePharoLauncherMcpClient implements PharoLauncherMcpToolClient {
  readonly calls: ToolCall[] = [];

  async callTool<T = unknown>(
    name: string,
    argumentsValue: Record<string, unknown> = {},
  ): Promise<T> {
    this.calls.push({ name, argumentsValue });
    return { ok: true } as T;
  }
}

class FakeGatewayProcessManager implements ProjectGatewayProcessManager {
  readonly stops: ProjectGatewayProcessStopOptions[] = [];

  stop(options: ProjectGatewayProcessStopOptions): void {
    this.stops.push(options);
  }
}

function makeTempDir(prefix: string): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(tempDir);
  return tempDir;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    env: {
      ...process.env,
      ...gitEnv,
    },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function writeFile(filePath: string, contents: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents, "utf8");
}

function initRepository(repositoryPath: string): string {
  fs.mkdirSync(repositoryPath, { recursive: true });
  git(repositoryPath, ["init", "--initial-branch=main"]);
  writeFile(path.join(repositoryPath, "src", "BaselineOfMyProject.class.st"), "baseline");
  git(repositoryPath, ["add", "."]);
  git(repositoryPath, ["commit", "-m", "Initial"]);
  return git(repositoryPath, ["rev-parse", "HEAD"]);
}

function writeProjectConfig(
  projectRoot: string,
  imageClaimsRoot: string,
): void {
  fs.writeFileSync(
    path.join(projectRoot, "plexus.project.json"),
    JSON.stringify(
      {
        id: "project-123",
        name: "my-project",
        runtime: {
          gateway: {
            mode: "project-local",
            host: "127.0.0.1",
            port: 8133,
            agentMcpPath: "/mcp",
            routeControlMcpPath: "/control-mcp",
          },
          imagePorts: {
            allocation: "configured-or-dynamic",
            range: {
              start: 7200,
              end: 7209,
            },
            coordination: {
              mode: "host-local",
              root: imageClaimsRoot,
            },
          },
        },
        images: [
          {
            id: "dev",
            imageName: "MyProject-dev",
            active: true,
            mcp: {
              port: 7200,
              loadScript: "pharo/load-mcp.st",
            },
            create: {
              kind: "template",
              templateName: "Pharo 13",
            },
          },
          {
            id: "baseline",
            imageName: "MyProject-baseline",
            active: false,
            mcp: {
              port: 7201,
              loadScript: "pharo/load-mcp.st",
            },
          },
        ],
      },
      null,
      2,
    ),
    "utf8",
  );
}

function statePath(stateRoot: string): string {
  return path.join(
    stateRoot,
    "projects",
    "project-123",
    "workspaces",
    "worktree-a",
    "state.json",
  );
}

function repositoryWorkspace(
  repositoryPath: string,
): ProjectImageRepositoryWorkspaceState {
  return {
    repository: {
      id: "my-project",
      originPath: repositoryPath,
    },
    path: repositoryPath,
    materializationStrategy: "copy",
    sourceDirectory: "src",
    baseline: "MyProject",
    materializationState: "ready",
    diagnostics: [],
    dirtyState: "clean",
    loadState: "not-loaded",
  };
}

function ownedCreationState() {
  return {
    source: {
      kind: "template" as const,
      templateName: "Pharo 13",
    },
    cleanupPolicy: "workspace_cleanup_only" as const,
    route: {
      serverName: "pharo_gateway" as const,
      targetKey: "targetId" as const,
      imageArgument: "imageId" as const,
      imageId: "dev",
    },
  };
}

async function writeClaimFixtures(input: {
  imageClaimsRoot: string;
  gatewayClaimsRoot: string;
}): Promise<void> {
  await claimPort({
    claimsRoot: input.imageClaimsRoot,
    requestedPort: 7200,
    claimId: "image-claim",
    projectId: "project-123",
    projectName: "my-project",
    workspaceId: "worktree-a",
    targetId: "project-123--worktree-a",
    purpose: imageMcpPortClaimPurpose,
    imageId: "dev",
    checks,
    now: fixedNow,
  });
  await claimPort({
    claimsRoot: input.gatewayClaimsRoot,
    requestedPort: 8133,
    claimId: "gateway-claim",
    projectId: "project-123",
    projectName: "my-project",
    workspaceId: "worktree-a",
    targetId: "project-123--worktree-a",
    purpose: gatewayPortClaimPurpose,
    checks,
    now: fixedNow,
  });
}

function writeRuntimeState(input: {
  projectRoot: string;
  stateRoot: string;
  repositoryPath: string;
  gatewayClaimsRoot: string;
  devStatus?: "running" | "stopped";
}): ProjectState {
  const state: ProjectState = {
    projectId: "project-123",
    projectName: "my-project",
    workspaceId: "worktree-a",
    targetId: "project-123--worktree-a",
    updatedAt: "2026-04-25T10:00:00.000Z",
    runtimeStatus: input.devStatus === "stopped" ? "idle" : "running",
    gateway: {
      mode: "project-local",
      endpoint: "http://127.0.0.1:8133/mcp",
      controlEndpoint: "http://127.0.0.1:8133/control-mcp",
      host: "127.0.0.1",
      port: 8133,
      routePath: "/mcp",
      controlPath: "/control-mcp",
      owningProjectId: "project-123",
      managedByProject: true,
      pid: 9876,
      claim: {
        claimsRoot: input.gatewayClaimsRoot,
        claimId: "gateway-claim",
        assignedPort: 8133,
      },
    },
    images: [
      {
        id: "dev",
        imageName: "MyProject-dev",
        assignedPort: 7200,
        pid: input.devStatus === "stopped" ? undefined : 1234,
        status: input.devStatus ?? "running",
        mcpEndpoint: {
          transport: "http",
          host: "127.0.0.1",
          port: 7200,
          path: "/",
        },
        creation: ownedCreationState(),
        repositoryWorkspace: repositoryWorkspace(input.repositoryPath),
      },
      {
        id: "baseline",
        imageName: "MyProject-baseline",
        assignedPort: 7201,
        status: "stopped",
      },
    ],
  };
  saveProjectState(statePath(input.stateRoot), state);

  const handoffPath = imageMcpEndpointHandoffPath({
    projectRoot: input.projectRoot,
    projectId: "project-123",
    workspaceId: "worktree-a",
    stateRoot: input.stateRoot,
    imageId: "dev",
  });
  writeFile(
    handoffPath,
    "transport=http\nhost=127.0.0.1\nport=7200\npath=/\n",
  );

  return state;
}

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("project cleanup", () => {
  it("audits PLexus-owned leftovers without mutating them", async () => {
    const projectRoot = makeTempDir("plexus-project-");
    const stateRoot = makeTempDir("plexus-state-");
    const imageClaimsRoot = makeTempDir("plexus-image-claims-");
    const gatewayClaimsRoot = makeTempDir("plexus-gateway-claims-");
    const repositoryPath = makeTempDir("plexus-repository-");
    initRepository(repositoryPath);
    writeProjectConfig(projectRoot, imageClaimsRoot);
    await writeClaimFixtures({ imageClaimsRoot, gatewayClaimsRoot });
    writeRuntimeState({
      projectRoot,
      stateRoot,
      repositoryPath,
      gatewayClaimsRoot,
    });

    const result = await cleanupProjectOwnedResources({
      projectRoot,
      stateRoot,
      workspaceId: "worktree-a",
      confirm: false,
      portClaimChecks: checks,
      gateway: {
        checks,
      },
    });

    expect(result.ok).toBe(true);
    expect(result.confirmed).toBe(false);
    expect(result.resources.map((resource) => resource.kind)).toEqual(
      expect.arrayContaining([
        "state-file",
        "image-process",
        "launcher-image",
        "image-port-claim",
        "endpoint-handoff",
        "gateway",
        "gateway-port-claim",
        "repository-workspace",
      ]),
    );
    expect(result.resources.every((resource) => resource.status === "planned"))
      .toBe(true);
    await expect(
      inspectPortClaim({ claimsRoot: imageClaimsRoot, port: 7200, checks }),
    ).resolves.toMatchObject({ status: "claimed" });
    await expect(
      inspectPortClaim({ claimsRoot: gatewayClaimsRoot, port: 8133, checks }),
    ).resolves.toMatchObject({ status: "claimed" });
    expect(fs.existsSync(statePath(stateRoot))).toBe(true);
  }, 15_000);

  it("cleans confirmed PLexus-owned leftovers and preserves unowned launcher images", async () => {
    const projectRoot = makeTempDir("plexus-project-");
    const stateRoot = makeTempDir("plexus-state-");
    const imageClaimsRoot = makeTempDir("plexus-image-claims-");
    const gatewayClaimsRoot = makeTempDir("plexus-gateway-claims-");
    const repositoryPath = makeTempDir("plexus-repository-");
    initRepository(repositoryPath);
    writeProjectConfig(projectRoot, imageClaimsRoot);
    await writeClaimFixtures({ imageClaimsRoot, gatewayClaimsRoot });
    writeRuntimeState({
      projectRoot,
      stateRoot,
      repositoryPath,
      gatewayClaimsRoot,
    });
    const launcherClient = new FakePharoLauncherMcpClient();
    const gatewayProcessManager = new FakeGatewayProcessManager();

    const result = await cleanupProjectOwnedResources({
      projectRoot,
      stateRoot,
      workspaceId: "worktree-a",
      confirm: true,
      deleteStateFile: true,
      repositoryWorkspaceCleanupPolicy: "delete-disposable",
      pharoLauncherMcpClient: launcherClient,
      portClaimChecks: checks,
      gateway: {
        checks,
        processManager: gatewayProcessManager,
      },
      now: fixedNow,
    });

    expect(result.ok).toBe(true);
    expect(result.confirmed).toBe(true);
    expect(launcherClient.calls).toEqual([
      {
        name: "pharo_launcher_process_kill",
        argumentsValue: {
          imageName: "MyProject-dev",
          confirm: true,
        },
      },
      {
        name: "pharo_launcher_image_delete",
        argumentsValue: {
          imageName: "MyProject-dev",
          force: true,
          confirm: true,
        },
      },
    ]);
    expect(
      launcherClient.calls.some(
        (call) =>
          call.name === "pharo_launcher_image_delete" &&
          call.argumentsValue.imageName === "MyProject-baseline",
      ),
    ).toBe(false);
    expect(gatewayProcessManager.stops).toHaveLength(1);
    await expect(
      inspectPortClaim({ claimsRoot: imageClaimsRoot, port: 7200, checks }),
    ).resolves.toMatchObject({ status: "available" });
    await expect(
      inspectPortClaim({ claimsRoot: gatewayClaimsRoot, port: 8133, checks }),
    ).resolves.toMatchObject({ status: "available" });
    expect(fs.existsSync(repositoryPath)).toBe(false);
    expect(fs.existsSync(statePath(stateRoot))).toBe(false);
    expect(result.resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "launcher-image",
          imageId: "dev",
          status: "cleaned",
        }),
        expect.objectContaining({
          kind: "state-file",
          status: "cleaned",
        }),
      ]),
    );
  });
});
