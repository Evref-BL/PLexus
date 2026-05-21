# Getting Started

This guide covers the first-use path for PLexus.

Use PLexus when a Pharo project needs an outside-image runtime layer: scoped
Pharo Launcher operations, image runtime state, port allocation, route
registration, and gateway-based access to image-local Pharo MCP tools.

## Requirements

- Node.js 24 or newer, with `npm` and `npx`
- Pharo Launcher for live image work
- a project root with `plexus.project.json`
- an image-local Pharo MCP worker load path or prepared image when routing into
  Pharo code tools

## Install From Source

```sh
cd /path/to/PLexus
npm install
npm run build
```

The root package exposes:

```text
plexus
plexus-gateway
```

## Add Project Config

Create `plexus.project.json` at the project root:

```json
{
  "id": "sample-project",
  "name": "SampleProject",
  "images": [
    {
      "id": "dev",
      "imageName": "SampleProject-{workspaceId}-dev",
      "active": true,
      "git": {
        "transport": "ssh"
      },
      "mcp": {
        "loadScript": "pharo/load-mcp.st"
      }
    }
  ]
}
```

Use image-name templates such as `{workspaceId}` when several worktrees can run
in parallel. Avoid fixed `mcp.port` values unless the project intentionally has
only one local runtime.

Supported image-name tokens are:

```text
{projectId}
{projectName}
{workspaceId}
{targetId}
{imageId}
```

## Choose A State Root

Use one shared state root for sibling worktrees:

```sh
export PLEXUS_STATE_ROOT=/tmp/plexus-state
```

PowerShell:

```powershell
$env:PLEXUS_STATE_ROOT = "C:\work\.plexus-state"
```

The state root lets PLexus see sibling allocations and avoid image-name and
port collisions.

## Open A Runtime Target

```sh
plexus project open /path/to/project --workspace-id task-a --state-root /tmp/plexus-state
```

`project open` reads `plexus.project.json`, resolves the workspace and target
identity, creates or starts active images according to policy, writes runtime
state, and registers gateway routes when route-control is configured.

## Inspect And Close

```sh
plexus project status /path/to/project --workspace-id task-a --state-root /tmp/plexus-state
plexus project close /path/to/project --workspace-id task-a --state-root /tmp/plexus-state
```

`project close` stops scoped images and can apply repository workspace cleanup
policy when requested:

```sh
plexus project close /path/to/project \
  --workspace-id task-a \
  --state-root /tmp/plexus-state \
  --repository-workspace-cleanup-policy archive \
  --repository-workspace-archive-root /tmp/plexus-archives
```

## Start MCP Surfaces

Project lifecycle tools:

```sh
plexus mcp project
```

Scoped launcher tools for one project/workspace:

```sh
plexus mcp pharo-launcher --project-path /path/to/project --workspace-id task-a --state-root /tmp/plexus-state
```

Routing gateway:

```sh
plexus-gateway
```

In HTTP service mode, use one gateway process with two MCP paths:

```text
/mcp          agent-facing gateway facade
/control-mcp trusted route-control facade
```

Both paths share the same in-memory route table.

## Next Steps

- Read [Runtime Model](runtime-model.md) for the vocabulary and arity.
- Read [Agent Pharo Access](agent-pharo-access.md) for scoped image and routed
  Pharo tool workflows.
- Read [MCP Reference](../reference/mcp.md) for tool ownership.
- Read [Troubleshooting](../troubleshooting.md) when routes, ports, or image
  startup fail.
