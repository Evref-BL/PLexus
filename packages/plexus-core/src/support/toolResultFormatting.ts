export type ToolResultDetail = "summary" | "full";

export const toolResultDetailSchema = {
  type: "string",
  enum: ["summary", "full"],
} as const;

const maxArrayItems = 10;
const maxObjectEntries = 24;
const maxStringLength = 1_200;
const textHeadLength = 700;
const textTailLength = 300;
const maxDepth = 4;

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function toolResultDetailFromArguments(
  value: unknown,
): ToolResultDetail {
  if (!isObject(value)) {
    return "summary";
  }

  return value.detail === "full" ? "full" : "summary";
}

function compactString(value: string): unknown {
  if (value.length <= maxStringLength) {
    return value;
  }

  return {
    kind: "truncated-text",
    length: value.length,
    head: value.slice(0, textHeadLength),
    tail: value.slice(-textTailLength),
    omittedCharacters: value.length - textHeadLength - textTailLength,
  };
}

function compactArray(value: unknown[], depth: number): unknown {
  if (value.length <= maxArrayItems) {
    return value.map((item) => compactValue(item, depth + 1));
  }

  const items = value
    .slice(0, maxArrayItems)
    .map((item) => compactValue(item, depth + 1));

  return {
    count: value.length,
    items,
    ...(value.length > items.length
      ? { omittedCount: value.length - items.length }
      : {}),
  };
}

function compactObject(value: Record<string, unknown>, depth: number): unknown {
  const entries = Object.entries(value);
  const compacted = Object.fromEntries(
    entries
      .slice(0, maxObjectEntries)
      .map(([key, entryValue]) => [key, compactValue(entryValue, depth + 1)]),
  );

  if (entries.length > maxObjectEntries) {
    return {
      ...compacted,
      omittedFieldCount: entries.length - maxObjectEntries,
    };
  }

  return compacted;
}

function compactValue(value: unknown, depth: number): unknown {
  if (typeof value === "string") {
    return compactString(value);
  }

  if (Array.isArray(value)) {
    return compactArray(value, depth);
  }

  if (isObject(value)) {
    if (depth >= maxDepth) {
      return {
        kind: "object-summary",
        fieldCount: Object.keys(value).length,
      };
    }

    return compactObject(value, depth);
  }

  return value;
}

export function formatToolResultPayload(
  value: unknown,
  detail: ToolResultDetail,
): unknown {
  return detail === "full" ? value : compactValue(value, 0);
}
