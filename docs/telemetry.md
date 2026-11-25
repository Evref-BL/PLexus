# Telemetry

PLexus traces its work through the OpenTelemetry API, which records nothing
until the program running PLexus installs an SDK:

- each request forwarded to an image is a CLIENT span named after its method
  and tool (`tools/call class_get`), with the attributes of the OpenTelemetry
  MCP conventions, the request's id (`jsonrpc.request.id`) and the image's
  address and port (`server.address`, `server.port`) among them, and passes
  its trace context to the image in the request's
  `params._meta` (`traceparent`, `tracestate`, `baggage`); a request a call
  of `plexus mcp` forwards carries that call's `session.id` in its baggage.
  The request asking an image to quit, for a stop or a stop that saves, does
  not fail its span when the image closes the connection or does not answer
  in time, since quitting is what it asked;
- making, starting, stopping and deleting an image are INTERNAL spans,
  `plexus.image.create`, `.start`, `.stop` and `.delete`;
- each tool call `plexus mcp` serves is a SERVER span, `tools/call <tool>`,
  child of the trace context its `_meta` carries, with `jsonrpc.request.id`,
  `session.id`,
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

A span records names, outcomes and an error's kind (`error.type`); a span a
JSON-RPC error failed has its message as the status description. A JSON-RPC
error's code is `rpc.status_code`: it fails a request PLexus forwards, whatever
the code, while a call `plexus mcp` serves that throws is not its error when
the code says the request was the caller's fault (`-32700`, `-32600`,
`-32601`, `-32602`, `-32002`), as the conventions ask of a server. A tool
call's arguments and result (`gen_ai.tool.call.arguments`, and
`gen_ai.tool.call.result` when the call succeeded, each as JSON) are recorded
only when the conventions' switch turns content on:
`OTEL_INSTRUMENTATION_GENAI_CAPTURE_CONTENT` set to `SPAN_ONLY` or
`SPAN_AND_EVENT`, in any case. It is off by default, and for any other value.

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
