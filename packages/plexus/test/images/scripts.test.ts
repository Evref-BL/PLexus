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
    expect(source).toContain("(class registry reject: [ :each | repositoriesBefore includes: each ]) do: [ :each |");
    expect(source).toContain("Smalltalk snapshot: true andQuit: true");
    expect(source).toContain("Smalltalk exitFailure");
  });

  it("forgets only the repositories whose clone is in the image's directory, and names those clones in its status", () => {
    const source = prepareScript({ kind: "pin", version: "3.7.0" });
    const order = [
      "repositoriesBefore := ",
      "Metacello new",
      "(location isNil or: [ FileLocator imageDirectory asFileReference contains: location ]) ifTrue: [",
      "class registry remove: each ifAbsent: [ ].",
      "location ifNotNil: [ clones add: location fullName ]",
      "clones do: [ :each | stream nextPutAll: 'clone='; nextPutAll: each; cr ]",
      "Smalltalk snapshot: true andQuit: true",
    ].map((part) => source.indexOf(part));

    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((left, right) => left - right)).toEqual(order);
  });

  it("clones github:// repositories over HTTPS before it loads anything, a script's included", () => {
    for (const source of [prepareScript({ kind: "pin", version: "3.7.0" }), prepareScript({ kind: "script", script: "/load.st" })]) {
      const setting = source.indexOf("(class respondsTo: #remoteTypeSelector:) ifTrue: [ class remoteTypeSelector: #httpsUrl ]");
      expect(setting).toBeGreaterThan(0);
      expect(setting).toBeLessThan(Math.max(source.indexOf("Metacello new"), source.indexOf("fileIn.")));
      expect(setting).toBeLessThan(source.indexOf("snapshot: true"));
    }
  });

  it("loads the Telemetry group beside the default one when asked, and checks MCP got its backend", () => {
    const source = prepareScript({ kind: "pin", version: "3.8.0", telemetry: true });

    expect(source).toContain("    baseline: 'MCP';\n    load: #( 'default' 'Telemetry' ).\n");
    expect(source).toContain("(class canUnderstand: #useOpenTelemetryObservability)");
    expect(source).not.toContain("    load.");
    expect(prepareScript({ kind: "pin", version: "3.8.0" })).not.toContain("'Telemetry'");
  });

  it("says in its status whether MCP has its OpenTelemetry backend, whatever loaded it", () => {
    for (const source of [prepareScript({ kind: "pin", version: "3.8.0" }), prepareScript({ kind: "script", script: "/load.st" })]) {
      expect(source).toContain("nextPutAll: 'status=ok'; cr;\n      nextPutAll: 'telemetry=';");
      expect(source).toContain("((Smalltalk globals at: #MCP) canUnderstand: #useOpenTelemetryObservability)");
    }
  });

  it("files a script in instead, and keeps what it registered", () => {
    const source = prepareScript({ kind: "script", script: "C:\\work\\it's\\load.st" });

    expect(source).toContain("  'C:/work/it''s/load.st' asFileReference fileIn.");
    expect(source).not.toContain("Metacello");
    expect(source).not.toContain("registry reject:");
    expect(source).toContain("clones := OrderedCollection new.");
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
      "telemetry := 'no-backend'.",
      "(mcp respondsTo: #useOpenTelemetryObservability) ifTrue: [",
      "telemetry := [ mcp useOpenTelemetryObservability. nil ]",
      "'switch-failed' ] ].",
      "mcp port: 0.",
    ].map((part) => enrolled.indexOf(part));

    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((left, right) => left - right)).toEqual(order);
    expect(startScript).not.toContain("useOpenTelemetryObservability");
    expect(startScript).toContain("  telemetry := 'not-asked'.\n  mcp port: 0.");
    expect(enrolled.replace(/  telemetry := 'no-backend'\.\n[\s\S]*?'switch-failed' \] \]\.\n/, "  telemetry := 'not-asked'.\n")).toBe(
      startScript,
    );
  });

  it("says in the endpoint file whether the server records through OpenTelemetry, and why not", () => {
    const order = [
      "Smalltalk globals at: #PLexusMCPServer put: mcp.",
      "records := [",
      "mcp observability isKindOf: backend",
      "stream nextPutAll: 'path=/'; cr.",
      "ifTrue: [ stream nextPutAll: 'telemetry=on'; cr ]",
      "stream nextPutAll: 'telemetry=off'; cr.",
      "nextPutAll: 'telemetry.reason='; nextPutAll: reason",
      "nextPutAll: 'telemetry.detail='; nextPutAll: (text first: (text size min: 300))",
      "temporary renameTo: endpoint basename",
    ].map((part) => startScript.indexOf(part));

    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((left, right) => left - right)).toEqual(order);
  });
});
