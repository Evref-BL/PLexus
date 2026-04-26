# Architecture

## Short Version

PLexus is the agentic orchestration layer that coordinates MCP-PL, the PLexus Gateway, and image-scoped Pharo MCP workers.

The project/worktree/target arity is defined in `docs/project-model.md`.

```text
Codex in Vibe Kanban
  -> PLexus orchestration tools
      -> target registry
      -> MCP-PL
          -> PharoLauncher CLI
      -> PLexus Gateway (routing)
          -> Pharo image worker per worktree
```

The orchestration and PharoLauncher control layers must not run inside a project Pharo image. They exist specifically to recover from broken images, route between versions, and keep worktree state separate.

## Components

### Vibe Kanban

Owns issues, workspaces, worktree creation, agent sessions, diffs, and review flow.

### PLexus

Owns workflow policy and project/workspace/image orchestration:

- maintain a target registry
- map Vibe Kanban tasks to worktrees and images
- isolate runtime state by `projectId` and `workspaceId`
- choose when to create, copy, restart, or retire a target
- call MCP-PL for PharoLauncher operations
- register routes in the gateway and decide where tool calls should go

### PLexus Gateway

Owns routing only:

- register/unregister targets and keep an in-memory route table keyed by `targetId`
- report routing status for registered targets/images
- forward MCP tool calls to the selected image MCP server

The gateway must not depend on PLexus or MCP-PL, and it should not read project config or runtime state from disk. PLexus is responsible for orchestration/state and registers routes into the gateway.

### MCP-PL

Owns the PharoLauncher boundary:

- discover PharoLauncher installation
- list images, VMs, templates, and processes
- create or copy images for a worktree
- start and stop PharoLauncher-managed processes
- normalize CLI errors, timeouts, stdout, and stderr

## Agent-Facing MCP Surfaces

Kanban-spawned agents should not receive raw host-wide image access. PLexus
exposes image access as two scoped MCP surfaces:

- `pharo-launcher`: a PLexus-scoped facade over MCP-PL for image lifecycle
  operations in the current project/workspace.
- `pharo`: a stable project-wide Pharo MCP facade that adds an explicit
  `imageId` routing argument to each image tool.

The detailed contract for the scoped launcher facade is in
`docs/kanban-agent-pharo-access.md`.

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

Use one shared state root across parallel Vibe Kanban worktrees so PLexus can avoid port collisions. A later implementation can move this to SQLite when locking and richer queries are needed.

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
port
token
status
lastHealthCheck
createdAt
updatedAt
```

## Worker Model

Use one worker per image. A single central in-image worker cannot safely represent multiple mutable Pharo images, and a single image cannot represent multiple Git versions at the same time.

PLexus keeps target identity stable while MCP-PL and the image workers do the low-level process work. Image workers can crash and be restarted behind that target identity. If a project has multiple registered workspaces, callers must route by `targetId` (gateway key) or by `projectId` plus `workspaceId` (PLexus orchestration identity).
