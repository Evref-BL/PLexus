import { describe, expect, it } from "vitest";
import { prepareScript, startScript } from "../../src/images/scripts.js";

describe("the preparation script", () => {
  it("loads the pinned release and forgets the repositories it registered", () => {
    const source = prepareScript({ kind: "pin", version: "3.7.0" });

    expect(source).toContain(
      [
        "  Metacello new",
        "    githubUser: 'Evref-BL' project: 'MCP' commitish: 'v3.7.0' path: 'src';",
        "    baseline: 'MCP';",
        "    load.",
      ].join("\n"),
    );
    expect(source).toContain("(class registry reject: [ :each | repositoriesBefore includes: each ])");
    expect(source).toContain("Smalltalk snapshot: true andQuit: true");
    expect(source).toContain("Smalltalk exitFailure");
  });

  it("files a script in instead, and keeps what it registered", () => {
    const source = prepareScript({ kind: "script", script: "C:\\work\\it's\\load.st" });

    expect(source).toContain("  'C:/work/it''s/load.st' asFileReference fileIn.");
    expect(source).not.toContain("Metacello");
    expect(source).not.toContain("registry reject:");
  });
});

describe("the start script", () => {
  it("is the same for every image: it finds everything from the image's directory", () => {
    expect(startScript).toContain("dir := FileLocator imageDirectory asFileReference / 'plexus'.");
    expect(startScript).not.toMatch(/'\/|'[A-Z]:/);
  });

  it("files in the every-start script, then starts MCP on a free port and says where", () => {
    const order = [
      "(dir / 'on-start') exists",
      "(Smalltalk globals includesKey: #MCP)",
      "#PLexusMCPServer ifAbsent:",
      "uniqueInstance getpid",
      "mcp port: 0.",
      "Smalltalk globals at: #PLexusMCPServer put: mcp.",
      "temporary renameTo: endpoint basename",
      "Smalltalk exitFailure",
      "Semaphore new wait.",
    ].map((part) => startScript.indexOf(part));

    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((left, right) => left - right)).toEqual(order);
    expect(startScript).not.toContain("snapshot");
  });
});
