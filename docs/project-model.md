# Project Model

This document defines the PLexus runtime vocabulary and arity. It is developer documentation, not end-user setup guidance.

## Arity

```text
Vibe Kanban project  1:1  PLexus project
PLexus project       1:N  PLexus workspaces
PLexus workspace     1:1  runtime target
runtime target       1:N  Pharo images
```

## Concepts

### Vibe Kanban Project

A Vibe Kanban project is the human-facing project where tickets, workspaces, branches, agent sessions, reviews, and diffs are managed.

For now, one Vibe Kanban project maps to one PLexus project.

### PLexus Project

A PLexus project is the logical project described by `plexus.project.json` at a repository root.

The project id comes from:

```json
{
  "kanban": {
    "provider": "vibe-kanban",
    "projectId": "project-123"
  }
}
```

That `projectId` identifies the logical project. It must not be used alone as a unique runtime route once parallel worktrees are open.

### PLexus Workspace

A PLexus workspace is one isolated runtime instance of a PLexus project, usually backed by one Git worktree.

The `workspaceId` separates sibling worktrees for the same project. The default is the project root directory name, which works well for Vibe Kanban worktree directories. Callers can override it with:

```text
--workspace-id
PLEXUS_WORKSPACE_ID
VIBE_KANBAN_WORKSPACE_ID
```

Workspace-scoped runtime state lives at:

```text
<state-root>/projects/<project-id>/workspaces/<workspace-id>/state.json
```

Use one shared `PLEXUS_STATE_ROOT` across parallel worktrees so PLexus can see sibling workspace allocations and avoid port collisions.

### Runtime Target

A runtime target is the routable identity for one PLexus workspace.

By default:

```text
targetId = <project-id>--<workspace-id>
```

The current prototype keeps the relationship as one workspace to one target. Later, this could expand if one workspace needs multiple independent runtime targets, but that is not part of the current design.

The PLexus Gateway routing table is keyed by `targetId`. A route by `projectId` alone is only unambiguous when exactly one workspace for that project is registered.

### Pharo Image

A runtime target can manage several Pharo images, as configured in `plexus.project.json`.

Each image has:

```text
image id
rendered image name
assigned MCP port
optional process pid
status
```

For parallel worktrees, image names should include workspace identity:

```json
{
  "id": "dev",
  "imageName": "MyProject-{workspaceId}-dev",
  "active": true,
  "git": {
    "transport": "ssh"
  },
  "mcp": {
    "loadScript": "pharo/load-mcp.st"
  }
}
```

Supported image-name template tokens are:

```text
{projectId}
{projectName}
{workspaceId}
{targetId}
{imageId}
```

Image `git.transport` controls the Git/Iceberg transport the image should use
for image-local repository operations. Supported values are `ssh`, `https`, and
`http`; omitted config defaults to `ssh`.

Optional SSH key paths can be supplied per image:

```json
{
  "git": {
    "transport": "ssh",
    "ssh": {
      "publicKey": "C:\\Users\\you\\.ssh\\id_rsa.pub",
      "privateKey": "C:\\Users\\you\\.ssh\\id_rsa"
    }
  }
}
```

For `https` or `http`, an image can provide `plainCredentials` with a username
and password/token. PLexus writes these settings into the generated Smalltalk
startup script because the PharoLauncher CLI does not expose a protocol switch
for image launch.

## Routing Rules

Split routing into two layers:

### PLexus (Lifecycle)

PLexus lifecycle tools (for example `plexus_project_open`, `plexus_project_close`, `plexus_project_status`) accept project references in three forms:

```text
projectPath
targetId
projectId + workspaceId
```

`projectPath` is the most convenient form when starting from a local worktree path. If `workspaceId` is omitted, PLexus derives it from the path basename.

`targetId` is the most precise route key and should be preferred when a caller already knows it.

`projectId + workspaceId` is the stable pair to use when starting from Kanban project identity and worktree identity.

### PLexus Gateway (Routing Only)

Gateway routing tools (for example `plexus_route_to_image`) should route using the gateway's in-memory registrations keyed by `targetId`. The gateway should not resolve projects from disk or derive workspace identity from `projectPath`; that work belongs in PLexus, which then registers/updates routes in the gateway.

`projectId` alone can list all registered targets for that project. It must not be used for `plexus_route_to_image` when more than one workspace is registered, because the image id may exist in several workspaces.

Project/workspace lifecycle tools (`plexus_project_open`, `plexus_project_close`, `plexus_project_status`) belong to PLexus. Gateway-only tools belong to the PLexus Gateway (for example `plexus_route_to_image`, `plexus_gateway_register_target`, `plexus_gateway_unregister_target`, `plexus_gateway_status`, and `plexus_gateway_cleanup_stale_routes`). See `docs/package-boundaries.md`.

## Port And Image Isolation

Parallel worktrees must not share image names or MCP ports.

PLexus handles dynamic ports by scanning sibling workspace state under the shared state root and reserving ports used by non-stopped images.

Fixed `mcp.port` values are allowed, but they are not parallel-friendly. If another active workspace for the same project already reserves the configured port, `project open` fails instead of starting two workers on the same port.

PLexus does not create naming conventions on behalf of projects. It only renders the configured image-name template. The project owns conventions like `MyProject-{workspaceId}-dev`.

## Example

```text
Vibe Kanban project: Pharo MCP Orchestration
  PLexus projectId: pharo-mcp-orchestration
    workspaceId: task-123
      targetId: pharo-mcp-orchestration--task-123
      images:
        dev -> Pharo-MCP-task-123-dev on port 7100
        baseline -> Pharo-MCP-task-123-baseline on port 7101
    workspaceId: task-456
      targetId: pharo-mcp-orchestration--task-456
      images:
        dev -> Pharo-MCP-task-456-dev on port 7102
        baseline -> Pharo-MCP-task-456-baseline on port 7103
```
