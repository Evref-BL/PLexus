# Commands

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
[Telemetry](telemetry.md)), and `--help`. The scope is `--scope`, else
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
  calls when that is known (see [Telemetry](telemetry.md)). It pings nothing and
  writes nothing. The state is `creating` (a create is still at work), `stopped`,
  `starting` (a start of this PLexus launched it and its server has not said
  where it answers yet), `running`, or `unreachable` (a VM runs it and it
  takes no calls through PLexus, `endpointProblem` says why). A call to a
  starting image is refused with the code `starting`, to an unreachable one
  with `no-endpoint`.
