# MCP Reference

PLexus exposes separate MCP surfaces for lifecycle, scoped launcher access, and
routed Pharo tools.

## Server Commands

Project lifecycle:

```sh
plexus mcp project
```

Scoped launcher for one project/workspace:

```sh
plexus mcp pharo-launcher --project-path <project-root> --workspace-id <workspace-id> --state-root <state-root>
```

Gateway:

```sh
plexus-gateway
```

In HTTP service mode, one gateway process exposes:

```text
/mcp          agent-facing pharo_gateway tools
/control-mcp trusted route-control tools
```

## Project Lifecycle Tools

The `plexus_project` surface owns project runtime lifecycle:

```text
plexus_project_open
plexus_project_close
plexus_project_status
plexus_home_image_cache_status
plexus_home_image_cache_flush
plexus_rescue_image
```

Use this surface for opening, closing, inspecting, planning rescue, applying
rescue, and inspecting or flushing PLexus home image cache entries.

## Scoped Launcher Tools

The scoped `pharo-launcher` surface is a PLexus facade over
pharo-launcher-mcp. It resolves `imageId` through the current project,
workspace, and target before calling raw launcher operations.

Expected agent-facing tools include:

```text
pharo_launcher_image_list
pharo_launcher_image_info
pharo_launcher_image_create
pharo_launcher_image_start
pharo_launcher_image_open_interactive
pharo_launcher_image_show
pharo_launcher_image_hide
pharo_launcher_image_stop
pharo_launcher_image_reset
```

These tools must not provide raw host-wide image, VM, template, or process
mutation unless project policy explicitly allows it.
`pharo_launcher_image_reset` is the scoped destructive recreate workflow for a
declared image id and reports the resulting lifecycle and `pharo_gateway` route
status without exposing raw launcher names or endpoint ports.

## Pharo Gateway Tools

The `pharo_gateway` server is the agent-facing Pharo MCP proxy.

Its tools come from the project-wide Pharo MCP contract. Each routed call adds
an explicit `imageId` argument at the PLexus facade boundary:

```json
{
  "imageId": "dev",
  "className": "SampleClass"
}
```

The gateway validates route ownership and removes `imageId` before forwarding
the call to the selected image-local MCP server.

The gateway advertises one Pharo tool schema for the selected target/scope. It
can refresh that schema from routable images and records a stable fingerprint in
`plexus_gateway_status` when called with `refreshTools: true`. If routable images
return different tool schemas, the gateway reports a mismatched schema state and
refuses typed Pharo facade calls until the images are brought back to one MCP
contract. During refresh, PLexus also performs a best-effort MCP `initialize`
probe and includes upstream lifecycle, protocol version, capabilities, and
server info in the schema status when the image endpoint provides them.

## Route-Control Tools

Route-control tools are trusted PLexus/operator controls:

```text
plexus_gateway_register_target
plexus_gateway_unregister_target
plexus_gateway_status
plexus_gateway_cleanup_stale_routes
```

Do not expose them in normal implementation-agent tool catalogs.

## Raw Routing

`plexus_route_to_image` is a route-control/debug escape hatch. It is hidden by
default and exposed only when explicitly enabled with:

```text
PLEXUS_EXPOSE_RAW_ROUTING_TOOL=true
```

Normal agents should use typed `pharo_gateway` tools with `imageId`.
