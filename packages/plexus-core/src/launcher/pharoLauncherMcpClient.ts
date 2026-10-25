import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { PharoLauncherMcpConfig } from "../config/config.js";
import { loadPharoLauncherMcpConfig } from "../config/config.js";

const defaultLauncherToolTimeoutMs = 5 * 60_000;
const inheritedExecutionEnvironmentKeys = new Set(["PATH", "Path"]);

export interface PharoLauncherMcpToolClient {
  callTool<T = unknown>(
    name: string,
    argumentsValue?: Record<string, unknown>,
  ): Promise<T>;
  close?(): Promise<void>;
}

export class PharoLauncherMcpToolError extends Error {
  constructor(
    message: string,
    public readonly toolName: string,
    public readonly result: unknown,
  ) {
    super(message);
    this.name = "PharoLauncherMcpToolError";
  }
}

export interface CreateStdioPharoLauncherMcpClientOptions {
  env?: NodeJS.ProcessEnv;
  profileEnvironment?: Record<string, string> | undefined;
}

export function pharoLauncherMcpChildEnvironment(
  options: CreateStdioPharoLauncherMcpClientOptions = {},
): Record<string, string> {
  const env: Record<string, string> = {};

  for (const [key, value] of Object.entries(options.env ?? process.env)) {
    if (
      value !== undefined &&
      (key.startsWith("PHARO_LAUNCHER_") ||
        inheritedExecutionEnvironmentKeys.has(key))
    ) {
      env[key] = value;
    }
  }

  Object.assign(env, options.profileEnvironment);

  return env;
}

const launcherFailureDetailLength = 500;

function failureDetailField(payload: unknown, key: string): string | undefined {
  if (!payload || typeof payload !== "object") {
    return undefined;
  }

  const value = (payload as Record<string, unknown>)[key];
  if (typeof value !== "string") {
    return undefined;
  }

  const detail = value.trim();
  if (!detail) {
    return undefined;
  }

  return detail.length > launcherFailureDetailLength
    ? `${detail.slice(0, launcherFailureDetailLength)}…`
    : detail;
}

// The launcher says what went wrong and what to do about it. A message naming
// only the tool throws that away, and the caller above us has nothing left to
// report. Carry the explanation, trimmed: a diagnostic built from launcher
// output can run to pages.
export function launcherToolFailureMessage(
  toolName: string,
  payload: unknown,
): string {
  const detail =
    failureDetailField(payload, "message") ??
    [
      failureDetailField(payload, "diagnostic"),
      failureDetailField(payload, "action"),
    ]
      .filter(Boolean)
      .join(" ");

  return detail
    ? `pharo-launcher-mcp tool failed: ${toolName}: ${detail}`
    : `pharo-launcher-mcp tool failed: ${toolName}`;
}

export function parseToolTextResult(toolName: string, result: unknown): unknown {
  if (!result || typeof result !== "object") {
    return result;
  }

  const content = (result as { content?: unknown }).content;
  const isError = (result as { isError?: unknown }).isError === true;

  if (!Array.isArray(content)) {
    if (isError) {
      throw new PharoLauncherMcpToolError(
        launcherToolFailureMessage(toolName, result),
        toolName,
        result,
      );
    }

    return result;
  }

  const textContent = content.find(
    (item): item is { type: "text"; text: string } =>
      Boolean(item) &&
      typeof item === "object" &&
      (item as { type?: unknown }).type === "text" &&
      typeof (item as { text?: unknown }).text === "string",
  );

  const parsed = textContent ? JSON.parse(textContent.text) : result;

  if (isError) {
    throw new PharoLauncherMcpToolError(
      launcherToolFailureMessage(toolName, parsed),
      toolName,
      parsed,
    );
  }

  return parsed;
}

export async function createStdioPharoLauncherMcpClient(
  config: PharoLauncherMcpConfig = loadPharoLauncherMcpConfig(),
  options: CreateStdioPharoLauncherMcpClientOptions = {},
): Promise<PharoLauncherMcpToolClient> {
  const client = new Client(
    {
      name: "plexus",
      version: "0.1.0",
    },
    {
      capabilities: {},
    },
  );
  const transport = new StdioClientTransport({
    command: config.command,
    args: config.args,
    ...(config.repoDir ? { cwd: config.repoDir } : {}),
    env: pharoLauncherMcpChildEnvironment(options),
    stderr: "pipe",
  });

  await client.connect(transport);

  return {
    async callTool<T = unknown>(
      name: string,
      argumentsValue: Record<string, unknown> = {},
    ): Promise<T> {
      const result = await client.callTool(
        {
          name,
          arguments: argumentsValue,
        },
        undefined,
        { timeout: defaultLauncherToolTimeoutMs },
      );

      return parseToolTextResult(name, result) as T;
    },

    async close(): Promise<void> {
      await client.close();
    },
  };
}
