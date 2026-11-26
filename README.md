# PLexus

PLexus makes, starts, stops and deletes Pharo images that answer MCP, and
forwards tool calls to a running one.

An image is a directory, a running image is a VM process on its image file,
and every call looks at both when it is made.

## Requirements

- Node.js 22.15 or later.
- [Pharo Launcher](https://pharo-project.github.io/pharo-launcher/), which is
  where templates and VMs come from, in its usual place for the platform or
  where `PHARO_LAUNCHER_DIR` says.
- Network access to create an image: the template list, the templates and MCP
  are downloaded.

## Install

```sh
npm install --global @evref-bl/plexus
```

## Use

`plexus mcp` is a stdio MCP server for an agent host. A host passes its
project directory, whose name scopes the images it sees:

```json
{ "mcpServers": { "plexus": { "command": "plexus", "args": ["mcp", "--project", "/path/to/MyProject"] } } }
```

It offers `image_templates`, `image_create`, `image_start`, `image_stop`,
`image_delete` and `image_list`, followed by the tools of every running image
in its scope, each of which takes an `image` argument naming the image to
call.

The same work is a command, `plexus image templates`, `create`, `start`,
`stop`, `delete` and `list`, whose results are JSON; `plexus --help` says what
each takes. And a library:

```ts
import { Images, listTools } from "@evref-bl/plexus";

const images = new Images({ scope: "MyProject" });
await images.create("dev", { template: "Pharo 14.0 - 64bit" });
await images.start("dev");
const tools = await listTools(await images.endpoint("dev"));
await images.stop("dev");
```

## Documentation

- [Images](docs/images.md): what an image and a running image are, scopes,
  and how MCP gets into an image.
- [Commands](docs/commands.md): every command, its options, and what it
  answers.
- [`plexus mcp`](docs/mcp-server.md): the server's tools and their answers.
- [Observability](docs/observability.md): the spans PLexus records with
  OpenTelemetry, and its settings.
- [Library](docs/library.md): the library, and what semver covers.

## Development

```sh
npm install
npm run check            # typecheck, build, unit tests
npm run verify:env       # whether the launcher is usable
npm run smoke:start-route-stop -- --template "Pharo 14.0 - 64bit"
```

The smoke runs a real image through create, start, a tool listing, a stop
that saves, a start that finds what was saved, stop and delete, in a scratch
scope of its own (`plexus_smoke_<run>`), so it never names
an image anyone works in. It is not part of `npm run check`.
