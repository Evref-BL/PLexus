/**
 * The answers of the image tools, as plain text for a model: what happened,
 * then what an agent acts on, in the layout MCP's own tools write, except that
 * a list record says every field, even one all records share, where MCP says
 * that once beside the label. Both MCP servers that serve the image tools
 * answer through this, so the same call reads the same in either; a server
 * extends an answer before rendering it.
 */
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { defaultPharoMcpVersion } from "../config/pharoMcpVersion.js";
import { listTools } from "../forward/index.js";
import type { ForwardError } from "../forward/jsonRpc.js";
import { endpointOf, noEndpointYet } from "../images/endpoint.js";
import type { StartResult } from "../images/start.js";
import type { Endpoint, ImageInfo, Template } from "../types.js";
import * as texts from "./texts.js";

export * as texts from "./texts.js";

/** A field, or a pair of a record: its key, then its value as it reads. */
export type Pair = [key: string, value: string];

/** One line of a list: what tells it from the others, bare, then all its pairs. */
export interface ToolRecord {
  name: string;
  pairs: Pair[];
}

/**
 * An answer before it is text. `render` writes it as: the summary; one
 * `Warning:` line per warning; one `key: value` line per field; the list, a
 * `label:` line and then one record per line; and each group, a `label:` line
 * and then its lines as they are.
 */
export interface ToolAnswer {
  /** What happened, in one line; it may hold several sentences. */
  summary: string;
  warnings: string[];
  fields: Pair[];
  list?: { label: string; records: ToolRecord[] };
  /** Lines under a label, each said as it is: names that may hold commas. */
  groups?: Array<{ label: string; lines: string[] }>;
}

export function render(answer: ToolAnswer): string {
  const lines = [answer.summary];
  for (const warning of answer.warnings) {
    lines.push(`Warning: ${warning}`);
  }
  for (const [key, value] of answer.fields) {
    lines.push(`${key}: ${value}`);
  }
  if (answer.list !== undefined && answer.list.records.length > 0) {
    lines.push(`${answer.list.label}:`, ...answer.list.records.map(recordLine));
  }
  for (const group of answer.groups ?? []) {
    lines.push(`${group.label}:`, ...group.lines.map((line) => `  ${line}`));
  }
  return lines.join("\n");
}

// A record says all its pairs, even those every record holds alike, so that a
// line an agent copies on its own keeps everything said of that record.
function recordLine(record: ToolRecord): string {
  return `  ${[record.name, ...record.pairs.map(pairText)].join(" ")}`;
}

function pairText([key, value]: Pair): string {
  return `${key}=${inlineValue(value)}`;
}

/**
 * A value holding whitespace is quoted, so that where it ends is never a
 * guess; any other value, a quote in it or not, reads as it is.
 */
function inlineValue(value: string): string {
  return /\s/.test(value) ? `"${value.replace(/["\\]/g, "\\$&")}"` : value;
}

// The facts of an image.

export type ImageState = "creating" | "stopped" | "starting" | "running";

/**
 * A create still making the image wins whatever VM runs it: a script
 * create's own VM runs the image it prepares.
 */
export function state(row: Pick<ImageInfo, "running" | "building" | "endpointProblem">): ImageState {
  if (row.building) {
    return "creating";
  }
  if (!row.running) {
    return "stopped";
  }
  return row.endpointProblem === noEndpointYet ? "starting" : "running";
}

/** The Pharo version as Pharo says it: "140" is 14.0 and "61" is 6.1; anything else as it is. */
export function pharoVersion(raw: string): string {
  return /^\d{2,3}$/.test(raw) ? `${raw.slice(0, -1)}.${raw.slice(-1)}` : raw;
}

/** Said of an image pinned to an MCP other than the one images are created with now. */
export function olderMcp(row: Pick<ImageInfo, "name" | "mcp">): string | undefined {
  return row.mcp?.source === "pin" && row.mcp.version !== defaultPharoMcpVersion
    ? texts.olderMcp(row.name, row.mcp.version, defaultPharoMcpVersion)
    : undefined;
}

