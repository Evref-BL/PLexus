/**
 * PLexus's telemetry settings file: `KEY=value` lines of standard OTEL_*
 * variables, read when the environment sets none. Agent hosts do not pass
 * OTEL_* to the servers they start, so a variable set in a shell never
 * reaches `plexus mcp`; the file does. Applied to the process's environment,
 * they reach the images it starts too, which read only their environment.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Where the settings live. */
export function settingsFile(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = os.homedir(),
): string {
  const paths = platform === "win32" ? path.win32 : path.posix;
  const xdg = env.XDG_CONFIG_HOME;
  if (xdg && paths.isAbsolute(xdg)) return paths.join(xdg, "plexus", "otel.env");
  if (platform === "win32" && env.APPDATA) return paths.join(env.APPDATA, "plexus", "otel.env");
  return paths.join(home, ".config", "plexus", "otel.env");
}

const settingName = /^OTEL_[A-Z0-9_]+$/;

/**
 * The OTEL_* settings a file's lines give. Blank lines and `#` comments are
 * skipped, as are a leading `export` and quotes around a value; any other
 * key is not ours to set.
 */
export function parseSettings(text: string): Record<string, string> {
  const settings: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim().replace(/^export\s+/, "");
    if (line === "" || line.startsWith("#")) continue;
    const equals = line.indexOf("=");
    if (equals === -1) continue;
    const key = line.slice(0, equals).trim();
    if (!settingName.test(key)) continue;
    let value = line.slice(equals + 1).trim();
    const quoted = value.match(/^(["'])(.*)\1$/s);
    if (quoted) value = quoted[2];
    settings[key] = value;
  }
  return settings;
}

/**
 * Puts the file's settings into the environment, unless it already sets an
 * OTEL_* of its own: whoever set one there meant the environment to decide.
 * The images PLexus starts run in this environment, so they read the same
 * settings. Answers what it set; nothing when there is no file.
 */
export function applySettingsFile(
  env: NodeJS.ProcessEnv = process.env,
  file: string = settingsFile(env),
): Record<string, string> {
  if (Object.keys(env).some((key) => key.startsWith("OTEL_"))) return {};
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return {};
  }
  const settings = parseSettings(text);
  Object.assign(env, settings);
  return settings;
}

/**
 * Turns the OpenTelemetry SDK's own diagnostics off for the images PLexus
 * starts, unless the environment sets a level: they run in this environment,
 * and opentelemetry-pharo writes its diagnostics to the VM's standard output,
 * as `OTEL_LOG_LEVEL` allows. Applied after the settings file, so that a
 * level the file sets is the one kept.
 */
export function quietImageDiagnostics(env: NodeJS.ProcessEnv = process.env): void {
  env.OTEL_LOG_LEVEL ??= "none";
}
