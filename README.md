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
  A scope holds no dash, so the first dash of a directory name ends its scope:
  `shop` never lists `shop_api-dev`, which is `shop_api`'s. PLexus stores no
  scope: the caller passes one, and without one every image is listed.

An image keeps what PLexus knows about it in `<image>/plexus/`, which goes
with it:

| File | Written | Read |
| --- | --- | --- |
| `created.properties` | by create: template, category, how MCP got in, PLexus version | by list |
| `on-start` | by create with `--every-start`: the script to file in | by every start, before MCP starts |
| `endpoint.properties` | by the running VM: the port it bound and its pid | by list and forwarding, while that pid runs the image |
| `start.st`, `start-status.properties`, `launch.lock` | during a start | by that start |
| `building` | by a create with a script, naming its process, until the image is ready | by list, start and delete |

A create with a script builds the image under a name of its own and renames it
in with `building`, which start refuses. While that create runs, delete
refuses the image too; once its process is gone, delete is how the unfinished
image goes. What a PLexus that was killed left elsewhere, a base it was
building or a directory it was copying or removing, is named after its
process, and the next create removes it.

## Commands

```sh
plexus image templates
plexus image create <name> --template <t> [--category <c>] [--script <file> [--every-start]]
plexus image start <name> [--display interactive] [--timeout <seconds>]
plexus image stop <name> [--save]
plexus image delete <name>
plexus image list [<name>]
plexus mcp
```

Every command takes `--home <dir>` (`PLEXUS_HOME`), `--scope <prefix>`
(`PLEXUS_SCOPE`), `--telemetry` (`PLEXUS_TELEMETRY`, see
[Telemetry](#telemetry)), and `--help`. Results are JSON on stdout; a refusal is
`{"ok":false,"code":...,"error":...}` with exit status 1.

- **templates** lists the launcher's templates with their category. A name in
  more than one category is marked `ambiguous`, and a create from it must say
  which.
- **create** refuses a name that is taken, and never starts the image.
- **start** launches the image headless unless asked otherwise, and answers
  once its MCP server does, with its pid and endpoint. It refuses an image a VM
  already runs, and fails as soon as the VM reports a failure or exits, naming
  the launcher's logs. It never creates: a missing image is refused.
- **stop** kills every VM running the image. A kill does not save: the image
  starts again as it was last saved. With `--save`, the image saves itself and
  quits instead, by evaluating `Smalltalk snapshot: true andQuit: true` through
  its MCP server, and the stop answers once its VM is gone and its image file
  was written; an image that does not save and quit in time is left
  running, and so is one that takes no calls. Evaluating `Smalltalk saveSession`
  in the image saves it without stopping it. An image that is not running is
  already stopped.
- **delete** removes the image's directory, and refuses while a VM runs it or
  a create or a start is still at work on it.
- **list** shows each image, whether it runs, its pids, its endpoint, its
  template, Pharo version and how MCP got into it. It pings nothing and writes
  nothing.

## MCP in an image

Without a script, an image is a copy of a **base**: its template with the MCP
release PLexus pins loaded and saved. The first create from a template builds
the base, which takes minutes; later creates copy it, cloning blocks where the
filesystem can. A base is a directory of `$PLEXUS_HOME/bases` named after its
template, category and pin, and whether it holds MCP's `Telemetry` group. It
is built under a temporary name and renamed when complete, so its existence is
its record, and the bases of other pins are removed when one is built.

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

Its own tools answer in plain text, for a model: what happened first, then
what it found. A refusal, a call whose arguments break the tool's schema
among them, is an error result that says what happened and what to do. A
forwarded call waits as long as the call's own time limit allows, and at least
a minute; whatever the image answers passes through as it is, and a call that
gets no answer says what became of the image.

## Telemetry

PLexus traces its work through the OpenTelemetry API, which records nothing
until the program running PLexus installs an SDK:

- each request forwarded to an image is a CLIENT span named after its method
  and tool (`tools/call class_get`), with the attributes of the OpenTelemetry
  MCP conventions, and passes its trace context to the image in the request's
  `params._meta` (`traceparent`, `tracestate`, `baggage`);
- making, starting, stopping and deleting an image are INTERNAL spans,
  `plexus.image.make`, `.start`, `.stop` and `.delete`;
- `plexus mcp` handles each request in the trace context its `_meta` carries.

A span records names, outcomes and an error's kind (`error.type`), never an
argument, a result, a message, an image's name or a path.

The `plexus` command installs an SDK when the standard environment asks for an
OTLP traces exporter: `OTEL_EXPORTER_OTLP_ENDPOINT` or
`OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` is set, `OTEL_TRACES_EXPORTER` is unset or
`otlp`, and `OTEL_SDK_DISABLED` is not `true`. It sends over HTTP, protobuf
unless `OTEL_EXPORTER_OTLP_PROTOCOL` is `http/json`; it does not send over
gRPC. Its resource is `service.name` (`plexus`), `service.version`, `os.type`
and what `OTEL_RESOURCE_ATTRIBUTES` adds, without the host and process
detectors. A `TRACEPARENT` in its environment is the parent of what it does.
The export timeout is two seconds unless `OTEL_EXPORTER_OTLP_TIMEOUT` says
otherwise. A command waits for its spans one second at most, or the export
timeout when it is shorter; `plexus mcp` exports its batches in the background
with the whole export timeout. A command's answer, output and exit status never
depend on its spans, and telemetry prints nothing. The SDK packages are
optional dependencies: installed without them, the command runs untraced.

A collector that cannot be reached is remembered, so that it costs a command
nothing:

- the state lives in `$XDG_CACHE_HOME/plexus/otel-reachability.json`, by
  default `~/.cache/plexus/otel-reachability.json`, and
  `%LOCALAPPDATA%\plexus\otel-reachability.json` on Windows, keyed by the
  traces endpoint;
- a failed export leaves the endpoint alone five minutes, doubling with each
  failure in a row up to six hours; a successful export clears it;
- while the endpoint is left alone, the command loads no SDK and sends
  nothing, and a process that failed sends nothing more until then; the spans
  of that time are dropped;
- a state file that cannot be read or written is no state.

`--telemetry`, or `PLEXUS_TELEMETRY` set to `1` or `true`, or the library's
`telemetry` option, enrolls the images PLexus handles in OpenTelemetry:

- a create without a script loads MCP's `Telemetry` group beside the rest,
  into a base of its own; a create with a script loads what its script loads;
- a start switches the image's MCP server to its OpenTelemetry backend when it
  has one, and starts it as it is otherwise. The VM runs in PLexus's
  environment, so the image reads the same `OTEL_*` variables.

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

`imageToolAnswers` renders the answers of `plexus mcp`'s image tools, checks
their arguments and says what a failed forwarded call did, for a server that
offers the same tools.

## Development

Requires Node.js 22.15 or newer, and Pharo Launcher for anything that runs an
image.

```sh
npm install
npm run check            # typecheck, build, unit tests
npm run verify:env       # where the launcher was found
npm run smoke:start-route-stop -- --template "Pharo 14.0 - 64bit"
```

The smoke runs a real image through create, start, a tool listing, a stop
that saves, a start that finds what was saved, stop and delete, in a scratch
scope of its own (`plexus_smoke_<run>`), so it never names
an image anyone works in. It is not part of `npm run check`.
