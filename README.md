# PLexus

PLexus makes, starts, stops and deletes Pharo images that answer MCP, and
forwards tool calls to a running one.

## Images are directories, running images are processes

- **An image is a directory** of PLexus's Pharo Launcher profile:
  `$PLEXUS_HOME/profiles/images/<name>/<name>.image`, with `PLEXUS_HOME`
  defaulting to `~/.plexus`. It exists when that file does. Nothing declares
  it first and nothing remembers it after.
- **A running image is a process**: a VM whose command line names that image
  file, compared on the real path. Every call asks the host's process list
  once, the way `ps` does, so an answer is as old as the call that gave it.
  Nothing tells PLexus that a VM stopped, so nothing records that one started.
- **A scope is a name prefix.** With scope `Proj`, image `dev` is the directory
  `Proj-dev`, and only `Proj-` directories are listed, without the prefix.
  PLexus stores no scope: the caller passes one, and without one every image is
  listed.

An image keeps what PLexus knows about it in `<image>/plexus/`, which goes
with it:

| File | Written | Read |
| --- | --- | --- |
| `created.properties` | by create: template, category, how MCP got in, PLexus version | by list |
| `on-start` | by create with `--every-start`: the script to file in | by every start, before MCP starts |
| `endpoint.properties` | by the running VM: the port it bound and its pid | by list and forwarding, while that pid runs the image |
| `start.st`, `start-status.properties`, `launch.lock` | during a start | by that start |
| `building` | while a create with a script prepares the image | by list and start |

## Commands

```sh
plexus image templates
plexus image create <name> --template <t> [--category <c>] [--script <file> [--every-start]]
plexus image start <name> [--display interactive] [--timeout <seconds>]
plexus image stop <name>
plexus image delete <name>
plexus image list [<name>]
plexus mcp
```

Every command takes `--home <dir>` (`PLEXUS_HOME`) and `--scope <prefix>`
(`PLEXUS_SCOPE`), and `--help`. Results are JSON on stdout; a refusal is
`{"ok":false,"code":...,"error":...}` with exit status 1.

- **templates** lists the launcher's templates with their category. A name in
  more than one category is marked `ambiguous`, and a create from it must say
  which.
- **create** refuses a name that is taken, and never starts the image.
- **start** launches the image headless unless asked otherwise, and answers
  once its MCP server does, with its pid and endpoint. It refuses an image a VM
  already runs, and fails as soon as the VM reports a failure or exits, naming
  the launcher's logs. It never creates: a missing image is refused.
- **stop** kills every VM running the image. A kill does not save, so an agent
  that wants the image saved saves it through the image first. An image that is
  not running is already stopped.
- **delete** removes the image's directory, and refuses while a VM runs it.
- **list** shows each image, whether it runs, its pids, its endpoint, its
  template, Pharo version and how MCP got into it. It pings nothing and writes
  nothing.

## MCP in an image

Without a script, an image is a copy of a **base**: its template with the MCP
release PLexus pins loaded and saved. The first create from a template builds
the base, which takes minutes; later creates copy it, cloning blocks where the
filesystem can. A base is a directory of `$PLEXUS_HOME/bases` named after its
template, category and pin. It is built under a temporary name and renamed
when complete, so its existence is its record, and the bases of other pins are
removed when one is built.

With `--script`, the image is built from the template and the script is filed
in once instead, which is how an image gets MCP from a checkout or an older
Pharo gets a version that loads on it. With `--every-start` as well, every
start files the script in again before the server starts, so an image follows
the checkout it loads from.

## `plexus mcp`

A stdio MCP server for an agent host, in the scope given when it starts:

```json
{ "mcpServers": { "plexus": { "command": "plexus", "args": ["mcp", "--scope", "MyProject"] } } }
```

It offers `image_templates`, `image_create`, `image_start`, `image_stop`,
`image_delete` and `image_list`, followed by the tools of every image in scope
that runs with an endpoint. Each of those takes an `image` argument naming the
image to call; it may be left out while one image runs. After a start, a stop
or a delete, the server tells the host its tool list changed.

## Library

```ts
import { Images, callTool, listTools } from "@evref-bl/plexus";

const images = new Images({ scope: "MyProject" });
await images.create("dev", { template: "Pharo 14.0 - 64bit" });
await images.start("dev");
const tools = await listTools(await images.endpoint("dev"));
await images.stop("dev");
```

Everything reachable from the package root is API and moves under semver.
Refusals are `PlexusError`s whose `code` says which.

## Development

Requires Node.js 22.12 or newer, and Pharo Launcher for anything that runs an
image.

```sh
npm install
npm run check            # typecheck, build, unit tests
npm run verify:env       # where the launcher was found
npm run smoke:start-route-stop -- --template "Pharo 14.0 - 64bit"
```

The smoke runs a real image through create, start, a tool listing, stop and
delete, in a scratch scope of its own (`plexus-smoke-<run>`), so it never names
an image anyone works in. It is not part of `npm run check`.
