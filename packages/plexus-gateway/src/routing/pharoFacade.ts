import type { Tool } from "@modelcontextprotocol/sdk/types.js";

const imageIdSchema = {
  type: "string",
  minLength: 1,
  description: "PLexus workspace-scoped image handle to route this Pharo tool call to.",
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
  const required = unique(["imageId", ...schemaRequired(inputSchema.required)]);

  return {
    ...tool,
    inputSchema: {
      ...inputSchema,
      type: "object",
      properties: {
        ...properties,
        imageId: imageIdSchema,
      },
      required,
    },
  };
}

export function buildPharoFacadeTools(tools: readonly Tool[]): Tool[] {
  return tools.map((tool) => buildPharoFacadeTool(tool));
}

export interface PharoFacadeArguments {
  imageId: string;
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

  const imageId = input.imageId;
  if (typeof imageId !== "string" || imageId.length === 0) {
    throw new PharoFacadeInputError("imageId is required");
  }

  const { imageId: _imageId, ...argumentsValue } = input;
  return {
    imageId,
    argumentsValue,
  };
}
