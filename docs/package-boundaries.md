# Package Boundaries And Dependency Direction

This document is the source of truth for where PLexus features belong after the package split.

## Packages

### pharo-launcher-mcp (`@evref-bl/pharo-launcher-mcp`)

Standalone PharoLauncher MCP server (separate repository: `@evref-bl/pharo-launcher-mcp`, `@evref-bl/pharo-launcher-mcp` on npm).

**Owns**

- PharoLauncher CLI discovery and process lifecycle
- Image list/info, VM list/info, template discovery
- Start/stop/list processes and normalize CLI output/errors

**Must not depend on**

- PLexus
- PLexus Gateway

### PLexus Gateway (`@evref-bl/plexus-gateway`)

Routing-only MCP server.

**Owns**

- Route registration and in-memory route table keyed by `targetId`
- Route status for registered targets/images
- Explicit stale-route cleanup for routes whose runtime state file is gone
- Forwarding MCP calls to image-scoped MCP servers (HTTP to `http://127.0.0.1:<port>/mcp`)
- The stable project-wide `gateway` facade that routes typed Pharo MCP calls by
  explicit `imageId`
- Route metadata that tells subagents where the scoped `imageId` comes from and
  how to carry it into gateway tool calls

**Must not depend on**

- PLexus orchestration (`@evref-bl/plexus-core` / CLI)
- pharo-launcher-mcp (`@evref-bl/pharo-launcher-mcp`)

The gateway does not read `plexus.project.json` or workspace state from disk to discover projects. PLexus core owns orchestration/state and registers already-resolved target routes in the gateway.

### PLexus Orchestration (`@evref-bl/plexus-core` + CLI)

Project/workspace/image orchestration and lifecycle.

**Owns**

- Project/workspace/image open, close, status, and runtime state on disk
- Lifecycle MCP tools: `plexus_project_open`, `plexus_project_close`, and `plexus_project_status`
- Image rescue planning/application (`plexus_rescue_image`)
- The scoped project/workspace/target/image context model handed to DevNexus
  plugins and subagents
- Port allocation, startup script generation, image health polling
- Policy around targets/workspaces (how to map Kanban/worktrees/images)
- Calling pharo-launcher-mcp for PharoLauncher operations
- Registering and unregistering routes through the gateway route-management API
- Exposing the scoped agent-facing `pharo-launcher` facade, because only PLexus has workspace state and image naming policy

**Depends on**

- pharo-launcher-mcp (`@evref-bl/pharo-launcher-mcp`)
- The gateway route-management API at runtime

`@evref-bl/plexus-core` does not need an npm dependency on `@evref-bl/plexus-gateway` to own lifecycle. It can register routes through an in-process adapter in tests/smokes or through the gateway MCP API in deployed use.

## Dependency Direction

```text
@evref-bl/pharo-launcher-mcp        @evref-bl/plexus-gateway
        ^                              ^
        |                              |
        +---------- @evref-bl/plexus-core / PLexus CLI
```

- PLexus core depends on pharo-launcher-mcp as a package.
- PLexus core calls the gateway route-management API when route registration is configured.
- pharo-launcher-mcp and the gateway are standalone and do not depend on PLexus or on each other.

## MCP Tool Ownership

PLexus orchestration tools:

- `plexus_project_open`
- `plexus_project_close`
- `plexus_project_status`
- `plexus_rescue_image`

PLexus Gateway internal/admin route-management tools:

- `plexus_gateway_register_target`
- `plexus_gateway_unregister_target`
- `plexus_gateway_status`
- `plexus_gateway_cleanup_stale_routes`

Raw gateway escape hatch:

- `plexus_route_to_image`: hidden by default and exposed only when raw routing is
  explicitly enabled for admin/debug use with
  `PLEXUS_EXPOSE_RAW_ROUTING_TOOL=true`.

Agent-facing Kanban MCP surfaces:

- `pharo-launcher`: belongs to PLexus orchestration. It is a scoped facade over pharo-launcher-mcp and must not expose raw host-wide PharoLauncher mutation.
- `gateway`: belongs to the routing layer. It is a stable facade over the
  project-wide Pharo MCP contract and routes calls by explicit `imageId`.

`pharo` remains only a temporary compatibility alias for older generated agent
config. New configs should expose `gateway`, and route-management tools should
stay out of normal agent-facing MCP config.

See `docs/kanban-agent-pharo-access.md` for the scoped launcher design.

## Where Does A New Feature Belong?

Use these rules of thumb:

- **Touches PharoLauncher or its CLI contract** -> pharo-launcher-mcp
- **Scopes PharoLauncher operations to a PLexus project/workspace, opens/closes a project/workspace, manages state, allocates ports, writes scripts, polls health** -> PLexus core
- **Registers routes, reports registered targets, prunes stale routes, forwards tool calls to an image MCP server** -> PLexus Gateway
