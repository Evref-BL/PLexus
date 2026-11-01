// What PLexus needs from an image, said once.
//
// The image's MCP release owns three things PLexus does not: which tools exist,
// how their arguments are spelled, and the format answers come back in. All
// three have moved underneath PLexus without anything noticing, because every
// caller spelled them for itself. They are spelled here instead. Everything
// above this module asks for a repository or a change history file and gets
// plain values back, so a drift in the image surface is one file to repair.

import path from "node:path";

import type { ProjectImageState } from "../workspace/projectState.js";

export interface ImageMcpClient {
  callTool(
    image: ProjectImageState,
    toolName: string,
    argumentsValue: Record<string, unknown>,
  ): Promise<unknown>;
}

export interface ImageRepository {
  name: string;
  location: string;
  subdirectory?: string;
  packages?: string[];
}

// A repository the image knows. One whose checkout is gone has no location, so
// it can be reported but not replayed anywhere.
export interface RegisteredRepository {
  name: string;
  location?: string;
  subdirectory?: string;
}

export interface ChangeHistoryFile {
  file: string;
  isCurrent: boolean;
}

export interface ChangeHistoryEntrySelection {
  indexes?: number[];
  startIndex?: number;
  endIndex?: number;
  latestCount?: number;
}

// PLexus finds .ombu files on disk and thinks in paths; the image names a
// directory and a file within it. The translation belongs on this side of the
// seam, not in every caller.
export interface ChangeHistoryTarget {
  historyFilePath?: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function toolResultIsError(result: unknown): boolean {
  const structuredContent = isObject(result) && isObject(result.structuredContent)
    ? result.structuredContent
    : undefined;
  return (
    structuredContent?.status === "error" ||
    (isObject(result) && result.isError === true)
  );
}

export function toolResultText(result: unknown): string {
  if (!isObject(result) || !Array.isArray(result.content)) {
    return "";
  }

  return result.content
    .filter(
      (candidate): candidate is { type: "text"; text: string } =>
        isObject(candidate) &&
        candidate.type === "text" &&
        typeof candidate.text === "string",
    )
    .map((candidate) => candidate.text)
    .join("\n");
}

export function toolResultErrorMessage(result: unknown, toolName: string): string {
  return toolResultText(result) || `${toolName} returned an error result`;
}

// Every tool the image serves is reachable through tool_call, advertised or
// not, so this one route works whatever surface the image's release shows.
async function callImageTool(
  client: ImageMcpClient,
  image: ProjectImageState,
  toolName: string,
  argumentsValue: Record<string, unknown>,
): Promise<unknown> {
  return client.callTool(image, "tool_call", {
    name: toolName,
    arguments: argumentsValue,
  });
}

async function callImageToolOrThrow(
  client: ImageMcpClient,
  image: ProjectImageState,
  toolName: string,
  argumentsValue: Record<string, unknown>,
): Promise<unknown> {
  const result = await callImageTool(client, image, toolName, argumentsValue);
  if (toolResultIsError(result)) {
    throw new Error(toolResultErrorMessage(result, toolName));
  }

  return result;
}

// The image prints one record per line as `key=value`, two spaces in, quoting
// any value that holds a separator and escaping `"` and `\` within the quotes.
// How it writes its answers is the only thing PLexus reads here.
export function parseImageListing(text: string): Record<string, string>[] {
  return text
    .split("\n")
    .filter((line) => /^ {2}\S/.test(line) && line.includes("="))
    .map((line) => parseListingEntry(line));
}

function parseListingEntry(line: string): Record<string, string> {
  const entry: Record<string, string> = {};
  let index = 0;

  while (index < line.length) {
    while (index < line.length && line[index] === " ") {
      index += 1;
    }
    const keyStart = index;
    while (index < line.length && line[index] !== "=" && line[index] !== " ") {
      index += 1;
    }
    if (index >= line.length || line[index] !== "=") {
      // A bare token, such as the method reference an entry leads with.
      continue;
    }

    const key = line.slice(keyStart, index);
    index += 1;
    const [value, next] = readListingValue(line, index);
    entry[key] = value;
    index = next;
  }

  return entry;
}

function readListingValue(line: string, start: number): [string, number] {
  if (line[start] !== '"') {
    let index = start;
    while (index < line.length && line[index] !== " ") {
      index += 1;
    }
    return [line.slice(start, index), index];
  }

  let index = start + 1;
  let value = "";
  while (index < line.length && line[index] !== '"') {
    if (line[index] === "\\" && index + 1 < line.length) {
      index += 1;
    }
    value += line[index];
    index += 1;
  }

  return [value, index + 1];
}

// The image serves a page at a time and says so only in prose, so walk it by
// what came back rather than by reading the sentence.
async function listAllEntries(
  client: ImageMcpClient,
  image: ProjectImageState,
  toolName: string,
  argumentsValue: Record<string, unknown>,
): Promise<Record<string, string>[]> {
  const entries: Record<string, string>[] = [];
  const pageLimit = 100;

  for (let page = 0; page < pageLimit; page += 1) {
    const result = await callImageToolOrThrow(client, image, toolName, {
      ...argumentsValue,
      offset: entries.length,
    });
    const pageEntries = parseImageListing(toolResultText(result));
    if (pageEntries.length === 0) {
      break;
    }
    entries.push(...pageEntries);
  }

  return entries;
}

// For a call a caller spelled itself, such as a rescue action naming its own
// tool. It still takes the one route, so an unadvertised tool is reachable and
// an error result is raised the same way.
export async function runImageTool(
  client: ImageMcpClient,
  image: ProjectImageState,
  toolName: string,
  argumentsValue: Record<string, unknown>,
): Promise<string> {
  const result = await callImageToolOrThrow(client, image, toolName, argumentsValue);
  return toolResultText(result);
}

export async function repositoryIsRegistered(
  client: ImageMcpClient,
  image: ProjectImageState,
  repository: { name: string; location: string },
): Promise<boolean> {
  // Asking the image to assert the registration is how a program reads an
  // answer it otherwise prints in prose: an error result is the answer itself,
  // not a failed call.
  const result = await callImageTool(client, image, "repository_identity_verify", {
    name: repository.name,
    location: repository.location,
  });
  return !toolResultIsError(result);
}

export const repositoryRegistrationToolName = "repository_attach";

export function repositoryArguments(
  repository: ImageRepository,
): Record<string, unknown> {
  return {
    name: repository.name,
    location: repository.location,
    ...(repository.subdirectory !== undefined
      ? { subdirectory: repository.subdirectory }
      : {}),
    ...(repository.packages !== undefined ? { packages: repository.packages } : {}),
  };
}

export async function listRegisteredRepositories(
  client: ImageMcpClient,
  image: ProjectImageState,
): Promise<RegisteredRepository[]> {
  const entries = await listAllEntries(client, image, "repository_search", {});
  return entries.flatMap((entry) => {
    if (!entry.name) {
      return [];
    }

    return [
      {
        name: entry.name,
        ...(entry.location ? { location: entry.location } : {}),
        ...(entry.subdirectory ? { subdirectory: entry.subdirectory } : {}),
      },
    ];
  });
}

export async function listChangeHistoryFiles(
  client: ImageMcpClient,
  image: ProjectImageState,
  target: { directoryPath?: string },
): Promise<ChangeHistoryFile[]> {
  const entries = await listAllEntries(client, image, "history_file_list", {
    ...(target.directoryPath ? { directoryPath: target.directoryPath } : {}),
  });
  return entries
    .filter((entry) => Boolean(entry.file))
    .map((entry) => ({
      file: entry.file,
      isCurrent: entry.isCurrent === "true",
    }));
}

// How far the entries in a history file reach. The image pages its listing, so
// asking for the newest first puts the last index on the first page: one read
// instead of walking thousands of entries to find where they stop.
export async function highestChangeHistoryEntryIndex(
  client: ImageMcpClient,
  image: ProjectImageState,
  options: ChangeHistoryTarget & { codeChangesOnly: boolean },
): Promise<number | undefined> {
  const result = await callImageToolOrThrow(client, image, "history_entry_list", {
    ...changeHistoryTargetArguments(options),
    codeChangesOnly: options.codeChangesOnly,
    newestFirst: true,
  });
  const entries = parseImageListing(toolResultText(result));
  for (const entry of entries) {
    const index = Number.parseInt(entry.index ?? "", 10);
    if (Number.isInteger(index)) {
      return index;
    }
  }

  return undefined;
}

export async function applyChangeHistoryEntries(
  client: ImageMcpClient,
  image: ProjectImageState,
  options: ChangeHistoryTarget & {
    selection?: ChangeHistoryEntrySelection;
    codeChangesOnly: boolean;
    confirm: boolean;
  },
): Promise<string> {
  const result = await callImageToolOrThrow(client, image, "history_entry_apply", {
    ...changeHistoryTargetArguments(options),
    codeChangesOnly: options.codeChangesOnly,
    confirm: options.confirm,
    ...changeHistorySelectionArguments(options.selection),
  });
  return toolResultText(result);
}

export function changeHistoryTargetArguments(
  target: ChangeHistoryTarget,
): Record<string, unknown> {
  if (!target.historyFilePath) {
    return {};
  }

  return {
    directoryPath: path.dirname(target.historyFilePath),
    historyFile: path.basename(target.historyFilePath),
  };
}

export function changeHistorySelectionArguments(
  selection: ChangeHistoryEntrySelection | undefined,
): Record<string, unknown> {
  if (!selection) {
    return {};
  }

  return {
    ...(selection.indexes ? { indexes: selection.indexes } : {}),
    ...(selection.startIndex !== undefined
      ? { startIndex: selection.startIndex }
      : {}),
    ...(selection.endIndex !== undefined ? { endIndex: selection.endIndex } : {}),
    ...(selection.latestCount !== undefined
      ? { latestCount: selection.latestCount }
      : {}),
  };
}
