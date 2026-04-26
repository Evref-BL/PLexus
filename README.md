# PLexus

PLexus is the orchestration layer for using Codex, Git worktrees, Vibe Kanban, MCP-PL, and image-scoped Pharo MCP workers together.

The name keeps `PL` uppercase for PharoLauncher.

## Project Split

- `PLexus` (`@plexus/core` + CLI): orchestration and lifecycle for projects/workspaces/images. Depends on the gateway and MCP-PL.
- `PLexus Gateway` (`@plexus/gateway`): routing-only MCP server. Owns route registration/status and forwarding MCP calls to image-scoped MCP servers. Must not depend on PLexus or MCP-PL.
- `MCP-PL` (`@evref-bl/mcp-pl`): standalone MCP server for PharoLauncher. Wraps the PharoLauncher CLI and process lifecycle. Must not depend on PLexus or the gateway.

See `docs/package-boundaries.md` for the final package boundary, dependency direction, and tool ownership.

## Goals

- Keep one Git worktree per coding task.
- Keep one Pharo image per worktree when image state matters.
- Keep the recovery and routing layer outside Pharo images.
- Let Vibe Kanban manage issues, workspaces, branches, and agent sessions.
- Let MCP-PL manage PharoLauncher access.
- Let PLexus manage target policy, Kanban workflows, worker health, and routing decisions.

## Repository Layout

```text
packages/
  plexus-core/            Shared config, target registry, and orchestration types
  plexus-gateway/         Routing-only MCP gateway (register/status/routes to images)
pharo/
  worker/                 In-image worker bootstrap scripts
docs/
  architecture.md
  kanban-agent-pharo-access.md
  package-boundaries.md
  project-model.md
  vibe-kanban-setup.md
  roadmap.md
scripts/
  verify-environment.ps1
```

## Prerequisites

- Git
- Node.js with `npm` and `npx`
- Vibe Kanban: `npx vibe-kanban`
- MCP-PL available as the `mcp-pl` npm package. During local development, this repository depends on the sibling repo at `C:\dev\code\git\MCP-PL`.
- Codex authenticated and configured in Vibe Kanban

On Windows, installing Node.js LTS via Winget should make `node`, `npm`, and `npx` available from fresh PowerShell and CMD terminals.

## MCP-PL Loading

`npm install` installs MCP-PL as a dependency of PLexus. By default, PLexus resolves the installed `mcp-pl` package and launches it with the current Node executable.

Environment variables are only needed for overrides, for example when testing an unpackaged sibling checkout:

```powershell
$env:MCP_PL_COMMAND="node"
$env:MCP_PL_ENTRY="C:\dev\code\git\MCP-PL\dist\index.js"
```

## Project Config

The developer-facing project/worktree/target arity is documented in `docs/project-model.md`.

Each managed project has a `plexus.project.json` at its root:

```json
{
  "name": "my-project",
  "kanban": {
    "provider": "vibe-kanban",
    "projectId": "project-123"
  },
  "images": [
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
  ]
}
```

`@plexus/core` validates this file through `loadProjectConfig(projectRoot)`. Image ids, image names, and MCP ports must be unique inside a project.
For parallel worktrees, prefer image-name templates and omit `mcp.port`. PLexus renders `{projectId}`, `{projectName}`, `{workspaceId}`, `{targetId}`, and `{imageId}` in `imageName`, then allocates a runtime port from the prototype range `7100-7199`.
If a fixed `mcp.port` is configured and another workspace for the same project is already using it, `project open` fails instead of colliding.

Each image can configure its image-local Git transport:

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

`git.transport` can be `ssh`, `https`, or `http`; omitted config defaults to
`ssh`. SSH keys are optional, so an image can use the platform SSH agent or its
existing Iceberg settings. For `https` or `http`, `git.plainCredentials` can
provide a username and password/token when the repository is not public.

## Runtime State

`@plexus/core` also provides path helpers for project runtime state. The default path is:

```text
.plexus/projects/<project-id>/workspaces/<workspace-id>/state.json
```

