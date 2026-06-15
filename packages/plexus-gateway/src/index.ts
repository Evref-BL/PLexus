#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export * from "./routing/gateway.js";
export * from "./routing/imageMcpRouter.js";
export * from "./routing/pharoFacade.js";
export * from "./routing/routingTable.js";
export * from "./mcp/server.js";
export * from "./support/sourceBuildPreflight.js";

import { startGatewayServerFromCli } from "./mcp/server.js";
import { assertFreshSourceBuildForEntrypoint } from "./support/sourceBuildPreflight.js";

function comparablePath(filePath: string): string {
  const resolvedPath = path.resolve(filePath);
  const realPath = fs.existsSync(resolvedPath)
    ? fs.realpathSync.native(resolvedPath)
    : resolvedPath;

  return process.platform === "win32" ? realPath.toLowerCase() : realPath;
}

const entrypointPath = process.argv[1]
  ? comparablePath(process.argv[1])
  : undefined;
const modulePath = comparablePath(fileURLToPath(import.meta.url));

if (entrypointPath && modulePath === entrypointPath) {
  assertFreshSourceBuildForEntrypoint(modulePath, {
    packageName: "@evref-bl/plexus-gateway",
    buildCommand: "npm run build",
  });

  startGatewayServerFromCli().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
