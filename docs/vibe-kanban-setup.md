# Vibe Kanban Setup

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

Keep MCP-PL as a separate repository:

```text
C:\dev\code\git\MCP-PL
```

It can be added as a second Vibe Kanban project when work is specifically about the PharoLauncher MCP server. PLexus installs MCP-PL as an npm dependency, so normal PLexus usage should resolve the installed `mcp-pl` package.

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

MCP-PL is resolved from the installed package by default. Use environment variables only when overriding the package resolution:

```text
MCP_PL_COMMAND=node
MCP_PL_ENTRY=C:\dev\code\git\MCP-PL\dist\index.js
```

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
