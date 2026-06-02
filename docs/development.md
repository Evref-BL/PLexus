# Development Guide

This document is for PLexus contributors. The README is the user-facing guide.

## Repository Layout

```text
packages/
  plexus-core/            Project config, lifecycle orchestration, state, CLI
  plexus-gateway/         MCP routing gateway and per-image forwarding
pharo/
  worker/                 In-image worker bootstrap notes/scripts
docs/
  architecture.md
  user/
    getting-started.md
    runtime-model.md
    agent-pharo-access.md
  reference/
    mcp.md
  troubleshooting.md
  package-boundaries.md
  project-model.md
  vibe-kanban-setup.md
  roadmap.md
scripts/
  verify-environment.ps1
```

## Package Boundaries

The intended split is:

- `@evref-bl/plexus-core` / CLI owns project config, workspace and image lifecycle,
  runtime state, port allocation, startup script generation, health checks,
  lifecycle MCP tools, route registration through the gateway route-control
  API, image rescue, and the scoped `pharo-launcher` facade.
- `@evref-bl/plexus-gateway` owns route registration, route status, and forwarding
  project Pharo MCP calls to image-scoped MCP servers.
- `@evref-bl/pharo-launcher-mcp` owns raw PharoLauncher CLI integration.

See `docs/package-boundaries.md` for the full contract.

## Build And Test

```sh
npm install
npm run build
npm run typecheck --workspaces
npm test
```

Verify the local machine:

```powershell
.\scripts\verify-environment.ps1
```

The verification script is a Windows PowerShell convenience check. Keep
executable PLexus logic OS-agnostic; put unavoidable platform behavior behind
small, named helpers or clearly labeled scripts.

Static portability checks do not require Pharo images, live PLexus routes,
process startup, or Docker:

```sh
npm run test -w @evref-bl/plexus-core -- workspaceMcpConfig projectState projectStartupScript config
npm run typecheck -w @evref-bl/plexus-core
```

Optional Linux verification through Docker is non-default. Run it only in an
approved isolated runner with an explicit cleanup plan; it should perform static
checks such as typecheck and tests, not live image startup.

## MCP Surface Boundaries

Use the clean MCP surfaces when adding docs, generated config, or examples:

- `plexus_project` for PLexus project lifecycle.
- `pharo-launcher` for scoped image lifecycle within one PLexus target.
- `pharo_gateway` for agent-facing Pharo code tools routed by explicit `imageId`.
- `route-control` or `gateway-control` for trusted route registration, route
  status, and cleanup.

Use route-control terminology for private/trusted gateway controls. In HTTP
service mode, the normal shape is one `plexus-gateway` process with `/mcp`
serving the agent-facing `pharo_gateway` server and `/control-mcp` serving
route-control. Both paths share the same in-memory route table.
Generated workspace MCP config writes `pharo_gateway` for the agent-facing Pharo MCP
proxy and keeps route-control separate.

## pharo-launcher-mcp Resolution

By default, PLexus resolves the installed `@evref-bl/pharo-launcher-mcp`
package and starts it with the current Node executable.

Use environment variables only when testing an unpackaged checkout:

```sh
PHARO_LAUNCHER_MCP_COMMAND=node
PHARO_LAUNCHER_MCP_ENTRY=/path/to/pharo-launcher-mcp/dist/index.js
```

Windows PowerShell example:

```powershell
$env:PHARO_LAUNCHER_MCP_COMMAND = "node"
$env:PHARO_LAUNCHER_MCP_ENTRY = "C:\work\src\pharo-launcher-mcp\dist\index.js"
```

PLexus-generated runtime paths and agent MCP config preserve the caller's native
path style. Windows paths remain `C:\...`; POSIX paths remain `/...`.

## Runtime State

PLexus stores runtime state outside Pharo images:

```text
<state-root>/projects/<project-id>/workspaces/<workspace-id>/state.json
```

Use one shared `PLEXUS_STATE_ROOT` across parallel agent worktrees so
PLexus can reserve ports across sibling workspaces.

