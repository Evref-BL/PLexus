/**
 * The answers of the image tools, as plain text for a model: what happened,
 * then what an agent acts on, in the layout MCP's own tools write, and no
 * more. A list record says only what tells it from what is usual: the Pharo
 * version, the template when it is not that version's usual one, MCP when it
 * is not the pinned release; a warning that would repeat for several images
 * is said once, naming them. `plexus mcp` extends an answer before rendering
 * it.
 */
import { defaultPharoMcpVersion } from "../config/pharoMcpVersion.js";
import { listTools } from "../forward/index.js";
import type { ForwardError } from "../forward/jsonRpc.js";
import { endpointOf } from "../images/endpoint.js";
import type { StartResult } from "../images/start.js";
import type { Endpoint, ImageInfo, ImageState, ImageTelemetry, ImageTool, Template } from "../types.js";
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
 * `Warning:` line per warning; one `key: value` line per field; each list
 * with records, a `label:` line and then one record per line; and each group,
 * a `label:` line and then its lines as they are.
 */
export interface ToolAnswer {
  /** What happened, in one line; it may hold several sentences. */
  summary: string;
  warnings: string[];
  fields: Pair[];
  lists?: Array<{ label: string; records: ToolRecord[] }>;
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
  for (const list of answer.lists ?? []) {
    if (list.records.length > 0) {
      lines.push(`${list.label}:`, ...list.records.map(recordLine));
    }
  }
  for (const group of answer.groups ?? []) {
    lines.push(`${group.label}:`, ...group.lines.map((line) => `  ${line}`));
  }
  return lines.join("\n");
}

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

/** The script every start files in, for an image that has one. */
function everyStartScript(row: Pick<ImageInfo, "mcp">): string | undefined {
  return row.mcp?.source === "script" && row.mcp.everyStart ? row.mcp.script : undefined;
}

/** Said of an image pinned to an MCP other than the one images are created with now. */
export function olderMcp(row: Pick<ImageInfo, "name" | "mcp">): string | undefined {
  const version = olderPin(row);
  return version === undefined ? undefined : texts.olderMcp([row.name], version, defaultPharoMcpVersion);
}

function olderPin(row: Pick<ImageInfo, "mcp">): string | undefined {
  return row.mcp?.source === "pin" && row.mcp.version !== defaultPharoMcpVersion ? row.mcp.version : undefined;
}

/** One warning per problem that keeps images from taking calls, naming every image it keeps, in record order. */
function unreachableWarnings(rows: readonly ImageInfo[]): string[] {
  const byProblem = new Map<string, ImageInfo[]>();
  for (const row of rows.filter((each) => each.state === "unreachable")) {
    const problem = row.endpointProblem ?? "it wrote no endpoint";
    byProblem.set(problem, [...(byProblem.get(problem) ?? []), row]);
  }
  return [...byProblem].map(([problem, held]) =>
    held.length === 1 ? texts.takesNoCalls(held[0]!.name, held[0]!.pids, problem) : texts.takeNoCalls(held, problem),
  );
}

/** One warning per older MCP release, naming every image that holds it, in record order. */
function olderMcpWarnings(rows: readonly ImageInfo[]): string[] {
  const byVersion = new Map<string, string[]>();
  for (const row of rows) {
    const version = olderPin(row);
    if (version !== undefined) {
      byVersion.set(version, [...(byVersion.get(version) ?? []), row.name]);
    }
  }
  return [...byVersion].map(([version, names]) => texts.olderMcp(names, version, defaultPharoMcpVersion));
}

/** Whether a template is the one images of its Pharo version are usually made from: `Pharo 14.0 - 64bit`, with or without what follows in parentheses. */
function usualTemplate(row: Pick<ImageInfo, "template" | "pharoVersion">): boolean {
  if (row.template === undefined || row.pharoVersion === undefined) {
    return false;
  }
  const prefix = `Pharo ${row.pharoVersion} - 64bit`;
  return row.template === prefix || (row.template.startsWith(`${prefix} (`) && row.template.endsWith(")"));
}

/** MCP as a record says it: the version of a pin other than the current one, `script` for a script, nothing for the current pin. */
function mcpOfRecord(row: Pick<ImageInfo, "mcp">): string | undefined {
  if (row.mcp === undefined) {
    return undefined;
  }
  return row.mcp.source === "script" ? "script" : olderPin(row);
}

