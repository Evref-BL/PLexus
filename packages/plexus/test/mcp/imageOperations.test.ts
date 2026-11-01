import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  changeHistoryTargetArguments,
  highestChangeHistoryEntryIndex,
  listRegisteredRepositories,
  parseImageListing,
  repositoryIsRegistered,
  type ImageMcpClient,
} from "../../src/mcp/imageOperations.js";
import type { ProjectImageState } from "../../src/workspace/projectState.js";

const image = { id: "dev" } as ProjectImageState;

function textResult(text: string): unknown {
  return { content: [{ type: "text", text }] };
}

function errorResult(text: string): unknown {
  return { isError: true, content: [{ type: "text", text }] };
}

class RecordingClient implements ImageMcpClient {
  readonly calls: Record<string, unknown>[] = [];

  constructor(private readonly answers: unknown[]) {}

  async callTool(
    _image: ProjectImageState,
    _toolName: string,
    argumentsValue: Record<string, unknown>,
  ): Promise<unknown> {
    this.calls.push(argumentsValue);
    return this.answers[this.calls.length - 1] ?? textResult("");
  }
}

describe("the image's listing format", () => {
  it("reads the key=value pairs of an entry", () => {
    const entries = parseImageListing(
      [
        "Showing 1 of 1 repositories [scope=field-filters].",
        "repositories:",
        "  isMissing=false location=/checkouts/MCP name=MCP packageCount=12 subdirectory=src",
      ].join("\n"),
    );

    expect(entries).toEqual([
      {
        isMissing: "false",
        location: "/checkouts/MCP",
        name: "MCP",
        packageCount: "12",
        subdirectory: "src",
      },
    ]);
  });

  it("reads a quoted value whole, separators and escapes included", () => {
    const [entry] = parseImageListing(
      '  location="/Users/me/Application Support/My \\"odd\\" checkout" name=Odd',
    );

    expect(entry).toEqual({
      location: '/Users/me/Application Support/My "odd" checkout',
      name: "Odd",
    });
  });

  it("steps over the reference an entry leads with", () => {
    const [entry] = parseImageListing(
      "  MCPTool>>buildInputSchema eventClass=EpMethodModification index=7 package=MCP",
    );

    expect(entry).toEqual({
      eventClass: "EpMethodModification",
      index: "7",
      package: "MCP",
    });
  });

  it("keeps the headers and labels around a listing out of it", () => {
    const entries = parseImageListing(
      [
        "Listed 25 change history entries. More available at offset 25.",
        "historyFile: Pharo14.ombu",
        "entries:",
        "  index=1",
        "    nested: [MCP]",
      ].join("\n"),
    );

    expect(entries).toEqual([{ index: "1" }]);
  });
});

describe("reading what the image registered", () => {
  it("walks the pages until one comes back empty", async () => {
    const client = new RecordingClient([
      textResult("repositories:\n  location=/a name=A"),
      textResult("repositories:\n  isMissing=true location= name=Gone"),
      textResult("repositories:"),
    ]);

    const repositories = await listRegisteredRepositories(client, image);

    // A repository whose checkout is gone is still reported, without a place
    // to replay it to.
    expect(repositories).toEqual([{ name: "A", location: "/a" }, { name: "Gone" }]);
    expect(client.calls.map((call) => (call.arguments as Record<string, unknown>).offset)).toEqual([
      0, 1, 2,
    ]);
  });

  it("takes a refused assertion as the answer, not as a failure", async () => {
    const client = new RecordingClient([
      errorResult("No registered Iceberg repository matches the requested repository reference."),
    ]);

    await expect(
      repositoryIsRegistered(client, image, { name: "my-project", location: "/checkouts/mine" }),
    ).resolves.toBe(false);
  });

  it("asks for the newest entry first to learn how far they reach", async () => {
    const client = new RecordingClient([textResult("entries:\n  index=5144\n  index=5143")]);

    const highest = await highestChangeHistoryEntryIndex(client, image, {
      historyFilePath: "/images/dev/pharo-local/Pharo.ombu",
      codeChangesOnly: true,
    });

    expect(highest).toBe(5144);
    expect(client.calls[0].arguments).toMatchObject({
      directoryPath: "/images/dev/pharo-local",
      historyFile: "Pharo.ombu",
      newestFirst: true,
    });
  });

  it("splits a history file path the way the image names one", () => {
    expect(
      changeHistoryTargetArguments({ historyFilePath: "/images/dev/local/Pharo14.ombu" }),
    ).toEqual({
      directoryPath: "/images/dev/local",
      historyFile: "Pharo14.ombu",
    });
  });
});

describe("the seam", () => {
  it("is the only place that spells an image tool", () => {
    const sourceRoot = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "src",
    );
    const seam = path.join(sourceRoot, "mcp", "imageOperations.ts");
    const offenders: string[] = [];

    const visit = (directory: string): void => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const entryPath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          visit(entryPath);
          continue;
        }
        if (!entry.name.endsWith(".ts") || entryPath === seam) {
          continue;
        }
        const source = fs.readFileSync(entryPath, "utf8");
        for (const spelling of ["tool_call", "repository_", "history_entry_", "history_file_"]) {
          if (source.includes(spelling)) {
            offenders.push(`${path.relative(sourceRoot, entryPath)} spells ${spelling}`);
          }
        }
      }
    };
    visit(sourceRoot);

    expect(offenders).toEqual([]);
  });
});