The default `workspaceId` is the project root directory name. Callers can
override it with `--workspace-id`, `PLEXUS_WORKSPACE_ID`, or
`VIBE_KANBAN_WORKSPACE_ID`. The default `targetId` is
`<project-id>--<workspace-id>`.

Image status values are `starting`, `running`, `stopped`, or `failed`.

## Startup Scripts

Before launching an image, PLexus writes a Smalltalk startup script into runtime
state:

```text
<state-root>/projects/<project-id>/workspaces/<workspace-id>/scripts/start-<image-id>.st
```

The script configures image-local Iceberg Git transport, loads Pharo MCP
according to `mcp.loadPolicy`, starts MCP on the assigned runtime port, and
registers the server in `Smalltalk globals` as `#PLexusMCPServer`. The default
load policy is `ifMissing`: use MCP already present in the image, otherwise load
`mcp.loadScript` or fall back to the configured default Pharo MCP Metacello
repository. Use `always` to force the configured source to replace preloaded MCP
code, or `never` to skip configured preloading and require a provided MCP. When
the policy is `never`, `mcp.loadScript` may be omitted.

Prepared image caches use a separate generated script:

```text
<state-root>/projects/<project-id>/prepared-images/prepare-<cache-id>.st
```

That script loads the configured MCP repository into the cache image and saves
the image. Generating the script is source-only. Creating the cache image,
copying it into a workspace runtime image, and deleting it remain live launcher
mutations and require an approved runner.

Home image cache planning uses `PLEXUS_HOME` when set, otherwise `~/.plexus`.
The home cache stores manifests, preparation scripts, and lock directories under
`<PLEXUS_HOME>/image-cache`, while home cache base images live in a separate
explicit pharo-launcher-mcp profile under
`<PLEXUS_HOME>/profiles/pharo-launcher-mcp/image-cache`. Runtime images still
belong to project-owned launcher profiles, so live home-cache copy requires a
launcher-owned cross-profile copy/export/import operation rather than raw
filesystem copying.

Generated startup scripts for PLexus-managed images configure Iceberg/Metacello
dependency clones to use `<PLEXUS_HOME>/repositories/iceberg`. This is fixed
relative to PLexus home; the only dependency repository policy knob is
`home.dependencyRepositories.networkPolicy`. After project and MCP loads, the
same startup script removes shared-cache repositories from the Iceberg registry
unless the repository path matches one of the image's declared editable
repository workspaces. The script records the result in
`dependency-repository-detach-<image-id>.properties`, and lifecycle diagnostics
surface the detached repository names and locations.

## Prototype Open/Close Check

Run one real-image lifecycle check after building:

```sh
npm run build
npm run prototype:open-close -- --imageName ExistingSampleImage --workspaceId task-a
```

The prototype script creates a disposable `plexus.project.json`, verifies the
image exists in PharoLauncher, refuses to continue if that image is already
running, calls `project open`, confirms process and health state, calls
`project close`, and confirms the process is gone.

## Open/Route/Close Smoke Check

Run the bounded integration smoke when the host has a PharoLauncher image that
already contains the Pharo MCP worker, or when the host can load it during image
startup:

```sh
npm run build
npm run smoke:open-route-close -- --copyFromImageName MCP12-2
```

When no existing image is known to be copyable, let the smoke create a
temporary source image from the local launcher templates and copy the runtime
image from that source:

```sh
npm run smoke:open-route-close -- --createSourceFromTemplate
```

The smoke creates a disposable PLexus project and isolated state root, copies
the source image when `--copyFromImageName` is used, opens it through PLexus
core lifecycle orchestration, registers the route, verifies `tools/list`
exposes the current Pharo MCP `find-packages` tool, routes that read-only probe
into every active image, closes the images, checks that the processes are gone,
checks that the closed target is unregistered from gateway status, then deletes
copied images, temporary source images, and temp directories.

Use `plexus_gateway_status` with `refreshTools: true` when checking whether a
long-running gateway has caught up to image-side MCP changes. The gateway keeps
one advertised Pharo facade schema per target/scope; mixed upstream tool
fingerprints are reported as a degraded schema state instead of being merged or
silently selected from one image. Refresh also performs a best-effort MCP
`initialize` probe so status can include upstream server version and
capabilities when the image endpoint supports the lifecycle.