/**
 * What an answer says of telemetry, when the PLexus answering enrolls images
 * in OpenTelemetry (`enrolled`): `telemetry: on` for an image whose server
 * records its calls through OpenTelemetry, said otherwise when PLexus's
 * settings send them to no OTLP endpoint (`endpointNamed` false), or
 * a warning saying why the image does not record them. Nothing otherwise,
 * nor when nothing said.
 */
export interface Enrollment {
  enrolled?: boolean;
  endpointNamed?: boolean;
}

function telemetrySaid(
  row: Pick<ImageInfo, "name" | "mcp"> & { telemetry?: ImageTelemetry },
  { enrolled, endpointNamed }: Enrollment,
): { fields: Pair[]; warnings: string[] } {
  const telemetry = row.telemetry;
  if (!enrolled || telemetry === undefined) {
    return { fields: [], warnings: [] };
  }
  return telemetry.on
    ? { fields: [["telemetry", endpointNamed === false ? texts.recordedNotSent() : "on"]], warnings: [] }
    : { fields: [], warnings: [texts.recordsNothing(row.name, telemetry, row.mcp?.source !== "script")] };
}

function warningsOf(row: ImageInfo): string[] {
  return [...unreachableWarnings([row]), ...olderMcpWarnings([row])];
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

/** The order the states are listed in: those that take calls, or would, first. */
const listedStates: readonly ImageState[] = ["running", "unreachable", "starting", "creating", "stopped"];

/**
 * Every image, one short record each under its state, running ones first;
 * enrolled, `telemetry=off` on each known not to record its calls, which
 * naming it says the reason of.
 */
export function list(rows: readonly ImageInfo[], enrollment: Enrollment = {}): ToolAnswer {
  if (rows.length === 0) {
    return { summary: texts.noImages(), warnings: [], fields: [] };
  }
  const unsent =
    enrollment.enrolled && enrollment.endpointNamed === false && rows.some((row) => row.telemetry?.on === true);
  return {
    summary: texts.imagesSummary(rows.length, rows.filter((row) => row.state === "running" || row.state === "unreachable").length),
    warnings: [...unreachableWarnings(rows), ...olderMcpWarnings(rows), ...(unsent ? [texts.recordedNowhereToSend()] : [])],
    fields: [],
    lists: listedStates.map((state) => ({
      label: state,
      records: rows.filter((row) => row.state === state).map((row) => ({ name: row.name, pairs: recordPairs(row, enrollment) })),
    })),
  };
}

function recordPairs(row: ImageInfo, { enrolled }: Enrollment): Pair[] {
  return [
    ...known("pharo", row.pharoVersion),
    ...known("template", usualTemplate(row) ? undefined : row.template),
    ...known("mcp", mcpOfRecord(row)),
    ...(row.display === "interactive" ? [["display", "interactive"] as Pair] : []),
    ...known("telemetry", enrolled && row.telemetry?.on === false ? "off" : undefined),
    ...known("used", usedDay(row)),
    ...known("size", imageSize(row)),
  ];
}

/** The day a stopped image was last used, which tells a stale one; a running image is in use. */
function usedDay(row: ImageInfo): string | undefined {
  return row.state === "stopped" ? row.lastUsed?.slice(0, 10) : undefined;
}

/** The size of a stopped image's image file, in megabytes: what deleting it would free, at the least. */
function imageSize(row: ImageInfo): string | undefined {
  return row.state === "stopped" && row.imageBytes !== undefined ? `${Math.round(row.imageBytes / 1_000_000)}MB` : undefined;
}

/** One image, named: only here with its path, and its script when it has one. */
export function image(row: ImageInfo, enrollment: Enrollment = {}): ToolAnswer {
  const summaries: Record<ImageState, string> = {
    creating: texts.imageCreating(row.name),
    stopped: texts.imageStopped(row.name),
    starting: texts.imageStarting(row.name),
    running: texts.imageRunning(row.name, row.display === "interactive"),
    // The warning says why it takes no calls.
    unreachable: texts.imageRunning(row.name, row.display === "interactive"),
  };
  const telemetry = telemetrySaid(row, enrollment);
  return {
    summary: summaries[row.state],
    warnings: [...warningsOf(row), ...telemetry.warnings],
    fields: [
      ...known("pharo", row.pharoVersion),
      ...known("template", row.template),
      ...known(
        "mcp",
        row.mcp === undefined
          ? undefined
          : row.mcp.source === "pin"
            ? row.mcp.version
            : `script ${row.mcp.script}`,
      ),
      ...known("every start", everyStartScript(row)),
      ...telemetry.fields,
      ...known("used", usedDay(row)),
      ...known("size", imageSize(row)),
      ["path", row.path],
    ],
  };
}

export function created(
  result: Pick<ImageInfo, "name" | "mcp" | "telemetry">,
  enrollment: Enrollment = {},
): ToolAnswer {
  return {
    summary: texts.created(result.name, {
      ...(result.mcp?.source === "script"
        ? { script: result.mcp.script, everyStart: result.mcp.everyStart === true }
        : {}),
    }),
    ...telemetrySaid(result, enrollment),
  };
}

/**
 * A start, or an image that was already running. `row`, the image as listed
 * before or after the start, which changes neither, adds the script every
 * start files in and the older-MCP warning; the pids, the endpoint and the
 * time taken are not said. Enrolled, it says whether the image records its
 * calls.
 */
export function started(
  result: Pick<StartResult, "name" | "display" | "telemetry" | "alreadyRunning">,
  row?: ImageInfo,
  enrollment: Enrollment = {},
): ToolAnswer {
  const older = row === undefined ? undefined : olderMcp(row);
  const everyStart = row === undefined ? undefined : everyStartScript(row);
  const telemetry = telemetrySaid({ name: result.name, ...(row?.mcp === undefined ? {} : { mcp: row.mcp }), ...(result.telemetry === undefined ? {} : { telemetry: result.telemetry }) }, enrollment);
  return {
    summary: result.alreadyRunning
      ? texts.alreadyRunning(result.name, result.display === "interactive")
      : texts.started(result.name, {
          interactive: result.display === "interactive",
          ...(everyStart === undefined ? {} : { everyStart }),
        }),
    warnings: [...(older === undefined ? [] : [older]), ...telemetry.warnings],
    fields: telemetry.fields,
  };
}

export function stopped(result: { name: string; killed: readonly number[]; quit?: boolean; saved?: boolean }): ToolAnswer {
  return {
    summary: result.saved
      ? texts.savedAndStopped(result.name)
      : result.quit === true || result.killed.length > 0
        ? texts.stopped(result.name)
        : texts.wasNotRunning(result.name),
    warnings: [],
    fields: [],
  };
}

export function deleted(result: { name: string }): ToolAnswer {
  return { summary: texts.deleted(result.name), warnings: [], fields: [] };
}

/** A stop or a delete of several images: what each did, then why any was not done. */
export function several(done: readonly ToolAnswer[], refusals: readonly string[]): ToolAnswer {
  return {
    summary: done.map((answer) => answer.summary).join(" "),
    warnings: [...done.flatMap((answer) => answer.warnings), ...refusals],
    fields: [],
  };
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
 * with words put before it, as `image_evaluate` is `evaluate`. Several such names, or a listing that holds the asked name, which
 * the image has just denied having, name none.
 */
export function meantTool(tool: string, listed: readonly string[]): string | undefined {
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
  items?: { type?: string };
}

/**
 * The refusal of a call whose arguments break the schema the tool
 * advertises, in MCP's words, or nothing for a call that keeps it: the
 * arguments it requires first, a required string holding only whitespace
 * being missing, then each value, then each argument the schema does not
 * accept when it accepts no other.
 */
export function checkArguments(
  tool: Pick<ImageTool, "name" | "inputSchema">,
  args: Record<string, unknown> | undefined,
): string | undefined {
  const given = args ?? {};
  const properties = (tool.inputSchema.properties ?? {}) as Record<string, PropertySchema>;
  const missing = (tool.inputSchema.required ?? []).filter((name) => isMissing(given[name], properties[name]));
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

/** Nothing given: no value, a blank string, or an empty list where a list is taken. */
function isMissing(value: unknown, property: PropertySchema | undefined): boolean {
  return (
    value === undefined ||
    (typeof value === "string" && value.trim() === "") ||
    (Array.isArray(value) && value.length === 0 && [property?.type].flat().includes("array"))
  );
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
  if (Array.isArray(value) && property.items?.type !== undefined) {
    const itemType = property.items.type;
    const wrong = value.find((item) => !hasType(item, itemType) || (typeof item === "string" && item.trim() === ""));
    if (wrong !== undefined) {
      return texts.argumentItem(name, itemType, jsonText(wrong));
    }
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
