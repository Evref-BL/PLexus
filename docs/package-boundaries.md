# Package Boundaries And Dependency Direction

This document is the source of truth for where new features belong after the PLexus split.

## Packages

### MCP-PL (`@evref-bl/mcp-pl`)

Standalone PharoLauncher MCP server (separate repository: `@evref-bl/mcp-pl`, `@evref-bl/mcp-pl` on npm).

**Owns**

- PharoLauncher CLI discovery and process lifecycle
- Image list/info, VM list/info, template discovery
- Start/stop/list processes and normalize CLI output/errors

**Must not depend on**

- PLexus
- PLexus Gateway

### PLexus Gateway (`@plexus/gateway`)

Routing-only MCP server.

**Owns**

- Route registration and in-memory route table (keyed by `targetId`)
- Route status (what targets/images are registered, and where they route)
- Forwarding MCP calls to image-scoped MCP servers (HTTP to `http://127.0.0.1:<port>/mcp`)

**Must not depend on**

- PLexus orchestration (`@plexus/core` / CLI)
- MCP-PL (`@evref-bl/mcp-pl`)

The gateway should not read `plexus.project.json` or workspace state from disk. PLexus is responsible for orchestration/state, and registers/updates routes in the gateway.

### PLexus Orchestration (`@plexus/core` + CLI)

Project/workspace/image orchestration and lifecycle.

**Owns**

- Project/workspace/image open/close/status and runtime state on disk
- Port allocation, startup script generation, image health polling
- Policy around targets/workspaces (how to map Kanban/worktrees/images)
- Calling MCP-PL for PharoLauncher operations
- Registering routes in the gateway and choosing where tool calls should go
- Exposing the scoped agent-facing `pharo-launcher` facade, because only PLexus
  has workspace state and image naming policy

**Depends on**

- MCP-PL (`@evref-bl/mcp-pl`)
- PLexus Gateway (`@plexus/gateway`)

## Dependency Direction

```text
@evref-bl/mcp-pl        @plexus/gateway
        ^                      ^
        |                      |
        +---------- @plexus/core / PLexus CLI
```

- PLexus depends on both MCP-PL and the gateway.
- MCP-PL and the gateway are standalone and do not depend on PLexus (and must not depend on each other).

## MCP Tool Ownership (Current → Target)

PLexus orchestration tools (lifecycle):

- `plexus_project_open`: PLexus Gateway → PLexus
- `plexus_project_close`: PLexus Gateway → PLexus
- `plexus_project_status`: PLexus Gateway → PLexus

PLexus Gateway routing tools:

- `plexus_route_to_image`: stays in the gateway
- Keep/rename gateway-only tools in the gateway:
  - `plexus_gateway_status`
  - `plexus_gateway_register_project` (or `...register_target`)
  - `plexus_gateway_unregister_project` (or `...unregister_target`)

Until the move is completed, you may still see lifecycle tools implemented in `@plexus/gateway`. Treat that as transitional code: new lifecycle features belong in PLexus, and new routing features belong in the gateway.

Agent-facing Kanban MCP surfaces:

- `pharo-launcher`: belongs to PLexus orchestration. It is a scoped facade over
  MCP-PL and must not expose raw host-wide PharoLauncher mutation.
- `pharo`: belongs to the routing layer. It is a stable facade over the
  project-wide Pharo MCP contract and routes calls by explicit `imageId`.

See `docs/kanban-agent-pharo-access.md` for the scoped launcher design.

## Transitional Notes (Repo Today)

This repository currently contains transitional coupling that should be removed to reach the target boundary. For example:

- `@plexus/gateway` currently depends on `@plexus/core` (target: no dependency from gateway to PLexus).
- Lifecycle tools may still be implemented/exposed by the gateway (target: PLexus owns lifecycle tools).

## Where Does A New Feature Belong?

Use these rules of thumb:

- **Touches PharoLauncher or its CLI contract** → MCP-PL
- **Scopes PharoLauncher operations to a PLexus project/workspace, opens/closes a project/workspace, manages state, allocates ports, writes scripts, polls health** → PLexus
- **Registers routes, reports registered targets, forwards tool calls to an image MCP server** → PLexus Gateway
