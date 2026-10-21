import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readImageMcpEndpointHandoff } from "../../src/gateway/projectImageMcpEndpoint.js";

const tempDirs: string[] = [];

function handoffFile(contents: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "plexus-endpoint-"));
  tempDirs.push(directory);
  const filePath = path.join(directory, "dev.properties");
  fs.writeFileSync(filePath, contents, "utf8");
  return filePath;
}

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("image MCP endpoint handoff", () => {
  const endpoint = {
    transport: "http",
    host: "127.0.0.1",
    port: 60499,
    path: "/",
  };

  it.each([
    ["CR, as Pharo's cr writes it", "\r"],
    ["LF", "\n"],
    ["CRLF", "\r\n"],
  ])("reads a handoff separated by %s", (_label, separator) => {
    const contents = ["transport=http", "host=127.0.0.1", "port=60499", "path=/"]
      .map((line) => `${line}${separator}`)
      .join("");

    expect(readImageMcpEndpointHandoff(handoffFile(contents))).toEqual({
      status: "valid",
      path: expect.any(String),
      endpoint,
    });
  });
});
