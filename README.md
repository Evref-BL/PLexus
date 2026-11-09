# PLexus

PLexus manages Pharo image lifecycle and forwards MCP calls to MCP servers
running in those images.

It keeps image state and gateway routes outside the images, so an image can be
started, stopped, replaced, or recovered independently of its MCP server. An
image binds its own MCP port and hands the endpoint back to PLexus, so no port
is reserved before the image is running.

## Packages

- `@evref-bl/plexus` manages project images and their lifecycle.
- `@evref-bl/plexus/gateway` forwards MCP calls to the image MCP servers it discovers.

The gateway is independent of project configuration. It is given the places to
look — a project root and the state file under it — and resolves a route from
what it finds there when the call arrives. Nothing registers a route, so none
can go stale between the call that started an image and the call that uses it.

## Use it as a library

A caller inside Node does not have to speak MCP to PLexus. The lifecycle is
functions:

```ts
import { loadProjectState, startProjectImage, stopProjectImage } from "@evref-bl/plexus";
```

Everything reachable from the package root is API and moves under semver.
`@evref-bl/plexus/internal` reaches the working parts and promises nothing:
names, shapes and whole modules there may change in any release, including a
patch. A consumer that needs something from it should ask for that name to be
promoted to the root rather than import it from there.

`@evref-bl/plexus/gateway` is the forwarding surface, for a host that embeds
the gateway instead of spawning `plexus-gateway`.

## Concepts

- A **project** is a directory with `plexus.json`.
- A **workspace** is an isolated runtime instance of that project, usually the
  folder the caller runs in. A project and a workspace together name one route.
- An **imageId** identifies an image managed by PLexus.
- An **mcpServerId** identifies one forwarded MCP server. An image can register
  more than one server, including servers on different ports.
- A **state root** holds one workspace's runtime state: its `.plexus` directory
  unless `--state-root` names another. Two workspaces never share one.

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

Create `plexus.json` at the project root:

```json
{
  "id": "sample-project",
  "name": "SampleProject",
  "images": [
    {
      "id": "dev",
      "imageName": "SampleProject-{workspaceId}-dev",
      "git": { "transport": "ssh" },
      "mcp": { "loadPolicy": "ifMissing" }
    }
  ]
}
```

PLexus loads a pinned MCP-Pharo release when it needs the standard Pharo MCP
server, so most projects name no load script at all. A project that wants to
control the load points `mcp.loadScript` at a Smalltalk file of its own,
relative to the project root.

Which images an open starts comes from the request, not from the file: a
command names the image it acts on.

## Images

The image is the unit of work. Each command acts on one image the project
declares, taking the project from `--project-path`, `PLEXUS_PROJECT_ROOT` or
the working directory:

```sh
plexus image list
plexus image create <image-id>
plexus image start <image-id>
plexus image stop <image-id>
plexus image delete <image-id>
```

Starting is refused while anything already runs that image, and deleting is
refused while it is running: two VMs saving one image file overwrite each
other.

For an agent, the same operations arrive over MCP, alongside the tools of
whichever image is running:

```sh
plexus mcp
```

That is the front door. The agent host starts it, the project comes from the
working directory, and nothing has to be running first:

```json
{ "mcpServers": { "plexus": { "command": "plexus", "args": ["mcp"] } } }
```

The scoped launcher surface is also available on its own:

```sh
plexus mcp pharo-launcher --project-path <project-root> --workspace-id <workspace-id> --state-root <state-root>
```

The scoped `pharo-launcher` surface acts only on images this project declares.
It also answers two read-only discovery questions, so a client can learn which
templates a project may declare before writing `plexus.json`:

- `pharo_launcher_template_list` — templates available to this project scope,
  optionally filtered by `templateCategory`.
- `pharo_launcher_template_category_list` — the template categories.

Both prepare the scoped template catalogue the same way `pharo_launcher_image_create`
does, and neither reads or changes image state.

## Gateway forwarding

Start the gateway with:

```sh
plexus-gateway
```

Its HTTP mode has two MCP paths backed by one route table:

- `/mcp` forwards typed Pharo MCP calls by `mcpServerId`.
- `/control-mcp` reports what the gateway currently resolves, for PLexus
  lifecycle diagnostics.

`mcpServerId` is required for routed calls and names the image's MCP server.
Nothing registers a route: the gateway reads the project state file and the
endpoint handoff each image writes, when the call arrives.

Normal forwarding clients only call the `/mcp` surface.