Callers can pass a separate state root when the state should live outside the managed repository. For parallel Vibe Kanban worktrees, use the same `PLEXUS_STATE_ROOT` for every worktree so PLexus can reserve ports across sibling workspaces.

The default `workspaceId` is the project root directory name. Callers can override it with `--workspace-id`, `PLEXUS_WORKSPACE_ID`, or `VIBE_KANBAN_WORKSPACE_ID`. The default `targetId` is `<project-id>--<workspace-id>`.

The state tracks the project id, workspace id, target id, optional project Pharo
MCP contract metadata, and each image id, rendered image name, assigned port,
optional process pid, status, and optional image Pharo MCP contract metadata.
Image status values are `starting`, `running`, `stopped`, or `failed`. Runtime
state can be saved and loaded through `saveProjectState(filePath, state)` and
`loadProjectState(filePath)`.

## Image Startup Scripts

Before launching an image, PLexus can generate a Smalltalk startup script into runtime state:

```text
.plexus/projects/<project-id>/workspaces/<workspace-id>/scripts/start-<image-id>.st
```

`writeProjectImageStartupScript(...)` writes a script that configures the image's
Iceberg Git transport/credentials, loads the configured `mcp.loadScript` if
present, falls back to the `Evref-BL/MCP` Metacello load, starts MCP on the
assigned runtime port, and registers the server in `Smalltalk globals` as
`#PLexusMCPServer`. The selected transport is also recorded as
`#PLexusGitTransport` for image-local worker code.

## First Commands

```powershell
npm install
npm run build
npm test
```

Open a configured project:

```powershell
plexus project open C:\path\to\project --workspace-id task-123 --state-root C:\dev\code\git\.plexus-state
```

`project open` loads `plexus.project.json`, resolves runtime ports, writes startup scripts, launches active PharoLauncher images through MCP-PL, polls process state and Pharo MCP health, then persists `.plexus/projects/<project-id>/workspaces/<workspace-id>/state.json` or the equivalent path under `--state-root`.

Close a configured project:

```powershell
plexus project close C:\path\to\project --workspace-id task-123 --state-root C:\dev\code\git\.plexus-state
```

`project close` loads runtime state, calls MCP-PL `pharo_launcher_process_kill` for each image marked `running`, clears its process id, marks it `stopped`, and persists the updated state.

Start the PLexus MCP gateway:

```powershell
plexus-gateway
```

Target ownership:

- Project/workspace lifecycle tools (`plexus_project_open`, `plexus_project_close`, `plexus_project_status`) live in PLexus (currently still exposed by the gateway during the split).
- Routing tools live in the gateway (`plexus_route_to_image` plus gateway-only status/register/unregister tools).
- Kanban agents should use scoped MCP surfaces: `pharo-launcher` for image
  lifecycle inside the current workspace and `pharo` for routed image-local code
  tools. See `docs/kanban-agent-pharo-access.md`.

The gateway keeps an in-memory routing table keyed by `targetId`, reports
per-image routability status, and forwards MCP tool calls to the selected image
server at `http://127.0.0.1:<port>/mcp`.

## Prototype Open/Close Check

Run one real-image lifecycle check after building:

```powershell
npm run build
npm run prototype:open-close -- --imageName MyExistingImage --workspaceId task-123
```

The prototype script creates a disposable `plexus.project.json`, verifies the image exists in PharoLauncher, refuses to continue if that image is already running, calls `project open`, confirms the process and health check, calls `project close`, and confirms the process is gone. It does not exercise gateway routing yet; that should come after image startup is reliable.

Verify the local machine:

```powershell
.\scripts\verify-environment.ps1
```

Start Vibe Kanban:

```powershell
npx vibe-kanban
```

Build the standalone PharoLauncher MCP server before refreshing the local file dependency:

```powershell
cd C:\dev\code\git\MCP-PL
npm install
npm run build
cd C:\dev\code\git\PLexus
npm install
```

PLexus should call the installed MCP-PL package rather than assuming a standalone `pharo-launcher` executable exists.
