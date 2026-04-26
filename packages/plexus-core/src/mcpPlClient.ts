import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { McpPlConfig } from "./config.js";
import { loadMcpPlConfig } from "./config.js";

export interface McpPlToolClient {
  callTool<T = unknown>(
    name: string,
    argumentsValue?: Record<string, unknown>,
  ): Promise<T>;
  close?(): Promise<void>;
}

export class McpPlToolError extends Error {
  constructor(
    message: string,
    public readonly toolName: string,
    public readonly result: unknown,
  ) {
    super(message);
    this.name = "McpPlToolError";
  }
}

function parseToolTextResult(toolName: string, result: unknown): unknown {
  if (!result || typeof result !== "object") {
    return result;
  }

  const content = (result as { content?: unknown }).content;
  const isError = (result as { isError?: unknown }).isError === true;

  if (!Array.isArray(content)) {
    if (isError) {
      throw new McpPlToolError(`MCP-PL tool failed: ${toolName}`, toolName, result);
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
    throw new McpPlToolError(`MCP-PL tool failed: ${toolName}`, toolName, parsed);
  }

  return parsed;
}

export async function createStdioMcpPlClient(
  config: McpPlConfig = loadMcpPlConfig(),
): Promise<McpPlToolClient> {
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
    stderr: "pipe",
  });

  await client.connect(transport);

  return {
    async callTool<T = unknown>(
      name: string,
      argumentsValue: Record<string, unknown> = {},
    ): Promise<T> {
      const result = await client.callTool({
        name,
        arguments: argumentsValue,
      });

      return parseToolTextResult(name, result) as T;
    },

    async close(): Promise<void> {
      await client.close();
    },
  };
}
