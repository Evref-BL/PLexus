/**
 * PLexus's telemetry settings file: `KEY=value` lines of standard OTEL_*
 * variables. When it gives settings, they replace every OTEL_* the process
 * inherited: an agent host passes its whole environment to the servers it
 * starts, its own OpenTelemetry settings among them, and those are the host's,
 * not PLexus's. Applied to the process's environment, they reach the images it
 * starts too, which read only their environment.
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
 * The OTEL_* settings a file's lines give, as a dotenv file reads. Blank
 * lines and `#` comments are skipped, as is a leading `export`. A value in
 * single or double quotes is what they hold, `#` included, and may be followed
 * by a comment; any other value ends where a `#` begins it or follows
 * whitespace. Any other key is not ours to set.
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
    settings[key] = settingValue(line.slice(equals + 1));
  }
  return settings;
}

function settingValue(text: string): string {
  const value = text.trim();
  const quote = value[0];
  if (quote === '"' || quote === "'") {
    const end = value.indexOf(quote, 1);
    if (end > 0 && /^(\s+#.*)?\s*$/s.test(value.slice(end + 1))) return value.slice(1, end);
  }
  const comment = /(^|\s)#/.exec(value);
  return (comment === null ? value : value.slice(0, comment.index)).trim();
}

/**
 * Puts the file's settings into the environment in place of every OTEL_* it
 * inherited, when the file gives any: the file, not what an agent host
 * passed on, decides where PLexus and its images send. With no file, or a file
 * that gives none, the environment decides. The images PLexus starts run in
 * this environment, so they read the same settings. Answers what it set.
 */
export function applySettingsFile(
  env: NodeJS.ProcessEnv = process.env,
  file: string = settingsFile(env),
): Record<string, string> {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return {};
  }
  const settings = parseSettings(text);
  if (Object.keys(settings).length === 0) return {};
  for (const key of Object.keys(env)) {
    if (key.startsWith("OTEL_")) delete env[key];
  }
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
