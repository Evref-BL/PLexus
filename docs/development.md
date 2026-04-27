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
  kanban-agent-pharo-access.md
  package-boundaries.md
  project-model.md
  vibe-kanban-setup.md
  roadmap.md
scripts/
  verify-environment.ps1
```

## Package Boundaries

The intended split is:

- `@plexus/core` / CLI owns project config, workspace and image lifecycle,
  runtime state, port allocation, startup script generation, health checks,
  route registration, and the scoped `pharo-launcher` facade.
- `@plexus/gateway` owns route registration, route status, and forwarding
  project Pharo MCP calls to image-scoped MCP servers.
- `@evref-bl/pharo-launcher-mcp` owns raw PharoLauncher CLI integration.

The repository is still transitional. Lifecycle tools may still be exposed by
the gateway, and the gateway may still import `@plexus/core`. New lifecycle
behavior belongs in PLexus core; new routing behavior belongs in the gateway.
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

The verification script is currently PowerShell-based. Keep executable PLexus
logic OS-agnostic; put unavoidable platform behavior behind small, named helpers
or clearly labeled scripts.

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
$env:PHARO_LAUNCHER_MCP_ENTRY = "C:\dev\code\git\pharo-launcher-mcp\dist\index.js"
```

## Runtime State

PLexus stores runtime state outside Pharo images:

```text
<state-root>/projects/<project-id>/workspaces/<workspace-id>/state.json
```

Use one shared `PLEXUS_STATE_ROOT` across parallel Vibe Kanban worktrees so
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

The script configures image-local Iceberg Git transport, loads the configured
`mcp.loadScript` when present, falls back to the `Evref-BL/MCP` Metacello load,
starts MCP on the assigned runtime port, and registers the server in
`Smalltalk globals` as `#PLexusMCPServer`.

## Prototype Open/Close Check

Run one real-image lifecycle check after building:

```sh
npm run build
npm run prototype:open-close -- --imageName MyExistingImage --workspaceId task-123
```

The prototype script creates a disposable `plexus.project.json`, verifies the
image exists in PharoLauncher, refuses to continue if that image is already
running, calls `project open`, confirms process and health state, calls
`project close`, and confirms the process is gone.

## Useful Docs

- `docs/architecture.md`: runtime architecture and target registry model.
- `docs/project-model.md`: project/workspace/target/image arity.
- `docs/kanban-agent-pharo-access.md`: scoped launcher and routed Pharo facade.
- `docs/vibe-kanban-setup.md`: workspace and agent setup.
- `docs/roadmap.md`: planned work.