For a deliberate showcase/debug run, pass `--keepOpen` or `--showcase`. That
mode still requires copied or template-created disposable images and a
project-owned launcher profile under the smoke state root. It starts and
registers through the project-local route-control gateway, keeps a separate
in-process gateway only for smoke probes, verifies route-control status before
exiting, and writes `keep-open-cleanup-context.json` with the scoped
`plexus project close ...` command, retained paths, launcher profile
environment, and the owned `pharo_launcher_image_delete` tool calls needed to
remove copied/source images after close.

For interrupted retained runs, audit PLexus-owned leftovers before deleting
anything:

```sh
plexus project cleanup <project-root> --state-root <state-root> --workspace-id <workspace-id>
```

Add `--confirm` to stop owned image processes, unregister the route, release
owned port claims, stop the managed project-local gateway, remove endpoint
handoff files, and delete scoped launcher images that have PLexus creation
ownership metadata. Add `--delete-state` only when the runtime state file should
also be removed.

Use `--imageSpecJson` more than once to exercise the real multi-image shape:

```sh
npm run smoke:open-route-close -- \
  --imageSpecJson '{"id":"dev","copyFromImageName":"MCP12-2"}' \
  --imageSpecJson '{"id":"peer","copyFromImageName":"MCP12-2"}'
```

To exercise the PLexus home image cache from a fresh template, pass a disposable
home path plus a template-created image spec. The smoke stages both the
project-owned launcher profile and the home cache launcher profile:

```sh
npm run smoke:open-route-close -- \
  --homePath /private/tmp/plexus-home-cache-smoke/home \
  --mcpPharoRepoDir /path/to/MCP-Pharo \
  --imageSpecJson '{"id":"dev","imageName":"PlexusHomeCacheSmoke-dev","active":true,"create":{"kind":"template","templateName":"Pharo 13.0 - 64bit (stable)"},"git":{"transport":"https"}}'
```

Run a second smoke with the same `--homePath` and a different runtime image name
to verify the hit path. Flush the disposable cache afterward with
`plexus_home_image_cache_flush({ projectPath, confirm: true })` before removing
the temp root.

Multi-image runs verify that PLexus starts distinct processes, assigns distinct
ports, routes into each image, and keeps image-local state isolated through a
second routed probe.

Run the deeper Pharo user workflow with:

```sh
npm run smoke:open-route-close -- \
  --imageSpecJson '{"id":"dev","copyFromImageName":"MCP12-2"}' \
  --imageSpecJson '{"id":"peer","copyFromImageName":"MCP12-2"}' \
  --scenario project-edit-export
```

`project-edit-export` creates an owned temporary Git repository per image,
creates a Smalltalk class and test class in the image, compiles methods, runs
the generated tests, registers the packages with `edit-repository`, checks the
image-side diff, exports the packages to disk, verifies host-side Git status is
dirty, and verifies no commit was created. The scenario intentionally never
calls commit, push, pull, or fetch.

Use `--stepJson` for extra routed calls, for example:

```sh
npm run smoke:open-route-close -- \
  --copyFromImageName MCP12-2 \
  --stepJson '{"forEachImage":true,"toolName":"find-packages","arguments":{"projectNames":["MCP"]},"expectedText":"packages found"}'
```

## Useful Docs

- `docs/architecture.md`: runtime architecture and target registry model.
- `docs/user/getting-started.md`: first-use PLexus setup.
- `docs/user/runtime-model.md`: user-facing project/workspace/target/image
  model.
- `docs/user/agent-pharo-access.md`: scoped launcher and routed Pharo facade.
- `docs/reference/mcp.md`: MCP server and tool ownership reference.
- `docs/troubleshooting.md`: common runtime and routing failures.
- `docs/live-smoke-runner-boundary.md`: disposable live-smoke approval,
  timeout, artifact, and cleanup boundary.
- `docs/project-model.md`: project/workspace/target/image arity.
- `docs/vibe-kanban-setup.md`: optional Vibe workspace and agent setup.
- `docs/roadmap.md`: planned work.
