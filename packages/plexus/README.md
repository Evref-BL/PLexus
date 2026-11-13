# PLexus

`@evref-bl/plexus` makes, starts, stops and deletes Pharo images that answer
MCP, and forwards tool calls to a running one. An image is a directory, a
running image is a VM process on its image file, and every call looks at both
when it is made.

It is a command and a library:

```sh
npm install --global @evref-bl/plexus
plexus --help
```

```ts
import { Images, callTool, listTools } from "@evref-bl/plexus";
```

Everything reachable from the package root is API. The model, the commands
and `plexus mcp` are documented at https://github.com/Evref-BL/PLexus.
