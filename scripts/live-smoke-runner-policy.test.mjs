import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertKeepOpenShowcaseBoundary,
  assertSmokeLoadScriptsReady,
  buildKeepOpenCleanupContext,
  collectLauncherLogFiles,
  defaultSmokeImageSpec,
  assertPharoLauncherMcpDiscoveryMetadata,
  assertFreshPharoLauncherMcpHealth,
  buildLiveSmokeRunPlan,
  defaultRunId,
  formatToolFailure,
  isPathInside,
  mcpPharoTonelLoadScriptSource,
  parseTimeoutBudget,
  smokeProjectConfig,
  usesDefaultSmokeLoadScript,
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

test("defaults launcher profile to the project-owned root used by project-open", () => {
  const plan = buildLiveSmokeRunPlan(
    baseOptions({
      launcherProfile: undefined,
      launcherProfileRoot: undefined,
      projectId: "Project A",
    }),
    { repoRoot },
  );
  const profileRoot = path.join(
    path.resolve("C:/work/state"),
    "profiles",
    "pharo-launcher-mcp",
    "Project-A",
  );

  assert.equal(plan.launcherProfile, "plexus-Project-A");
  assert.equal(plan.launcherProfileRoot, profileRoot);
  assert.equal(
    plan.launcherProfileEnvironment.PHARO_LAUNCHER_MCP_LAUNCHER_IMAGE,
    path.join(profileRoot, "launcher", "PharoLauncher.image"),
  );
  assert.equal(
    plan.launcherProfileEnvironment.PHARO_LAUNCHER_MCP_LAUNCHER_CONFIGURATION,
    path.join(profileRoot, "launcher", "pharo-launcher-cli-config.ston"),
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

test("rejects missing smoke MCP load scripts before image startup", () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "plexus-smoke-project-"));
  try {
    assert.throws(
      () =>
        assertSmokeLoadScriptsReady({
          projectRoot,
          images: [
            {
              id: "dev",
              loadScript: "pharo/missing-load-mcp.st",
            },
          ],
        }),
      /MCP load script does not exist before image startup/,
    );
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("requires explicit project root or absolute path for relative smoke MCP load scripts", () => {
  assert.throws(
    () =>
      assertSmokeLoadScriptsReady({
        images: [
          {
            id: "dev",
            loadScript: "pharo/load-mcp.st",
          },
        ],
      }),
    /loadScript is relative .* --projectRoot is not set/,
  );
});

test("allows explicit remote MCP fallback while recording missing load scripts", () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "plexus-smoke-project-"));
  try {
    const checked = assertSmokeLoadScriptsReady({
      projectRoot,
      allowRemoteMcpFallback: true,
      images: [
        {
          id: "dev",
          loadScript: "pharo/missing-load-mcp.st",
        },
      ],
    });

    assert.equal(checked[0].exists, false);
    assert.equal(
      checked[0].resolvedPath,
      path.join(projectRoot, "pharo", "missing-load-mcp.st"),
    );
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("records Git transport for explicit remote MCP fallback", () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "plexus-smoke-project-"));
  try {
    const checked = assertSmokeLoadScriptsReady({
      projectRoot,
      allowRemoteMcpFallback: true,
      images: [
        {
          id: "dev",
          loadScript: "pharo/missing-load-mcp.st",
          git: {
            transport: "https",
          },
        },
      ],
    });

    assert.equal(checked[0].exists, false);
    assert.equal(checked[0].gitTransport, "https");
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("renders image Git transport into smoke project config", () => {
  const config = smokeProjectConfig({
    projectId: "smoke-transport",
    images: [
      {
        id: "dev",
        imageName: "PlexusSmokeDev",
        active: true,
        loadScript: "/tmp/load-mcp.st",
        git: {
          transport: "ssh",
          ssh: {
            username: "git",
            host: "ssh.github.com",
            port: 443,
          },
        },
      },
    ],
  });

  assert.deepEqual(config.images[0].git, {
    transport: "ssh",
    ssh: {
      username: "git",
      host: "ssh.github.com",
      port: 443,
    },
  });
});

test("renders home cache project config for template-created smoke images", () => {
  const config = smokeProjectConfig({
    projectId: "home-cache-smoke",
    homePath: "/tmp/plexus-home-cache-smoke/home",
    images: [
      {
        id: "dev",
        imageName: "PlexusHomeCacheSmoke-{workspaceId}-dev",
        active: true,
        create: {
          kind: "template",
          templateName: "Pharo 13.0 - 64bit",
          templateCategory: "Official",
        },
        loadScript: "/tmp/load-mcp.st",
        git: {
          transport: "https",
        },
      },
    ],
  });

  assert.deepEqual(config.home, {
    path: path.resolve("/tmp/plexus-home-cache-smoke/home"),
    imageCache: {
      enabled: true,
    },
  });
  assert.deepEqual(config.images[0].create, {
    kind: "template",
    templateName: "Pharo 13.0 - 64bit",
    templateCategory: "Official",
  });
  assert.equal(config.images[0].git.transport, "https");
});

test("renders local MCP-Pharo Tonel load script source", () => {
  const source = mcpPharoTonelLoadScriptSource("/tmp/mcp-pharo");
  const expectedRepository = `tonel://${path
    .resolve("/tmp/mcp-pharo", "src")
    .replaceAll("\\", "/")}`;

  assert.match(source, new RegExp(`repository: '${expectedRepository}'`));
  assert.match(source, /load: 'Core'\./);
});

test("only replaces implicit smoke load scripts with generated local MCP-Pharo loader", () => {
  assert.equal(
    usesDefaultSmokeLoadScript({
      imageLoadScriptExplicit: false,
      loadScriptExplicit: false,
    }),
    true,
  );
  assert.equal(
    usesDefaultSmokeLoadScript({
      imageLoadScriptExplicit: false,
      loadScriptExplicit: true,
    }),
    false,
  );
  assert.equal(
    usesDefaultSmokeLoadScript({
      imageLoadScriptExplicit: true,
      loadScriptExplicit: false,
    }),
    false,
  );
});

test("default one-image smoke spec preserves implicit load script defaults", () => {
  assert.deepEqual(
    defaultSmokeImageSpec({
      imageId: "dev",
      loadScript: "/repo/pharo/load-mcp.st",
      loadScriptExplicit: false,
    }),
    {
      id: "dev",
      imageName: undefined,
      copyFromImageName: undefined,
      port: undefined,
      active: true,
    },
  );

  assert.deepEqual(
    defaultSmokeImageSpec({
      imageId: "dev",
      loadScript: "/tmp/custom-load.st",
      loadScriptExplicit: true,
    }),
    {
      id: "dev",
      imageName: undefined,
      copyFromImageName: undefined,
      port: undefined,
      loadScript: "/tmp/custom-load.st",
      active: true,
    },
  );
});

test("keep-open showcase mode requires project-owned disposable image state", () => {
  assert.doesNotThrow(() =>
    assertKeepOpenShowcaseBoundary({
      keepOpen: true,
      stateRoot: "C:/work/state",
      launcherProfileRoot: "C:/work/state/profiles/pharo-launcher-mcp/showcase",
      images: [
        {
          id: "dev",
          copyFromImageName: "MCP12-2",
        },
      ],
    }),
  );

  assert.throws(
    () =>
      assertKeepOpenShowcaseBoundary({
        keepOpen: true,
        stateRoot: "C:/work/state",
        launcherProfileRoot: "C:/shared/pharo-launcher",
        images: [
          {
            id: "dev",
            copyFromImageName: "MCP12-2",
          },
        ],
      }),
    /--launcherProfileRoot must be inside --stateRoot for keep-open mode/,
  );

  assert.throws(
    () =>
      assertKeepOpenShowcaseBoundary({
        keepOpen: true,
        createSourceFromTemplate: false,
        stateRoot: "C:/work/state",
        launcherProfileRoot: "C:/work/state/profiles/pharo-launcher-mcp/showcase",
        images: [
          {
            id: "dev",
            imageName: "SharedMCPImage",
          },
        ],
      }),
    /requires copied or template-created disposable images/,
  );
});

test("keep-open cleanup context records scoped close and status commands", () => {
  const context = buildKeepOpenCleanupContext({
    projectPaths: {
      projectRoot: "C:/work/showcase/project",
      stateRoot: "C:/work/showcase/state",
      fixtureRoot: "C:/work/showcase/fixtures",
    },
    options: {
      artifactDirectory: "C:/work/showcase/artifacts/smoke-1",
      artifactEventsPath: "C:/work/showcase/artifacts/smoke-1/events.jsonl",
      launcherProfileRoot: "C:/work/showcase/state/profiles/pharo-launcher-mcp/showcase",
      launcherProfile: "plexus-showcase",
      launcherProfileEnvironment: {
        PHARO_LAUNCHER_MCP_PROFILE: "plexus-showcase",
      },
      workspaceId: "showcase-1",
      targetId: "showcase-target-1",
      createdSourceImageName: "PlexusSmokeSource",
      images: [
        {
          id: "dev",
          imageName: "PlexusSmokedev",
          copied: true,
        },
      ],
    },
    openData: {
      statePath: "C:/work/showcase/state/projects/showcase/workspaces/showcase-1/state.json",
      state: {
        projectId: "showcase",
        workspaceId: "showcase-1",
        targetId: "showcase-target-1",
        gateway: {
          endpoint: "http://127.0.0.1:8133/mcp",
          controlEndpoint: "http://127.0.0.1:8133/control-mcp",
        },
        images: [
          {
            id: "dev",
            imageName: "PlexusSmokedev",
            assignedPort: 7100,
            pid: 12345,
            status: "running",
          },
        ],
      },
    },
  });

  assert.deepEqual(context.closeCommand, [
    "plexus",
    "project",
    "close",
    "C:/work/showcase/project",
    "--workspace-id",
    "showcase-1",
    "--state-root",
    "C:/work/showcase/state",
  ]);
  assert.deepEqual(context.statusCommand, [
    "plexus",
    "project",
    "status",
    "C:/work/showcase/project",
    "--workspace-id",
    "showcase-1",
    "--state-root",
    "C:/work/showcase/state",
  ]);
  assert.deepEqual(context.mcpCloseCall.arguments, {
    projectPath: "C:/work/showcase/project",
    stateRoot: "C:/work/showcase/state",
    workspaceId: "showcase-1",
  });
  assert.equal(
    context.routeControl.targetId,
    "showcase-target-1",
  );
  assert.deepEqual(context.launcherCleanup.deleteImageToolCalls, [
    {
      tool: "pharo_launcher_image_delete",
      arguments: {
        imageName: "PlexusSmokedev",
        force: true,
        confirm: true,
      },
    },
    {
      tool: "pharo_launcher_image_delete",
      arguments: {
        imageName: "PlexusSmokeSource",
        force: true,
        confirm: true,
      },
    },
  ]);
  assert.equal(
    context.launcherCleanup.environment.PHARO_LAUNCHER_MCP_PROFILE,
    "plexus-showcase",
  );
  assert.equal(context.retained.artifactDirectory, "C:/work/showcase/artifacts/smoke-1");
  assert.equal(context.retained.createdSourceImageName, "PlexusSmokeSource");
  assert.equal(context.retained.images[0].pid, 12345);
});

test("formats project-open diagnostics and launcher logs for smoke failures", () => {
  const message = formatToolFailure(
    "plexus_project_open",
    {
      ok: false,
      error: "One or more project images failed to open",
      diagnostics: {
        projectOpen: {
          failures: [
            {
              imageId: "dev",
              imageName: "PlexusSmokedev",
              message: "Timed out waiting for Pharo MCP health on port 7100",
            },
          ],
        },
      },
    },
    {
      launcherLogFiles: ["/tmp/logs/2026-PlexusSmokedev-launch.err.log"],
    },
  );

  assert.match(message, /project open failures:/);
  assert.match(message, /dev\/PlexusSmokedev: Timed out/);
  assert.match(message, /2026-PlexusSmokedev-launch.err.log/);
});

test("collects launcher logs for failed smoke images", () => {
  const logsDir = fs.mkdtempSync(path.join(os.tmpdir(), "plexus-smoke-logs-"));
  try {
    const expected = path.join(logsDir, "2026-PlexusSmokedev-launch.err.log");
    fs.writeFileSync(expected, "failure\n", "utf8");
    fs.writeFileSync(
      path.join(logsDir, "2026-OtherImage-launch.err.log"),
      "other\n",
      "utf8",
    );

    assert.deepEqual(
      collectLauncherLogFiles({
        logsDir,
        imageNames: ["PlexusSmokedev"],
      }),
      [expected],
    );
  } finally {
    fs.rmSync(logsDir, { recursive: true, force: true });
  }
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

test("accepts fresh pharo-launcher-mcp health with discovery metadata", () => {
  const preflight = assertFreshPharoLauncherMcpHealth(
    {
      ok: true,
      health: {
        ok: true,
        config: {
          discovery: {
            source: "macos-system-app",
          },
        },
      },
    },
    { source: "env", repoDir: "C:/work/pharo-launcher-mcp" },
  );

  assert.equal(preflight.discoverySource, "macos-system-app");
});

test("accepts discovery metadata before profile launcher image staging", () => {
  const preflight = assertPharoLauncherMcpDiscoveryMetadata(
    {
      ok: true,
      health: {
        ok: false,
        config: {
          discovery: {
            source: "macos-system-app",
          },
          launcherImage: {
            path: "C:/work/state/profiles/pharo-launcher-mcp/project/launcher/PharoLauncher.image",
            exists: false,
          },
        },
      },
    },
    { source: "env", repoDir: "C:/work/pharo-launcher-mcp" },
  );

  assert.equal(preflight.discoverySource, "macos-system-app");
});

test("rejects unhealthy pharo-launcher-mcp preflight before image mutation", () => {
  assert.throws(
    () =>
      assertFreshPharoLauncherMcpHealth(
        {
          ok: true,
          health: {
            ok: false,
            config: {},
          },
        },
        { source: "package", packageDir: "C:/work/plexus/node_modules/pharo" },
      ),
    /preflight failed before image mutation/,
  );
});

test("rejects pharo-launcher-mcp runtimes without discovery metadata", () => {
  assert.throws(
    () =>
      assertFreshPharoLauncherMcpHealth(
        {
          ok: true,
          health: {
            ok: true,
            config: {
              launcherDir: { path: "C:/PharoLauncher", exists: true },
            },
          },
        },
        { source: "package", packageDir: "C:/work/plexus/node_modules/pharo" },
      ),
    /does not report launcher discovery metadata/,
  );
});

test("detects nested paths", () => {
  assert.equal(isPathInside("C:/work/root", "C:/work/root/file.txt"), true);
  assert.equal(isPathInside("C:/work/root", "C:/work/other/file.txt"), false);
  assert.match(defaultRunId(new Date("2026-05-17T00:00:00Z"), 1), /^smoke-/);
});
