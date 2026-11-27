/**
 * The request headers the 2026-07-28 Streamable HTTP binding asks a client
 * to mirror from the body: the value encoding they share, and the tool
 * parameters a schema annotates with `x-mcp-header`.
 */

const annotation = "x-mcp-header";

/** An HTTP field name: `1*tchar` (RFC 9110). */
const fieldName = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/** Visible ASCII, space and tab, with no whitespace at either end. */
const plain = /^(?:[\x21-\x7E]|[\x21-\x7E][\x20-\x7E\t]*[\x21-\x7E])$/;

const sentinel = /^=\?base64\?.*\?=$/s;

/**
 * A value as a header carries it: as it is when it is plain ASCII, in the
 * Base64 sentinel otherwise, and so too when it looks like the sentinel.
 */
export function headerValue(value: string): string {
  return plain.test(value) && !sentinel.test(value)
    ? value
    : `=?base64?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

/** A parameter a schema mirrors into `Mcp-Param-{name}`, by the chain of `properties` keys that reaches it. */
interface Annotation {
  name: string;
  path: string[];
}

/**
 * What makes a tool's `x-mcp-header` annotations break the binding's rules,
 * or nothing when they keep them, as there are none. A client drops such a
 * tool from what it lists.
 */
export function annotationProblem(inputSchema: unknown): string | undefined {
  return annotationsOf(inputSchema).problem;
}

/**
 * The `Mcp-Param-*` headers a call carries: one for each parameter the
 * schema annotates that the arguments give a string, a boolean or a safe
 * integer, none for a schema whose annotations break the rules.
 */
export function parameterHeaders(inputSchema: unknown, args: Record<string, unknown>): Record<string, string> {
  const { annotations, problem } = annotationsOf(inputSchema);
  if (problem !== undefined) {
    return {};
  }
  const headers: Record<string, string> = {};
  for (const { name, path } of annotations) {
    const text = headerText(valueAt(args, path));
    if (text !== undefined) {
      headers[`Mcp-Param-${name}`] = headerValue(text);
    }
  }
  return headers;
}

function headerText(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "boolean") {
    return String(value);
  }
  return Number.isSafeInteger(value) ? String(value) : undefined;
}

function valueAt(args: Record<string, unknown>, path: string[]): unknown {
  let value: unknown = args;
  for (const key of path) {
    if (!isRecord(value) || !Object.hasOwn(value, key)) {
      return undefined;
    }
    value = value[key];
  }
  return value;
}

/**
 * The annotations on properties reached from the root by `properties` keys
 * alone, and what is wrong with them or with an annotation found anywhere
 * else.
 */
function annotationsOf(inputSchema: unknown): { annotations: Annotation[]; problem?: string } {
  const annotations: Annotation[] = [];
  const reachable = new Set<object>();
  const problems: string[] = [];
  const seen = new Set<string>();

  const walk = (schema: unknown, path: string[]) => {
    if (!isRecord(schema) || !isRecord(schema.properties)) {
      return;
    }
    for (const [key, property] of Object.entries(schema.properties)) {
      if (!isRecord(property)) {
        continue;
      }
      reachable.add(property);
      const at = [...path, key];
      if (Object.hasOwn(property, annotation)) {
        const name = property[annotation];
        if (typeof name !== "string" || !fieldName.test(name)) {
          problems.push(`${at.join(".")} names no valid header`);
        } else if (seen.has(name.toLowerCase())) {
          problems.push(`${at.join(".")} repeats header ${name}`);
        } else if (property.type !== "string" && property.type !== "integer" && property.type !== "boolean") {
          problems.push(`${at.join(".")} is not a string, an integer or a boolean`);
        } else {
          seen.add(name.toLowerCase());
          annotations.push({ name, path: at });
        }
      }
      walk(property, at);
    }
  };
  walk(inputSchema, []);

  // Any other annotation sits where a call has no single value to mirror.
  const stray = (node: unknown, propertyNames: boolean): boolean => {
    if (Array.isArray(node)) {
      return node.some((each) => stray(each, false));
    }
    if (!isRecord(node)) {
      return false;
    }
    if (!propertyNames && Object.hasOwn(node, annotation) && !reachable.has(node)) {
      return true;
    }
    return Object.entries(node).some(([key, value]) => stray(value, !propertyNames && key === "properties"));
  };
  if (stray(inputSchema, false)) {
    problems.push(`an ${annotation} is not reached through properties alone`);
  }

  return problems.length === 0 ? { annotations } : { annotations, problem: problems.join("; ") };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
