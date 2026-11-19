import { describe, expect, it } from "vitest";
import { prepareScript, startScript as startScriptFor } from "../../src/images/scripts.js";

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

  it("loads the Telemetry group beside the default one when asked, and checks MCP got its backend", () => {
    const source = prepareScript({ kind: "pin", version: "3.8.0", telemetry: true });

    expect(source).toContain("    baseline: 'MCP';\n    load: #( 'default' 'Telemetry' ).\n");
    expect(source).toContain("(class canUnderstand: #useOpenTelemetryObservability)");
    expect(source).not.toContain("    load.");
    expect(prepareScript({ kind: "pin", version: "3.8.0" })).not.toContain("Telemetry");
  });

  it("files a script in instead, and keeps what it registered", () => {
    const source = prepareScript({ kind: "script", script: "C:\\work\\it's\\load.st" });

    expect(source).toContain("  'C:/work/it''s/load.st' asFileReference fileIn.");
    expect(source).not.toContain("Metacello");
    expect(source).not.toContain("registry reject:");
  });
});

describe("the start script", () => {
  const startScript = startScriptFor();

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

  it("switches the server to OpenTelemetry before it starts only with telemetry, and only when it can", () => {
    const enrolled = startScriptFor({ telemetry: true });
    const order = [
      "mcp := (Smalltalk globals at: #MCP) new.",
      "(mcp respondsTo: #useOpenTelemetryObservability) ifTrue: [",
      "[ mcp useOpenTelemetryObservability ] on: Error do: [ :error | nil ] ].",
      "mcp port: 0.",
    ].map((part) => enrolled.indexOf(part));

    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((left, right) => left - right)).toEqual(order);
    expect(startScript).not.toContain("useOpenTelemetryObservability");
    expect(enrolled.replace(/  \(mcp respondsTo:[\s\S]*?error \| nil \] \]\.\n/, "")).toBe(startScript);
  });
});
