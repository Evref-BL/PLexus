#!/usr/bin/env node
import { runCli } from "./commandLine.js";
import { startTelemetry } from "./telemetry/sdk.js";
import { applySettingsFile, quietImageDiagnostics } from "./telemetry/settings.js";

const argv = process.argv.slice(2);
// Joining the tools' telemetry writes the settings file; it enrolls the
// images this command handles too, unless PLEXUS_TELEMETRY says otherwise.
if (Object.keys(applySettingsFile(process.env)).length > 0 && process.env.PLEXUS_TELEMETRY === undefined) {
  process.env.PLEXUS_TELEMETRY = "1";
}
quietImageDiagnostics(process.env);
const telemetry = await startTelemetry(process.env, { longLived: argv[0] === "mcp" });

/**
 * Ends the process once a command is done, `plexus mcp`'s host has closed its
 * input, or a signal came: what is left of its spans goes within the bound
 * shutdown keeps, and it exits once stdout has taken what was written. It
 * does not wait for the event loop to empty, which an export still connecting
 * to a collector that does not answer would keep from happening for minutes.
 */
let ending = false;
function end(code: number): void {
  if (ending) return;
  ending = true;
  process.exitCode = code;
  void telemetry.shutdown().finally(() => process.stdout.write("", () => process.exit(code)));
}
for (const [signal, code] of [["SIGTERM", 143], ["SIGINT", 130]] as const) {
  process.once(signal, () => end(code));
}

telemetry
  .within(() =>
    runCli(argv, {
      stdout: (text) => process.stdout.write(text),
      stderr: (text) => process.stderr.write(text),
      env: process.env,
    }),
  )
  .then(end, (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    end(1);
  });
