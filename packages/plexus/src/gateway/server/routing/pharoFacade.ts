import type { Tool } from "@modelcontextprotocol/sdk/types.js";

const mcpServerIdSchema = {
  type: "string",
  minLength: 1,
  description: "PLexus MCP server handle to route this Pharo tool call to.",
} as const;

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function schemaObject(value: unknown): Record<string, unknown> {
  return isObject(value) ? value : {};
}

function schemaProperties(value: unknown): Record<string, unknown> {
  if (!isObject(value)) {
    return {};
  }

  return { ...value };
}

function schemaRequired(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is string => typeof item === "string");
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

export function buildPharoFacadeTool(tool: Tool): Tool {
  const inputSchema = schemaObject(tool.inputSchema);
  const properties = schemaProperties(inputSchema.properties);
  const required = unique(["mcpServerId", ...schemaRequired(inputSchema.required)]);

  return {
    ...tool,
    inputSchema: {
      ...inputSchema,
      type: "object",
      properties: {
        ...properties,
        mcpServerId: mcpServerIdSchema,
      },
      required,
    },
  };
}

export function buildPharoFacadeTools(tools: readonly Tool[]): Tool[] {
  return tools.map((tool) => buildPharoFacadeTool(tool));
}

export interface PharoFacadeArguments {
  mcpServerId: string;
  argumentsValue: Record<string, unknown>;
}

export class PharoFacadeInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PharoFacadeInputError";
  }
}

export function parsePharoFacadeArguments(input: unknown): PharoFacadeArguments {
  if (!isObject(input)) {
    throw new PharoFacadeInputError("Pharo facade input must be an object");
  }

  const mcpServerId = input.mcpServerId;
  if (typeof mcpServerId !== "string" || mcpServerId.length === 0) {
    throw new PharoFacadeInputError("mcpServerId is required");
  }

  const { mcpServerId: _mcpServerId, ...argumentsValue } = input;
  return {
    mcpServerId,
    argumentsValue,
  };
}
