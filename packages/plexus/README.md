# PLexus

`@evref-bl/plexus` orchestrates project-scoped Pharo runtimes: opening and
closing project images, and forwarding MCP calls to the servers they run.

It is a command-line application and a library. The lifecycle is reachable as
functions, so a caller inside Node does not have to round-trip through MCP to
use it.

```sh
npm install --global @evref-bl/plexus
plexus --help
```

```ts
import { loadProjectState, startProjectImage, stopProjectImage } from "@evref-bl/plexus";
```

Everything reachable from the package root is API. `@evref-bl/plexus/internal`
reaches the working parts and promises nothing. `@evref-bl/plexus/gateway` is
the forwarding surface for a host that embeds the gateway.

Configuration and MCP usage are documented at
https://github.com/Evref-BL/PLexus.
