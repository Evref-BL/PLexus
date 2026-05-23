# Architecture

## Short Version

PLexus is the outside-image runtime control plane that coordinates
pharo-launcher-mcp, PLexus Gateway, and image-scoped Pharo MCP workers.

The project/worktree/target arity is defined in `docs/project-model.md`.

```text
Agent workspace or runner
  -> PLexus orchestration tools
      -> target registry
      -> pharo-launcher-mcp
          -> Pharo Launcher
      -> PLexus Gateway (routing)
          -> /control-mcp route-control
          -> /mcp agent gateway
          -> Pharo image worker per worktree
```

The orchestration and Pharo Launcher control layers must not run inside a
project Pharo image. They exist specifically to recover from broken images,
route between versions, and keep worktree state separate.

## Components

### Agent Runner

Owns task selection, worktree creation, agent sessions, diffs, and review flow.
DevNexus, Vibe Kanban, Codex, or another runner can sit above PLexus.

### PLexus

Owns workflow policy and project/workspace/image orchestration:

- maintain a target registry
- map agent workspaces to runtime targets and images
- isolate runtime state by `projectId` and `workspaceId`
- choose when to create, copy, restart, or retire a target
- call pharo-launcher-mcp for PharoLauncher operations
- register routes in the gateway and decide where tool calls should go

### PLexus Gateway

Owns routing only:

- register/unregister targets and keep an in-memory route table keyed by `targetId`
- report routing status for registered targets/images
- forward MCP tool calls to the selected image MCP server through the registered
  image endpoint, with fixed ports retained as compatibility fallback

The gateway must not depend on PLexus or pharo-launcher-mcp, and it should not read project config or runtime state from disk. PLexus is responsible for orchestration/state and registers routes into the gateway.

When served over HTTP, PLexus should run one gateway process with separate MCP
paths over the same in-memory route table:

- `/mcp` exposes the agent-facing `pharo_gateway` server.
- `/control-mcp` exposes trusted route-control operations used by PLexus core or
  operators.

This split keeps route registration/status/cleanup out of worker tool catalogs
without creating two independent gateway route tables.

### pharo-launcher-mcp

Owns the Pharo Launcher boundary:

- discover Pharo Launcher installation
- list images, VMs, templates, and processes
- create or copy images for a worktree
- start and stop PharoLauncher-managed processes
- normalize CLI errors, timeouts, stdout, and stderr

## Agent-Facing MCP Surfaces

Agent workers should not receive raw host-wide image access. PLexus
exposes clean MCP surfaces with separate ownership:

- `plexus_project`: PLexus project lifecycle tools such as
  `plexus_project_open`, `plexus_project_close`, and `plexus_project_status`.
- `pharo-launcher`: a PLexus-scoped facade over pharo-launcher-mcp for image lifecycle
  operations in the current project/workspace.
- `pharo_gateway`: a stable project-wide Pharo MCP proxy that adds an explicit
  `imageId` routing argument to each typed image tool.
- `route-control` or `gateway-control`: private/trusted route registration,
  status, and cleanup for PLexus core or operators.

The detailed contract for the scoped launcher facade is in
`docs/user/agent-pharo-access.md`.

Route registration, route status, stale-route cleanup, and raw
`plexus_route_to_image` calls are route-control gateway plumbing. They are not
normal agent-facing MCP surfaces; raw routing is hidden unless explicitly
enabled for route-control/debug work.

### Pharo Image Worker

Runs inside one Pharo image and exposes image-local operations:

- inspect classes and methods
- edit methods
- run tests
- evaluate code
- load code from the associated worktree

PLexus configures image-local Git behavior before starting the worker. The
project image config supports `ssh`, `https`, and `http`, with `ssh` as the
default. Because the PharoLauncher CLI launch command exposes `--script` but no
Git protocol switch, PLexus writes Iceberg credential setup into the generated
startup script and records the selected value in `Smalltalk globals` as
`#PLexusGitTransport`.

## Target Registry

The registry and runtime state are external to Pharo. The current prototype stores one JSON state file per project workspace:

```text
<state-root>/projects/<project-id>/workspaces/<workspace-id>/state.json
```

Use one shared state root across parallel agent worktrees so PLexus can avoid
port collisions. A later implementation can move this to SQLite when locking
and richer queries are needed.

Required fields:

```text
targetId
projectId
workspaceId
imageName
imagePath
changesPath
vmPath
worktreePath
branch
commit
pid
registered endpoint
fallback port
token
status
lastHealthCheck
createdAt
updatedAt
```

## Worker Model

Use one worker per image. A single central in-image worker cannot safely represent multiple mutable Pharo images, and a single image cannot represent multiple Git versions at the same time.

PLexus keeps target identity stable while pharo-launcher-mcp and the image workers do the low-level process work. Image workers can crash and be restarted behind that target identity. If a project has multiple registered workspaces, callers must route by `targetId` (gateway key) or by `projectId` plus `workspaceId` (PLexus orchestration identity).
