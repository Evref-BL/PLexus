#!/usr/bin/env node
import { runCli } from "./commandLine.js";
import { startTelemetry } from "./telemetry/sdk.js";
import { applySettingsFile } from "./telemetry/settings.js";

const argv = process.argv.slice(2);
// Joining the tools' telemetry writes the settings file; it enrolls the
// images this command handles too, unless PLEXUS_TELEMETRY says otherwise.
if (Object.keys(applySettingsFile(process.env)).length > 0 && process.env.PLEXUS_TELEMETRY === undefined) {
  process.env.PLEXUS_TELEMETRY = "1";
}
const telemetry = await startTelemetry(process.env, { longLived: argv[0] === "mcp" });
// Once nothing is left to do: after a command, or when `plexus mcp`'s host
// closes its input.
process.once("beforeExit", () => void telemetry.shutdown());

telemetry
  .within(() =>
    runCli(argv, {
      stdout: (text) => process.stdout.write(text),
      stderr: (text) => process.stderr.write(text),
      env: process.env,
    }),
  )
  .then(
    (exitCode) => {
      process.exitCode = exitCode;
    },
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
