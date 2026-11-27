# Library

```ts
import { Images, PlexusError, callTool } from "@evref-bl/plexus";

const images = new Images({ scope: "MyProject" });
try {
  await images.create("dev", { template: "14" });
} catch (error) {
  if (!(error instanceof PlexusError && error.code === "image-exists")) throw error;
}
await images.start("dev");
const answer = await callTool(await images.endpoint("dev"), "evaluate", { code: "3 + 4" });
await images.stop("dev", { save: true });
```

An `Images` reaches the images of its scope in its home, as
[Images](images.md) says, and each call looks at the store and the host when
it is made. A refusal is a `PlexusError`: its `code` says which, its message
what to do, and its `details` the pids, the pid or the categories it is about.

`callTool` and `listTools` call an image's endpoint in the newest MCP
revision PLexus speaks, and in a session when the image refuses it as only a
legacy server does. They reject with a `ForwardError`, whose `kind` says what
became of the call: the image answered it with an error (`answered`), never
got it (`no-handshake`, a legacy image's handshake unanswered, or `refused`), got it
and gave no answer in time (`timeout`) or closed the connection (`closed`),
its signal cancelled it (`cancelled`), or something else went wrong (`other`).

The library reads none of PLexus's environment variables: `home` is
`~/.plexus`, `launcherDir` Pharo Launcher's usual place for the platform, and
`telemetry` off, unless given. `plexusHome()` is where the `plexus` command
keeps its images, `PLEXUS_HOME` included, for a program that wants the same
store. OpenTelemetry reads its own: the spans follow
`OTEL_INSTRUMENTATION_GENAI_CAPTURE_CONTENT`, and an image starts with the
program's environment, `OTEL_*` included (see
[Observability](observability.md)).

## What semver covers

- the library: everything reachable from the package root, types included;
- the `plexus` command: its commands, options, environment variables, JSON
  results, exit statuses and refusal codes;
- `plexus mcp`'s image tools: their names and arguments. Their answers are
  text for a model, whose wording may change in any release.

A minor release may add a refusal code, an image state, a telemetry reason, a
`ForwardError` kind or an optional field, so a program that switches on one
keeps a branch for the others.

The spans PLexus records follow OpenTelemetry's semantic conventions for MCP
and generative AI, which are still in development: a minor release may follow
a change of theirs, and says so in its notes.

It does not cover the tools an image offers. Their names and arguments come
from the MCP release the image holds, and a minor release of PLexus may pin a
new MCP major, which the images it creates then hold.