function warningsOf(row: ImageInfo): string[] {
  const warnings: string[] = [];
  if (state(row) === "running" && row.endpoint === undefined && row.endpointProblem !== undefined) {
    warnings.push(texts.takesNoCalls(row.name, row.pids, row.endpointProblem));
  }
  const older = olderMcp(row);
  if (older !== undefined) {
    warnings.push(older);
  }
  return warnings;
}

// The answers.

export function templates(listed: readonly Template[]): ToolAnswer {
  if (listed.length === 0) {
    return { summary: texts.noTemplates(), warnings: [], fields: [] };
  }
  const groups: Array<{ label: string; lines: string[] }> = [];
  for (const template of listed) {
    const group = groups.find((each) => each.label === template.category);
    if (group === undefined) {
      groups.push({ label: template.category, lines: [template.name] });
    } else {
      group.lines.push(template.name);
    }
  }
  return {
    summary: texts.templatesSummary(listed.length, groups.length),
    warnings: [],
    fields: [],
    groups,
  };
}

/**
 * Every image, one record each. `more` adds pairs to an image's record, after
 * those said here.
 */
export function list(rows: readonly ImageInfo[], more?: (row: ImageInfo) => Pair[]): ToolAnswer {
  if (rows.length === 0) {
    return { summary: texts.noImages(), warnings: [], fields: [] };
  }
  return {
    summary: texts.imagesSummary(rows.length, rows.filter((row) => state(row) === "running").length),
    warnings: rows.flatMap(warningsOf),
    fields: [],
    list: {
      label: "images",
      records: rows.map((row) => ({ name: row.name, pairs: [...recordPairs(row), ...(more?.(row) ?? [])] })),
    },
  };
}

function recordPairs(row: ImageInfo): Pair[] {
  return [
    ["state", state(row)],
    ...known("pharo", row.pharoVersion === undefined ? undefined : pharoVersion(row.pharoVersion)),
    ...known("template", row.template),
    ...known("mcp", row.mcp === undefined ? undefined : row.mcp.source === "pin" ? row.mcp.version : "script"),
    ...(row.display === "interactive" ? [["display", "interactive"] as Pair] : []),
  ];
}

/** One image, named: only here with its path, and its script when it has one. */
export function image(row: ImageInfo): ToolAnswer {
  const summaries: Record<ImageState, string> = {
    creating: texts.imageCreating(row.name),
    stopped: texts.imageStopped(row.name),
    starting: texts.imageStarting(row.name),
    running: texts.imageRunning(row.name, row.display === "interactive"),
  };
  return {
    summary: summaries[state(row)],
    warnings: warningsOf(row),
    fields: [
      ...known("pharo", row.pharoVersion === undefined ? undefined : pharoVersion(row.pharoVersion)),
      ...known("template", row.template),
      ...known(
        "mcp",
        row.mcp === undefined
          ? undefined
          : row.mcp.source === "pin"
            ? row.mcp.version
            : `script ${row.mcp.script}`,
      ),
      ...known("every start", row.everyStart),
      ["path", row.path],
    ],
  };
}

export function created(result: Pick<ImageInfo, "name" | "template" | "mcp" | "everyStart">): ToolAnswer {
  return {
    summary: texts.created(result.name, {
      ...(result.template === undefined ? {} : { template: result.template }),
      ...(result.mcp?.source === "script"
        ? { script: result.mcp.script, everyStart: result.everyStart !== undefined }
        : {}),
    }),
    warnings: [],
    fields: [],
  };
}

/**
 * A start, said of the image as it was last saved. `row`, the image as listed
 * before or after the start, which changes neither, adds the script every
 * start files in and the older-MCP warning; the pids, the endpoint and the
 * time taken are not said.
 */
