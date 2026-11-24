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
  The one exception is a call `plexus mcp` forwards: it goes without asking
  while the VM an earlier look of the same server saw answering for the image
  still runs, and the endpoint files name no other image that answers.
- **A scope is a name prefix.** With scope `Proj`, image `dev` is the directory
  `Proj-dev`, and only `Proj-` directories are listed, without the prefix.
  A scope holds no dash, so the first dash of a directory name ends its scope:
  `shop` never lists `shop_api-dev`, which is `shop_api`'s. PLexus stores no
  scope: the caller passes one, and without one an image is named by its
  directory, so `shop-dev` is image `dev` of `shop`, and every image is
  listed.

An image keeps what PLexus knows about it in `<image>/plexus/`, which goes
with it:

| File | Written | Read |
| --- | --- | --- |
| `created.properties` | by create: template, category, how MCP got in, PLexus version, whether it records its calls | by list |
| `on-start` | by create with `--every-start`: the script to file in | by every start, before MCP starts |
| `endpoint.properties` | by the running VM: the port it bound, its pid, whether it records its calls | by list and forwarding, while that pid runs the image |
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
(`PLEXUS_SCOPE`), `--project <dir>`, `--telemetry` (`PLEXUS_TELEMETRY`, see
[Telemetry](#telemetry)), and `--help`. The scope is `--scope`, else
`PLEXUS_SCOPE`, else the name of the `--project` directory, with each run of
characters a scope cannot hold made one `_`, else none. Results are JSON on
stdout; a refusal is `{"ok":false,"code":...,"error":...}` with exit status 1.

- **templates** lists the launcher's templates with their category. A name in
  more than one category is marked `ambiguous`, and a create from it must say
  which.
- **create** refuses a name that is taken, and never starts the image.
- **start** launches the image headless unless asked otherwise, and answers
  once its MCP server does, with its pid and endpoint. An image whose server
  already answers is left as it is, and answered the same way with
  `alreadyRunning: true`; one a VM runs that does not answer is refused
  (`image-running`). It fails as soon as the VM reports a failure or exits,
  naming the launcher's logs, which the launcher keeps for the image's last
  few starts. It never creates: a missing image is refused.
- **stop** does not save: the image starts again as it was last saved. The
  image is asked to quit, by evaluating `Smalltalk snapshot: false andQuit:
  true` with the `evaluate` tool its MCP server lists, so that it does what it
  does before it goes, such as sending the telemetry it still holds; every VM
  still running it a few seconds later is killed, as is one that takes no
  calls. With `--save`, the image saves itself and quits instead, by
  evaluating `Smalltalk snapshot: true andQuit: true` with the same tool; the
  stop answers once its VM is gone and its image file was written. An image that does not save
  and quit in time is left running, and so is one that takes no calls or
  lists no evaluate tool. Evaluating `Smalltalk saveSession`
  in the image saves it without stopping it. An image that is not running is
  already stopped.
- **delete** removes the image's directory and the launcher's logs of its
  starts, and refuses while a VM runs it or a create or a start is still at
  work on it.
- **list** shows each image, its state, its pids, its endpoint, its
  template, Pharo version, how MCP got into it, and whether it records its
  calls when that is known (see [Telemetry](#telemetry)). It pings nothing and
  writes nothing. The state is `creating` (a create is still at work), `stopped`,
  `starting` (a start of this PLexus launched it and its server has not said
  where it answers yet), `running`, or `unreachable` (a VM runs it and it
  takes no calls through PLexus, `endpointProblem` says why). A call to a
  starting image is refused with the code `starting`, to an unreachable one
  with `no-endpoint`.

## MCP in an image

Without a script, an image is a copy of a **base**: its template with the MCP
release PLexus pins loaded and saved. The first create from a template builds
the base, which takes minutes; later creates copy it, cloning blocks where the
filesystem can. A base is a directory of `$PLEXUS_HOME/bases/shared` named
after its template, category and pin, and whether it holds MCP's `Telemetry`
group. It is built under a temporary name and renamed when complete, so its
existence is its record. Beside it, `<base>.used` holds when a create last
copied it, written before the copy.

Releases with other pins share the bases, as when an agent host runs an older
PLexus beside a newer one, so a base is never removed for its pin. A create
removes the bases no create has used for 30 days and, while the bases hold
more than 5 GiB, the least recently used first, but never one used within the
last day. PLexus 0.16 to 0.20 keep their bases directly in `$PLEXUS_HOME/bases`
and remove those of other pins there, which never reaches `shared`. The
bases there are neither copied nor removed.

A base forgets the Iceberg repositories its load cloned into the image's directory and
deletes their clones, so that a project loading MCP under another repository
spec, a fork or a branch, clones it anew.

Before anything loads, PLexus has Iceberg clone `github://` repositories over
HTTPS (`Iceberg remoteTypeSelector: #httpsUrl`), which a public repository
needs no credentials for; the image keeps that setting. An image whose
projects clone private repositories over SSH sets `#scpUrl` back.

With `--script`, the image is built from the template and the script is filed
in once instead, which is how an image gets MCP from a checkout or an older
Pharo gets a version that loads on it. With `--every-start` as well, every
start files the script in again before the server starts, so an image follows
the checkout it loads from.

## `plexus mcp`

A stdio MCP server for an agent host, in the scope given when it starts. A
host passes its project directory, whose name is the scope:

```json
{ "mcpServers": { "plexus": { "command": "plexus", "args": ["mcp", "--project", "/path/to/MyProject"] } } }
```

It offers `image_templates`, `image_create`, `image_start`, `image_stop`,
`image_delete` and `image_list`, followed by the tools of every image in scope
that runs with an endpoint. Each of those takes an `image` argument naming the
image to call; it may be left out while one image runs. A call naming no image
while several run goes to the only one that lists the tool, and is answered
that none has it when none does. After a start, a stop
or a delete, the server tells the host its tool list changed. Its instructions tell the host to search these tools for Pharo work,
that an image takes one writer, to stop an image once its work pauses, and to
propose deleting the images unused for a while. `image_stop` and
`image_delete` take one name or several: several are handled in turn, and the
answer says what each did and why any was not done.

Its own tools answer in plain text, for a model: what happened first, then
what it found. `image_list` gives each image one line under its state, running
images first, with only what differs from the usual: the template when it is
not the plain one of its Pharo version, the MCP when it is not the one images
are created with, and for a stopped image the day it was last used: the later
of its last start and its last save. A warning that holds for several images is said once, naming
them. A refusal, a call whose arguments break the tool's schema
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
  `params._meta` (`traceparent`, `tracestate`, `baggage`); a request a call
  of `plexus mcp` forwards carries that call's `session.id` in its baggage.
  The request asking an image to quit, for a stop or a stop that saves, does
  not fail its span when the image closes the connection or does not answer
  in time, since quitting is what it asked;
- making, starting, stopping and deleting an image are INTERNAL spans,
  `plexus.image.create`, `.start`, `.stop` and `.delete`;
- each tool call `plexus mcp` serves is a SERVER span, `tools/call <tool>`,
  child of the trace context its `_meta` carries, with `session.id`,
  `plexus.call.index`, `plexus.call.forwarded`, the host's `clientInfo` as
  `plexus.client.name` and `.version`, and the names of the arguments given
  that the tool declares (`plexus.argument.names`) and of the others
  (`plexus.argument.unknown_names`), an image's tool declaring the arguments
  its image lists and `image`. A call to an image whose tools the host has not
  listed fetches that listing beside it and, once answered, waits half a
  second at most for it; without it, only `image` is named. An error answer
  fails the span as `tool_error`:
  - `session.id` is random, kept by the server process, and renewed when a
    call comes after 30 minutes in which no call ran. Every span the call
    makes carries it, as does every span of a listing of the tools; every
    span of a command carries one random id of its process;
  - `plexus.call.index` is the call's place in its session, from 1;
  - `plexus.call.forwarded` is true for a call to an image's tool, false for
    one of the image tools;
  - `plexus.error.code` says why `plexus mcp` answered an error of its own,
    before any image saw the call: `invalid-arguments`, `no-image-running`,
    `several-images` (the call must name one), `none-takes-calls`, the
    `code` an image tool's refusal carries, as the command's do, or
    `_OTHER`.

A span records names, outcomes and an error's kind (`error.type`), never an
argument, a result, a message, an image's name, a path or an address.

The `plexus` command installs an SDK when the standard environment asks for an
OTLP traces exporter: `OTEL_EXPORTER_OTLP_ENDPOINT` or
`OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` is set, `OTEL_TRACES_EXPORTER` is unset or
`otlp`, and `OTEL_SDK_DISABLED` is not `true`. It sends over HTTP, protobuf
unless `OTEL_EXPORTER_OTLP_PROTOCOL` is `http/json`; it does not send over
gRPC. Its resource is `service.name` (`plexus`), `service.version`, `os.type`
and what `OTEL_RESOURCE_ATTRIBUTES` adds, without the host and process
detectors. A `TRACEPARENT` in its environment is the parent of what a command
does; `plexus mcp` takes a call's parent from its `_meta` alone.
The export timeout is two seconds unless `OTEL_EXPORTER_OTLP_TIMEOUT` says
otherwise, and `OTEL_BSP_SCHEDULE_DELAY`, `OTEL_BSP_MAX_QUEUE_SIZE` and
`OTEL_BSP_MAX_EXPORT_BATCH_SIZE` shape its batches. A command waits for its
spans one second at most, or the export timeout when it is shorter;
`plexus mcp` exports its batches in the background with the whole export
timeout, and sends what is left, within that second, when its input closes or
SIGTERM or SIGINT ends it. Either then exits, whatever an export still waits
on. A command's answer, output and exit status never depend on its spans, and
telemetry prints nothing. The SDK packages are
optional dependencies: installed without them, the command runs untraced.

A collector that cannot be reached is remembered, so that it costs a command
nothing:

- the state lives in `$XDG_CACHE_HOME/plexus/otel-reachability.json`, by
  default `~/.cache/plexus/otel-reachability.json`, and
  `%LOCALAPPDATA%\plexus\otel-reachability.json` on Windows, keyed by the
  traces endpoint;
- a failed export leaves the endpoint alone five minutes, doubling with each
  failure in a row up to six hours; a successful export clears it, as does a
  collector refusing the content (HTTP 400 or 413), which it was reached to
  do. An export that has not ended within the export timeout failed, though
  it may still be connecting or reading a slow answer; a command's export
  fails a little before the command stops waiting for it, so that its failure
  is remembered;
- while the endpoint is left alone, a command loads no SDK and sends nothing;
  `plexus mcp` installs its SDK anyway, and like any process that failed it
  sends nothing more until the time is over, and then sends again. The spans
  of that time are dropped;
- an endpoint on the loopback interface (`localhost`, `127.0.0.0/8`, `::1`)
  is never left alone: a collector on the same machine that is down costs a
  refused connection, and one that comes back gets the next batch;
- a state file that cannot be read or written is no state.

The `plexus` command reads its settings file,
`$XDG_CONFIG_HOME/plexus/otel.env`, by default `~/.config/plexus/otel.env`,
and `%APPDATA%\plexus\otel.env` on Windows: one `OTEL_NAME=value` per line,
lines ending in LF, CRLF or CR, read as a dotenv file is. A line starting with `#` is a comment, and so is
what follows a `#` that starts an unquoted value or follows a space in it; a
value in single or double quotes is what they hold. When the file gives a
setting, the command removes every `OTEL_*` variable it inherited and takes
the file's instead, so what reaches the collector is what the file says,
whatever started the command; without a file, or with no setting in it, the
environment decides. The settings join the command's environment, which the
images it starts inherit. Settings from that file also turn `--telemetry` on,
unless `PLEXUS_TELEMETRY` is set. The library reads no file.

`--telemetry`, or `PLEXUS_TELEMETRY` set to `1` or `true`, or the library's
`telemetry` option, enrolls the images PLexus handles in OpenTelemetry:

- a create without a script loads MCP's `Telemetry` group beside the rest,
  into a base of its own; when that base cannot be built, offline for one,
  the create copies the base without it, and the image is not traced. Creates
  then copy the base without it for a day before trying again, or until the
  pin changes. A create with a script loads what its script loads;
- a start switches the image's MCP server to its OpenTelemetry backend when it
  has one, and starts it as it is otherwise. The VM runs in PLexus's
  environment, so the image reads the same `OTEL_*` variables. The `plexus`
  command sets `OTEL_LOG_LEVEL` to `none` there unless it is set, so that the
  image's OpenTelemetry SDK writes nothing to the VM's output.

Whether an image records its calls, that is whether its MCP server records
them through its OpenTelemetry backend, is kept with it: a create writes it in
`created.properties`, and a start has the image write it in
`endpoint.properties`. Create, start and list carry it as `telemetry`,
`{"on":true}` or `{"on":false,"reason":...}`, for a running image what its
start said and otherwise what its create gave it, with a `detail` where there
is one. The reason is `not-asked` (made by a PLexus that did not enroll
images), `base-failed` (the base with the `Telemetry` group failed to build,
and `detail` says what failed), `no-backend` (its MCP has no OpenTelemetry
backend), or `switch-failed` (its server failed to switch, and `detail` says
why). Enrolled, `plexus mcp` says it too: `image_list` marks an image that
does not record its calls, and `image_create`, `image_start` and `image_list`
naming an image say that it records them, or why not and what makes it.
Recording is not sending: what an image sends, and where, its `OTEL_*`
settings decide. When the settings of `plexus mcp` name no OTLP endpoint, its
answers say that what an image records has nowhere named to go, instead of
`on`.

## Library

```ts
import { Images, callTool, listTools } from "@evref-bl/plexus";

const images = new Images({ scope: "MyProject" });
await images.create("dev", { template: "Pharo 14.0 - 64bit" });
await images.start("dev");
const tools = await listTools(await images.endpoint("dev"));
await images.stop("dev");
```

Refusals are `PlexusError`s whose `code` says which.

The library reads no environment variable: `home` is `~/.plexus` and
`telemetry` is off unless given. `plexusHome()` is where the `plexus` command
keeps its images, `PLEXUS_HOME` included, for a program that wants the same
store.

## What semver covers

- the library: everything reachable from the package root, types included;
- the `plexus` command: its commands, options, environment variables, JSON
  results and refusal codes;
- `plexus mcp`'s six image tools: their names and arguments. Their answers
  are text for a model, whose wording may change in any release.

It does not cover the tools an image offers. Their names and arguments come
from the MCP release the image holds, and a minor release of PLexus may pin a
new MCP major, which the images it creates then hold.

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
