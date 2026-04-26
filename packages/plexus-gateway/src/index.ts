#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export * from "./gateway.js";
export * from "./imageMcpRouter.js";
export * from "./pharoFacade.js";
export * from "./routingTable.js";
export * from "./server.js";

import { startGatewayServerFromCli } from "./server.js";

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
  startGatewayServerFromCli().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