export function started(result: Pick<StartResult, "name" | "display">, row?: ImageInfo): ToolAnswer {
  const older = row === undefined ? undefined : olderMcp(row);
  return {
    summary: texts.started(result.name, {
      interactive: result.display === "interactive",
      ...(row?.everyStart === undefined ? {} : { everyStart: row.everyStart }),
    }),
    warnings: older === undefined ? [] : [older],
    fields: [],
  };
}

export function stopped(result: { name: string; killed: readonly number[]; saved?: boolean }): ToolAnswer {
  return {
    summary: result.saved
      ? texts.savedAndStopped(result.name)
      : result.killed.length > 0
        ? texts.stopped(result.name)
        : texts.wasNotRunning(result.name),
    warnings: [],
    fields: [],
  };
}

export function deleted(result: { name: string }): ToolAnswer {
  return { summary: texts.deleted(result.name), warnings: [], fields: [] };
}

function known(key: string, value: string | undefined): Pair[] {
  return value === undefined ? [] : [[key, value]];
}

function said(summary: string, warnings: string[] = []): ToolAnswer {
  return { summary, warnings, fields: [] };
}

// A forwarded call that failed.

/** The JSON-RPC code of a method the server does not know. */
const methodNotFound = -32601;

/**
 * How long the listing of an image that has just answered waits on each of
 * its two requests: one the image is too busy to give in that time is not
 * worth delaying its refusal for.
 */
const listingWaitMs = 5_000;

/**
 * What a forwarded call that failed did to the image, from `callTool`'s
 * error, or nothing for a call its caller cancelled, which is answered
 * nothing. An answer the image gave passes as it is. `rowOf` is asked for the
 * image as listed only when the text depends on it: whether it still runs, or
 * which MCP it holds. A `rowOf` that rejects leaves both unknown. A tool the
 * image answers it does not have is answered with the one it lists that the
 * call most likely meant: `listToolsAt` lists them at the image's endpoint,
 * asking the image itself unless given, and a listing that fails names none.
 */
export async function callFailed(
  image: string,
  tool: string,
  error: unknown,
  rowOf: () => Promise<ImageInfo | undefined>,
  listToolsAt: (endpoint: Endpoint) => Promise<ReadonlyArray<{ name: string }>> = (endpoint) =>
    listTools(endpoint, { timeoutMs: listingWaitMs }),
): Promise<ToolAnswer | undefined> {
  const failure = (error instanceof Error ? error : new Error(String(error))) as Error & {
    kind?: ForwardError["kind"];
    rpcCode?: number;
    waitedMs?: number;
  };
  const kind = failure.kind ?? "other";
  if (kind === "cancelled") {
    return undefined;
  }
  if (kind === "answered" && failure.rpcCode !== methodNotFound) {
    return said(failure.message);
  }

  const row = await rowOf().catch(() => undefined);
  if (kind === "answered") {
    return noSuchTool(image, tool, row, await listedNames(row, listToolsAt));
  }
  if (row === undefined) {
    return said(texts.didNotAnswer(image, tool, withoutFinalPeriod(failure.message)));
  }
  if (!row.running) {
    return said(texts.stoppedBeforeAnswering(image, tool));
  }
  switch (kind) {
    case "no-handshake":
      return said(texts.noHandshake(image, tool, secondsOf(failure.waitedMs)));
    case "timeout":
      return said(texts.callTimedOut(image, tool, secondsOf(failure.waitedMs)));
    case "refused":
      return said(texts.connectionRefused(image, tool));
    case "closed":
      return said(texts.connectionClosed(image, tool));
    default:
      return said(texts.didNotAnswerRunning(image, tool, withoutFinalPeriod(failure.message)));
  }
}

function noSuchTool(
  image: string,
  tool: string,
  row: ImageInfo | undefined,
  listed: readonly string[],
): ToolAnswer {
  const older = row === undefined ? undefined : olderMcp(row);
  return said(texts.noSuchTool(image, tool, meantTool(tool, listed)), older === undefined ? [] : [older]);
}

