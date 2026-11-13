import assert from "node:assert/strict";
import test from "node:test";
import {
  checkListedTools,
  checkToolResult,
  defaultRunId,
  formatFailure,
  parseSmokeArgs,
  resolveTemplate,
  scratchScopePrefix,
  smokeSteps,
} from "../../scripts/live-smoke-policy.mjs";

const now = new Date("2026-11-13T12:34:56Z");

test("runs in a scratch scope of its own unless given another scratch scope", () => {
  assert.equal(defaultRunId(now), "20261113T123456");
  assert.equal(parseSmokeArgs([], { now }).scope, `${scratchScopePrefix}20261113T123456`);
  assert.equal(parseSmokeArgs(["--scope", "plexus_smoke_ci"]).scope, "plexus_smoke_ci");
  assert.throws(() => parseSmokeArgs(["--scope", "Pharo4Agents"]), /scratch scope/);
});

test("reads its options, with defaults for a plain run", () => {
  assert.deepEqual(parseSmokeArgs([], { now }), {
    template: "Pharo 14.0 - 64bit",
    scope: "plexus_smoke_20261113T123456",
    name: "smoke",
    timeoutMs: 600_000,
    toolArguments: {},
    keep: false,
  });
  assert.deepEqual(
    parseSmokeArgs(
      [
        "--template=Pharo 13.0 - 64bit",
        "--category", "Official distributions",
        "--home", "/tmp/plexus",
        "--name", "dev",
        "--timeout", "90",
        "--tool", "class_search",
        "--arguments", '{"name":"MCPToolRegistry"}',
        "--expect", "class=MCPToolRegistry",
        "--keep",
      ],
      { now },
    ),
    {
      template: "Pharo 13.0 - 64bit",
      category: "Official distributions",
      home: "/tmp/plexus",
      scope: "plexus_smoke_20261113T123456",
      name: "dev",
      timeoutMs: 90_000,
      tool: "class_search",
      toolArguments: { name: "MCPToolRegistry" },
      expectedText: "class=MCPToolRegistry",
      keep: true,
    },
  );
});

test("refuses options it does not know or cannot read", () => {
  assert.throws(() => parseSmokeArgs(["--approvalProfile", "x"]), /Unknown option --approvalProfile/);
  assert.throws(() => parseSmokeArgs(["--template"]), /--template needs a value/);
  assert.throws(() => parseSmokeArgs(["dev"]), /Unexpected argument dev/);
  assert.throws(() => parseSmokeArgs(["--timeout", "0"]), /seconds/);
  assert.throws(() => parseSmokeArgs(["--arguments", "[1]"]), /JSON object/);
  assert.throws(() => parseSmokeArgs(["--expect", "x"]), /--expect needs --tool/);
});

test("creates, starts, lists, stops and deletes, and calls a tool only when asked", () => {
  assert.deepEqual(smokeSteps({}), ["create", "start", "listTools", "stop", "delete"]);
  assert.deepEqual(smokeSteps({ tool: "class_search" }), [
    "create",
    "start",
    "listTools",
    "callTool",
    "stop",
    "delete",
  ]);
});

test("finds the template behind a name the launcher suffixes", () => {
  const templates = [
    { name: "Pharo 14.0 - 64bit (next stable)", category: "Official distributions" },
    { name: "Pharo 13.0 - 64bit", category: "Official distributions" },
    { name: "Pharo 13.0 - 64bit", category: "Deprecated" },
  ];
  assert.deepEqual(resolveTemplate({ template: "Pharo 14.0 - 64bit" }, templates), {
    name: "Pharo 14.0 - 64bit (next stable)",
    category: "Official distributions",
  });
  assert.deepEqual(resolveTemplate({ template: "Pharo 13.0 - 64bit", category: "Deprecated" }, templates), {
    name: "Pharo 13.0 - 64bit",
    category: "Deprecated",
  });
  assert.throws(() => resolveTemplate({ template: "Pharo 13.0 - 64bit" }, templates), /More than one template/);
  assert.throws(() => resolveTemplate({ template: "Pharo 99" }, templates), /No template matches Pharo 99: Pharo 14\.0/);
});

test("checks what the image answers", () => {
  assert.throws(() => checkListedTools([]), /no tools/);
  assert.throws(() => checkListedTools([{ name: "eval" }], "class_search"), /does not list class_search: eval/);
  checkListedTools([{ name: "class_search" }], "class_search");

  checkToolResult({ content: [{ type: "text", text: "class=MCPToolRegistry" }] }, "class=MCPToolRegistry");
  assert.throws(() => checkToolResult({ content: [{ type: "text", text: "nope" }], isError: true }), /answered an error: nope/);
  assert.throws(() => checkToolResult({ content: [{ type: "text", text: "nope" }] }, "class="), /does not contain class=/);
});

test("names the step that failed and the code PLexus gave", () => {
  const error = Object.assign(new Error("Image smoke exited during start."), { code: "start-failed" });
  assert.equal(formatFailure("start", error), "smoke failed at start [start-failed]: Image smoke exited during start.");
  assert.equal(formatFailure("listTools", new Error("HTTP 500")), "smoke failed at listTools: HTTP 500");
});
