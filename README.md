# PLexus

PLexus manages Pharo image lifecycle and forwards MCP calls to MCP servers
running in those images.

It keeps image state, port assignments, and gateway routes outside the images,
so an image can be started, stopped, replaced, or recovered independently of
its MCP server.

## Packages

- `@evref-bl/plexus` manages project images and their lifecycle.
- `@evref-bl/plexus-gateway` forwards MCP calls to registered image MCP servers.

The gateway is independent of project configuration. PLexus resolves image
state and registers server endpoints; the gateway stores those routes in memory
and forwards requests by `mcpServerId`.

## Concepts

- A **project** is a directory with `plexus.project.json`.
- A **workspace** is an isolated runtime instance of that project.
- An **imageId** identifies an image managed by PLexus.
- An **mcpServerId** identifies one forwarded MCP server. An image can register
  more than one server, including servers on different ports.
- A **state root** stores runtime state shared by PLexus processes on one host.

## Requirements

- Node.js 24 or newer
- Pharo Launcher for live image operations
- An image-local MCP server load script or prepared image

## Install and build

```sh
npm install
npm run build
```

## Project configuration

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
      "git": { "transport": "ssh" },
      "mcp": {
        "loadScript": "pharo/load-mcp.st",
        "loadPolicy": "ifMissing"
      }
    }
  ]
}
```

PLexus defaults to MCP-Pharo `v1.2.3` when it needs to load the standard Pharo
MCP server.

For a project-local gateway, configure paths under `runtime.gateway` with
`mcpPath` and `routeControlMcpPath`. A shared gateway uses `mcpUrl` and
`routeControlMcpUrl`.

## Lifecycle

```sh
plexus project open <project-root> --workspace-id <workspace-id> --state-root <state-root>
plexus project status <project-root> --workspace-id <workspace-id> --state-root <state-root>
plexus project close <project-root> --workspace-id <workspace-id> --state-root <state-root>
```

PLexus also exposes those operations over its `plexus_project` MCP surface:

```sh
plexus mcp project
plexus mcp pharo-launcher --project-path <project-root> --workspace-id <workspace-id> --state-root <state-root>
```

## Gateway forwarding

Start the gateway with:

```sh
plexus-gateway
```

Its HTTP mode has two MCP paths backed by one route table:

- `/mcp` forwards typed Pharo MCP calls by `mcpServerId`.
- `/control-mcp` registers, inspects, and removes routes for PLexus lifecycle
  operations.

`mcpServerId` is required for routed calls. It names a server endpoint, not an
image: `dev-code` and `dev-tools` can both belong to image `dev` while using
different ports.

Image MCP ports and routes are lifecycle diagnostics. Route registration belongs
to PLexus and gateway control; normal forwarding clients only call the `/mcp`
surface.
