# PLexus

PLexus is the outside-image runtime control plane for Pharo agent work.

It opens, closes, inspects, and routes scoped Pharo runtime targets while
keeping project metadata, runtime state, gateway routes, and recovery controls
outside the images themselves.

PLexus does not replace DevNexus. DevNexus remains the workspace, component,
work-item, worktree, target, and publication infrastructure. PLexus owns the
Pharo runtime layer beneath that workspace. pharo-launcher-mcp owns raw Pharo
Launcher access. MCP-Pharo runs inside one image and exposes image-local code
and environment tools.

## Where It Fits

```text
DevNexus workspace or agent runner
  -> PLexus project/runtime context
      -> pharo-launcher-mcp
          -> Pharo Launcher
      -> PLexus Gateway
          -> image-local MCP-Pharo worker
```

The main design point is outside-image runtime control. A Pharo image is a
runtime process to inspect, modify, route to, stop, replace, or rescue. The
image is not the owner of PLexus project configuration, route state, agent
configuration, or recovery policy.

## What It Owns

PLexus owns:

- `plexus.project.json` project runtime configuration
- workspace and target identity for parallel agent work
- runtime state under a shared state root
- rendered image names, `imageId` handles, and port allocation
- project open, close, status, image-cache, and rescue workflows
- startup script generation for image-local MCP workers
- route registration through PLexus Gateway route-control
- scoped `pharo-launcher` and `pharo_gateway` MCP surfaces for agents

PLexus does not own:

- generic work tracking, provider sync, or publication policy
- Pharo Launcher discovery, template listing, VM listing, raw image mutation, or
  process normalization
- image-local Smalltalk code editing, tests, repository export, or image save
- user-facing task boards or agent session scheduling

Those belong to DevNexus, pharo-launcher-mcp, MCP-Pharo, and the selected agent
runner.

## Terms

- A **PLexus project** is a source root containing `plexus.project.json`.
- A **PLexus workspace** is one isolated runtime instance of a project, usually
  aligned with one Git worktree.
- A **runtime target** is the routable identity for one workspace. The default
  `targetId` is `<project-id>--<workspace-id>`.
- An **imageId** is the stable PLexus handle agents use for one image inside a
  target. It is not a raw Pharo Launcher image name.
- A **state root** is shared host-local runtime state. Parallel worktrees should
  use the same state root so PLexus can avoid image-name and port collisions.
- **Route-control** is the trusted gateway surface used by PLexus or operators
  to register, inspect, and clean up routes.
- **Pharo gateway** is the agent-facing Pharo MCP proxy. It routes typed image-local
  tool calls by explicit `imageId`.

## Requirements

- Node.js 24 or newer, with `npm` and `npx`
- Pharo Launcher when live image work is needed
- a project root with `plexus.project.json`
- an image-local Pharo MCP worker load path or prepared image when routing into
  Pharo code tools

## Quick Start

Install and build from a source checkout:

```sh
npm install
npm run build
```

Add `plexus.project.json` to the project root you want PLexus to manage:

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
        "loadScript": "pharo/load-mcp.st",
        "loadPolicy": "ifMissing"
      }
    }
  ]
}
```

Open a runtime target:

```sh
plexus project open /path/to/project --workspace-id task-a --state-root /tmp/plexus-state
```

Inspect it:

```sh
plexus project status /path/to/project --workspace-id task-a --state-root /tmp/plexus-state
```

Close it:

```sh
plexus project close /path/to/project --workspace-id task-a --state-root /tmp/plexus-state
```

Start the routing gateway when agents need routed Pharo tools:

```sh
plexus-gateway
```

Run MCP surfaces directly when integrating with an agent runner:

```sh
plexus mcp project
plexus mcp project --http --port 7332
plexus mcp pharo-launcher --project-path /path/to/project --workspace-id task-a --state-root /tmp/plexus-state
```

The shared state root should be the same for sibling worktrees so PLexus can
avoid image-name and port collisions.

## Common Workflows

Open, inspect, and close one target:

```sh
plexus project open <project-root> --workspace-id <workspace-id> --state-root <state-root>
plexus project status <project-root> --workspace-id <workspace-id> --state-root <state-root>
plexus project close <project-root> --workspace-id <workspace-id> --state-root <state-root>
```

Expose project lifecycle tools to an agent:

```sh
plexus mcp project
```

For remote or service use, keep stdio local and serve the same lifecycle tools
over Streamable HTTP MCP:

```sh
plexus mcp project --http --host 127.0.0.1 --port 7332 --mcp-path /mcp
```

Expose scoped launcher tools for one project/workspace:

```sh
plexus mcp pharo-launcher --project-path <project-root> --workspace-id <workspace-id> --state-root <state-root>
```

Start one gateway process with separate MCP paths:

```sh
plexus-gateway
```

In HTTP service mode, `/mcp` serves the agent-facing `pharo_gateway` MCP server
and `/control-mcp` is the trusted route-control surface. Both paths share the
same in-memory route table.

## Safety Notes

PLexus keeps orchestration state outside images so a broken image can be
stopped, replaced, or rescued without losing the runtime control plane.

Image creation, copying, launching, deletion, rescue application, Docker-backed
checks, and GUI-adjacent Pharo Launcher work are live runtime mutations. Run
them only inside an approved runner boundary with a disposable image policy and
cleanup plan.

Do not expose route-control tools to normal implementation workers. Agents
should receive `plexus_project`, scoped `pharo-launcher`, and agent-facing
`pharo_gateway` surfaces; route registration and cleanup belong to PLexus core
or a trusted operator.

Use native absolute paths for the host running PLexus. Generated PLexus and
agent MCP configuration preserves Windows-style paths such as
`C:\path\to\worktree` and POSIX-style paths such as `/path/to/worktree`.

## Documentation

- [Getting Started](docs/user/getting-started.md) gives the first-use path.
- [Runtime Model](docs/user/runtime-model.md) explains projects, workspaces,
  targets, images, routes, and state roots.
- [Agent Pharo Access](docs/user/agent-pharo-access.md) describes the scoped
  launcher and routed Pharo MCP workflow.
- [MCP Reference](docs/reference/mcp.md) lists the PLexus MCP surfaces and tool
  ownership.
- [Troubleshooting](docs/troubleshooting.md) covers route, image, port, and
  runtime-state failures.
- [Project Model](docs/project-model.md) is the detailed runtime vocabulary.
- [Architecture](docs/architecture.md) covers package and runtime boundaries.
- [Package Boundaries](docs/package-boundaries.md) covers dependency direction.
- [Development](docs/development.md) covers contributor commands and smokes.
- [Vibe Kanban Setup](docs/vibe-kanban-setup.md) covers optional Vibe runner
  integration.