/** The names of the tools the image lists now, or none when it cannot be asked or does not answer. */
async function listedNames(
  row: ImageInfo | undefined,
  listToolsAt: (endpoint: Endpoint) => Promise<ReadonlyArray<{ name: string }>>,
): Promise<string[]> {
  if (row === undefined) {
    return [];
  }
  try {
    return (await listToolsAt(endpointOf(row))).map((each) => each.name);
  } catch {
    return [];
  }
}

/**
 * The listed tool an agent asking for `tool` means: the one listed name that
 * is the asked one with whole words put before it, or that the asked one is
 * with words put before it, as image_evaluate and evaluate are across an MCP
 * release. Several such names, or a listing that holds the asked name, which
 * the image has just denied having, name none.
 */
function meantTool(tool: string, listed: readonly string[]): string | undefined {
  if (listed.includes(tool)) {
    return undefined;
  }
  const fits = listed.filter((name) => endsWithWords(name, tool) || endsWithWords(tool, name));
  return fits.length === 1 ? fits[0] : undefined;
}

function endsWithWords(name: string, last: string): boolean {
  return name.endsWith(`_${last}`);
}

function secondsOf(waitedMs: number | undefined): number {
  return Math.round((waitedMs ?? 0) / 1000);
}

function withoutFinalPeriod(message: string): string {
  return message.replace(/\.$/, "");
}

// Arguments.

interface PropertySchema {
  type?: string | string[];
  enum?: unknown[];
}

/**
 * The refusal of a call whose arguments break the schema the tool
 * advertises, in MCP's words, or nothing for a call that keeps it: the
 * arguments it requires first, a required string holding only whitespace
 * being missing, then each value, then each argument the schema does not
 * accept when it accepts no other.
 */
export function checkArguments(
  tool: Pick<Tool, "name" | "inputSchema">,
  args: Record<string, unknown> | undefined,
): string | undefined {
  const given = args ?? {};
  const properties = (tool.inputSchema.properties ?? {}) as Record<string, PropertySchema>;
  const missing = (tool.inputSchema.required ?? []).filter((name) => isMissing(given[name]));
  const violations = missing.map(texts.argumentRequired);

  for (const [name, property] of Object.entries(properties)) {
    const value = given[name];
    if (value !== undefined && !missing.includes(name)) {
      const violation = valueViolation(name, property, value);
      if (violation !== undefined) {
        violations.push(violation);
      }
    }
  }

  if (tool.inputSchema.additionalProperties === false) {
    const accepted = Object.keys(properties).sort();
    for (const name of Object.keys(given)) {
      if (!Object.hasOwn(properties, name)) {
        violations.push(texts.argumentNotAccepted(name, accepted));
      }
    }
  }

  return violations.length === 0 ? undefined : texts.invalidArguments(tool.name, violations);
}

function isMissing(value: unknown): boolean {
  return value === undefined || (typeof value === "string" && value.trim() === "");
}

// One sentence per argument: a value outside an enum is said with the values
// it allows, which names their type as well.
function valueViolation(name: string, property: PropertySchema, value: unknown): string | undefined {
  if (Array.isArray(property.enum) && !property.enum.includes(value)) {
    return texts.argumentNotOneOf(name, property.enum.map(jsonText), jsonText(value));
  }
  const types = property.type === undefined ? [] : [property.type].flat();
  if (types.length > 0 && !types.some((type) => hasType(value, type))) {
    return texts.argumentType(name, types, jsonType(value));
  }
  if (typeof value === "string" && value.trim() === "") {
    return texts.argumentBlank(name);
  }
  return undefined;
}

/** The JSON type a value is, as MCP names it. */
function jsonType(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  if (typeof value === "number") {
    return Number.isInteger(value) ? "integer" : "number";
  }
  return typeof value;
}

function hasType(value: unknown, type: string): boolean {
  const actual = jsonType(value);
  return actual === type || (type === "number" && actual === "integer");
}

function jsonText(value: unknown): string {
  return JSON.stringify(value) ?? String(value);
}
