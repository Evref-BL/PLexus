# Library

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
