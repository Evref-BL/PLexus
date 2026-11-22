/**
 * The settings file the Pharo tools share: `KEY=value` lines of standard
 * OTEL_* variables, read when the environment sets none. Agent hosts do not
 * pass OTEL_* to the servers they start, so a variable set in a shell never
 * reaches `plexus mcp`; the file does. Pharo MCP reads the same file.
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
  if (xdg && paths.isAbsolute(xdg)) return paths.join(xdg, "pharo-agent", "otel.env");
  if (platform === "win32" && env.APPDATA) return paths.join(env.APPDATA, "pharo-agent", "otel.env");
  return paths.join(home, ".config", "pharo-agent", "otel.env");
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
