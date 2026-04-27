# PLexus

PLexus manages Pharo Launcher profiles and per-image MCP routing for agent-driven development.

It sits between agents and Pharo Launcher: PLexus opens declared images, keeps
runtime state outside those images, and gives agents a stable MCP route to the
selected image.

## What PLexus Does

- Opens and closes Pharo images from configured Pharo Launcher profiles through
  MCP-PL (`mcp-pl`).
- Keeps image names, MCP ports, and runtime state isolated per agent run.
- Exposes a scoped `pharo-launcher` MCP surface for image lifecycle.
- Routes `pharo` MCP tool calls to a selected image by `imageId`.
- Preserves Pharo Launcher as the low-level profile and image provider.

## Requirements

- Node.js `>=24` with `npm` and `npx`.
- Pharo Launcher.
- A project with a `plexus.project.json`.
- Vibe Kanban and Codex when using PLexus for agent-driven work.

`npm install` installs `@evref-bl/mcp-pl` as a package dependency. Local
source-checkout overrides are only needed for PLexus development; see
`docs/development.md`.

## Project Config

Add `plexus.project.json` to the project root you want PLexus to manage:

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

Use image-name templates such as `{workspaceId}` when several task worktrees may
run in parallel. Omit `mcp.port` unless the project intentionally needs a fixed
port for a single local workspace.

Supported image-name tokens are:

```text
{projectId}
{projectName}
{workspaceId}
{targetId}
{imageId}
```

`git.transport` can be `ssh`, `https`, or `http`; it defaults to `ssh`.

## Basic Usage

Install and build from a source checkout:

```sh
npm install
npm run build
```

Open a configured PLexus runtime target:

```sh
plexus project open <project-root> --workspace-id task-123 --state-root <shared-state-root>
```

Close it:

```sh
plexus project close <project-root> --workspace-id task-123 --state-root <shared-state-root>
```

Run the scoped launcher MCP surface for an agent run:

```sh
plexus mcp pharo-launcher --project-path <project-root> --workspace-id task-123 --state-root <shared-state-root>
```

Start the routing gateway:

```sh
plexus-gateway
```

The shared state root should be the same for sibling worktrees so PLexus can
avoid image-name and port collisions.

## Agent Workflow

Kanban-spawned agents should use two MCP surfaces:

- `pharo-launcher`: list, create, start, inspect, and stop images scoped to the
  current PLexus target.
- `pharo`: run project Pharo tools against one image by passing `imageId`.

The agent chooses or starts an image through `pharo-launcher`, then passes the
returned `imageId` to every `pharo` call. Tool names stay stable while image
availability is represented as runtime data.

## More Documentation

- `docs/kanban-agent-pharo-access.md`: agent-facing Pharo workflow and routing
  errors.
- `docs/vibe-kanban-setup.md`: Vibe Kanban workspace setup.
- `docs/project-model.md`: project, workspace, target, and image vocabulary.
- `docs/development.md`: repository layout, build/test workflow, dependency
  overrides, and prototype checks.
- `docs/package-boundaries.md`: package ownership and dependency direction.
