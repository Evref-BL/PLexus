# Commands

`plexus --help` lists the commands, and `plexus image <command> --help` says
what one takes:

```sh
plexus image create dev --template 14
plexus image start dev
plexus image stop dev --save
```

Every command takes `--home <dir>` (`PLEXUS_HOME`), `--scope <prefix>`
(`PLEXUS_SCOPE`), `--project <dir>`, `--telemetry` (`PLEXUS_TELEMETRY`, see
[Observability](observability.md)), and `--help`. The scope is `--scope`, else
`PLEXUS_SCOPE`, else the one the `--project` directory's name makes (see
[Images](images.md)), else none. `PHARO_LAUNCHER_DIR` names where Pharo
Launcher is installed, when it is not in its usual place for the platform.

## Results

A command prints what the library call of the same name answers, as JSON on
stdout, and exits 0. A refusal prints `{"ok":false,"code":...,"error":...}`
and exits 1: `code` is the refusal's `PlexusError` code, absent for an error
PLexus did not foresee, and `details`, when there, holds the pids, the pid or
the categories the refusal is about. A command line that cannot be read is
said on stderr with the command's usage, and exits 2. `plexus --version`
prints the version.

## Each command

- **templates** lists the launcher's templates with their category. A name in
  more than one category is marked `ambiguous`: a create from it takes the
  one in `Official distributions`, else in `Deprecated distributions`, and
  otherwise needs `--category`.
- **create** refuses a name that is taken, and never starts the image. It
  creates from the current stable Pharo unless given a template, which it
  finds as [Images](images.md#templates) says.
- **start** launches the image headless unless asked otherwise, and answers
  once its MCP server does, with its pid and endpoint, within 300 seconds
  unless `--timeout` says. An image a VM already runs, whose server wrote
  where it answers, is left as it is and answered the same way with
  `alreadyRunning: true`; one a VM runs that took no calls yet is refused
  (`starting`), and one that never will through PLexus too (`no-endpoint`).
  A start that finds another start at work on the image waits for it, within
  its own time. It fails as soon as the VM reports a failure or exits, naming
  the launcher's logs, which the launcher keeps for the image's last few
  starts. It never creates: a missing image is refused.
- **stop** does not save: the image starts again as it was last saved. The
  image is asked to quit, by evaluating `Smalltalk snapshot: false andQuit:
  true` with the `evaluate` tool its MCP server lists, so that it does what it
  does before it goes, such as sending the telemetry it still holds; every VM
  still running it a few seconds later is killed, as is one that takes no
  calls. With `--save`, the image saves itself and quits instead, by
  evaluating `Smalltalk snapshot: true andQuit: true` with the same tool; the
  stop answers once its VM is gone and its image file was written. An image
  that does not save and quit in time is left running, and so is one that
  takes no calls or lists no evaluate tool. Evaluating `Smalltalk saveSession`
  in the image saves it without stopping it. An image that is not running is
  already stopped, and one a create is still making is refused.
- **delete** removes the image's directory and the launcher's logs of its
  starts, and refuses while a VM runs it or a create or a start is still at
  work on it.
- **list** shows each image, its state, its pids, its endpoint, its
  template, Pharo version, how MCP got into it, and whether it records its
  calls when that is known (see [Observability](observability.md)). It pings
  nothing and writes nothing. The state is `creating` (a create is still at
  work), `unfinished` (the create that made it ended before it was done, and
  only delete takes it), `stopped`, `starting` (a start of this PLexus
  launched it and its server has not said where it answers yet), `running`,
  or `unreachable` (a VM runs it and it takes no calls through PLexus,
  `endpointProblem` says why). A call to a starting image is refused with the
  code `starting`, to an unreachable one with `no-endpoint`.
