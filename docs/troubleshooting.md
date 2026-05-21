# Troubleshooting

## Missing Gateway Tools

If the agent does not see routed Pharo tools, check that the gateway is running
and that the agent is connected to the agent-facing `/mcp` surface:

```sh
plexus-gateway
```

Route-control tools belong on `/control-mcp`; they should not appear in normal
implementation-agent tool catalogs.

## No Route Registered

Inspect project state:

```sh
plexus project status <project-root> --workspace-id <workspace-id> --state-root <state-root>
```

Then inspect trusted gateway status through route-control. A missing route
usually means the target was not opened, the gateway process was restarted after
registration, or stale routes were cleaned up.

Reopen the target when needed:

```sh
plexus project open <project-root> --workspace-id <workspace-id> --state-root <state-root>
```

## Image Not Found

`image_not_found` means the requested `imageId` is not known in the current
workspace. List scoped images through `pharo-launcher` and choose a returned
handle.

Do not retry with raw Pharo Launcher image names. PLexus routes by `imageId`,
project id, workspace id, and target id.

## Image Outside Workspace

`image_outside_workspace` means an image with the requested handle or name is
owned by another workspace or target. Do not use it from the current agent
session. Start or create a workspace-owned image instead.

## Port Conflicts

Use one shared state root across sibling worktrees so PLexus can reserve ports
before starting images:

```sh
export PLEXUS_STATE_ROOT=/tmp/plexus-state
```

Avoid fixed `mcp.port` values in `plexus.project.json` unless the project has
only one local runtime.

## Launcher Unavailable

If scoped launcher tools fail, check:

- Pharo Launcher is installed on the host.
- pharo-launcher-mcp can be resolved from the PLexus package installation.
- optional `PHARO_LAUNCHER_MCP_COMMAND` and `PHARO_LAUNCHER_MCP_ENTRY` overrides
  point at an existing local checkout only when intentionally testing one.

## Image MCP Unhealthy

If an image starts but `gateway` cannot route to it, check the image-local MCP
worker load path and generated startup script under the workspace runtime state:

```text
<state-root>/projects/<project-id>/workspaces/<workspace-id>/scripts/start-<image-id>.st
```

Treat an incompatible or missing image-local MCP contract as runtime state. Do
not bypass PLexus by calling host-wide launcher tools.

## Cleanup

Use `plexus project close` for normal target cleanup:

```sh
plexus project close <project-root> --workspace-id <workspace-id> --state-root <state-root>
```

Use home image cache flush only for cache entries you intentionally own:

```text
plexus_home_image_cache_flush({ projectPath, confirm: true })
```

Image deletion, rescue application, and cache mutation are live runtime
operations. Run them only under an approved runner boundary with a cleanup plan.
