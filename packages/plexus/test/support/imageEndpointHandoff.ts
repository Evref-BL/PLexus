import fs from "node:fs";
import path from "node:path";

const endpointFilePattern = /endpointFile := '([^']*)' asFileReference\./;
const requestedPortPattern = /mcp port: (\d+)\./;

/**
 * Stand in for the image: write the endpoint handoff file a generated startup
 * script names, with the port that script asks the MCP server to bind. A real
 * image binds port 0 to whatever the OS hands it, so a script that asks for 0
 * reports `boundPort` instead.
 */
export function writeImageEndpointHandoffForScript(
  scriptPath: unknown,
  options: { boundPort?: number; overwrite?: boolean } = {},
): string | undefined {
  if (typeof scriptPath !== "string" || !fs.existsSync(scriptPath)) {
    return undefined;
  }

  const script = fs.readFileSync(scriptPath, "utf8");
  const endpointFile = endpointFilePattern.exec(script)?.[1];
  if (!endpointFile) {
    return undefined;
  }
  if (!options.overwrite && fs.existsSync(endpointFile)) {
    return endpointFile;
  }

  const requestedPort = Number(requestedPortPattern.exec(script)?.[1] ?? 0);
  const port = requestedPort === 0 ? (options.boundPort ?? 7432) : requestedPort;
  fs.mkdirSync(path.dirname(endpointFile), { recursive: true });
  fs.writeFileSync(
    endpointFile,
    `transport=http\nhost=127.0.0.1\nport=${port}\npath=/\n`,
    "utf8",
  );

  return endpointFile;
}
