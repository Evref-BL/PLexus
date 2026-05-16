# Vibe Kanban Setup

The concrete paths in this guide are Windows examples unless a block is marked
POSIX. PLexus-generated workspace MCP config also supports POSIX-style absolute
paths and preserves the style supplied by the caller.

## Start Vibe Kanban

```powershell
npx vibe-kanban
```

If `npx` is missing in the current terminal after installing Node.js, open a new PowerShell, CMD, or MSYS2 MINGW64 terminal.

## Project

Create a Vibe Kanban project named:

```text
Pharo MCP Orchestration
```

Add this repository:

```text
C:\dev\code\git\PLexus
```

Use `main` as the target branch.

Keep pharo-launcher-mcp as a separate repository:

```text
C:\dev\code\git\pharo-launcher-mcp
```

It can be added as a second Vibe Kanban project when work is specifically about the PharoLauncher MCP server. PLexus installs pharo-launcher-mcp as an npm dependency, so normal PLexus usage should resolve the installed `pharo-launcher-mcp` package.

## Workspace Directory

Use a workspace directory outside the repository:

```text
C:\dev\code\git\.vibe-kanban-workspaces
```

This keeps generated worktrees out of the source tree and makes image-to-worktree mappings predictable.

Use one shared PLexus state root for every parallel worktree:

```text
PLEXUS_STATE_ROOT=C:\dev\code\git\.plexus-state
```

POSIX example:

```text
PLEXUS_STATE_ROOT=/srv/git/.plexus-state
```

PLexus stores state under `projects/<project-id>/workspaces/<workspace-id>/state.json`. The default workspace id is the worktree directory name; override it with `PLEXUS_WORKSPACE_ID` only when the launcher or agent environment already has a stable task id to use.

For project configs used by parallel worktrees, omit fixed `mcp.port` values and use image-name templates such as `MyProject-{workspaceId}-dev`. Fixed ports and fixed image names are useful for a single local workspace, but they intentionally collide when two task worktrees are opened at once.

## Codex Agent Profile

Recommended starting profile:

```text
Agent: CODEX
Profile: Codex - Pharo Worktree
Sandbox: workspace-write
Approval: on-request
Reasoning effort: high
```

pharo-launcher-mcp is resolved from the installed package by default. Use environment variables only when overriding the package resolution:

```text
PHARO_LAUNCHER_MCP_COMMAND=node
PHARO_LAUNCHER_MCP_ENTRY=C:\dev\code\git\pharo-launcher-mcp\dist\index.js
```

POSIX override example:

```text
PHARO_LAUNCHER_MCP_COMMAND=node
PHARO_LAUNCHER_MCP_ENTRY=/srv/git/pharo-launcher-mcp/dist/index.js
```

## Agent Pharo Access

PLexus-managed Kanban agents should see two Pharo-facing MCP surfaces:

- `pharo-launcher` for workspace-scoped image lifecycle.
- `gateway` for routed image-local code tools.

The agent workflow is:

```text
list/create/start an image with pharo-launcher
load or pull the project in that image
pass imageId to every gateway code tool call
run tests and inspect/edit code through gateway
```

`gateway.tools/list` is stable for the project and is not rewritten when images
start or stop. Image selection is data, carried by the `imageId` argument.

See `docs/kanban-agent-pharo-access.md` for the full workflow and routing error
model.

Generated workspace MCP config should preserve unrelated user entries and add
these managed server names. This Windows example keeps Windows path values:

```json
{
  "servers": {
    "pharo-launcher": {
      "command": "plexus",
      "args": ["mcp", "pharo-launcher"],
      "env": {
        "PLEXUS_AGENT_MCP_SURFACE": "pharo-launcher",
        "PLEXUS_PROJECT_ROOT": "C:\\path\\to\\worktree",
        "PLEXUS_PROJECT_ID": "project-123",
        "PLEXUS_WORKSPACE_ID": "task-123",
        "VIBE_KANBAN_WORKSPACE_ID": "task-123",
        "PLEXUS_TARGET_ID": "project-123--task-123",
        "PLEXUS_STATE_ROOT": "C:\\dev\\code\\git\\.plexus-state"
      }
    },
    "gateway": {
      "command": "plexus-gateway",
      "args": ["--stdio"],
      "env": {
        "PLEXUS_GATEWAY_SURFACE": "gateway",
        "PLEXUS_PROJECT_ROOT": "C:\\path\\to\\worktree",
        "PLEXUS_PROJECT_ID": "project-123",
        "PLEXUS_WORKSPACE_ID": "task-123",
        "VIBE_KANBAN_WORKSPACE_ID": "task-123",
        "PLEXUS_TARGET_ID": "project-123--task-123",
        "PLEXUS_STATE_ROOT": "C:\\dev\\code\\git\\.plexus-state",
        "PLEXUS_PHARO_TOOLS_JSON": "[...]"
      }
    }
  }
}
```

The same generated config can use POSIX roots when PLexus is called with POSIX
paths:

```json
{
  "servers": {
    "pharo-launcher": {
      "env": {
        "PLEXUS_PROJECT_ROOT": "/srv/git/worktree",
        "PLEXUS_STATE_ROOT": "/srv/git/.plexus-state"
      }
    },
    "gateway": {
      "env": {
        "PLEXUS_PROJECT_ROOT": "/srv/git/worktree",
        "PLEXUS_STATE_ROOT": "/srv/git/.plexus-state"
      }
    }
  }
}
```

The `pharo-launcher` entry starts the PLexus-scoped launcher facade, not raw
pharo-launcher-mcp. The `gateway` entry starts the gateway in agent-facing Pharo
proxy mode with the project tool contract serialized in
`PLEXUS_PHARO_TOOLS_JSON`; the gateway adds the required `imageId` routing field
to those tools.

During migration, older workspaces may still contain a managed `pharo` entry or
`PLEXUS_GATEWAY_SURFACE=pharo`; both should be replaced by `gateway` in new
generated config. Raw `plexus_route_to_image` is not part of this normal agent
config and remains behind explicit raw-routing opt-in for admin/debug use.

## Repository Scripts

Setup script:

```powershell
npm install
npm run build
```

Cleanup script:

```powershell
npm run clean
```

Avoid starting Pharo images in setup scripts. Image lifecycle should be explicit through PLexus tools.
