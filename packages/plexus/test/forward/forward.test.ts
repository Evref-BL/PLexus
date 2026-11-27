import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { parseEndpointHandoff } from "../../src/forward/endpointHandoffFormat.js";
import { callTool, callWaitMs, listTools, ping } from "../../src/forward/index.js";
import type { ForwardError } from "../../src/forward/jsonRpc.js";
import type { ImageTool } from "../../src/types.js";

interface Received {
  method: string;
  params?: unknown;
  sessionId?: string;
  protocolVersion?: string;
  /** The `mcp-method`, `mcp-name` and `mcp-param-*` headers it came with. */
  mirrored?: Record<string, string>;
}

const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(resolve));
    }),
  );
});

type Reply =
  | { result?: unknown; error?: unknown; status?: number; afterMs?: number }
  | "never"
  | "hang up"
  | "half an answer"
  | "trickle"
  | undefined;

/**
 * An MCP server over HTTP, as far as forwarding needs one: canned answers,
 * given at once or after `afterMs`, never, or a connection closed unanswered.
 * A legacy one refuses a modern request with a bare 400, as MCP did before
 * it spoke 2026-07-28.
 */
async function fakeMcpServer(
  answer: (request: Received) => Reply,
  options: { legacy?: boolean } = {},
): Promise<{ url: string; received: Received[] }> {
  const received: Received[] = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    request.on("end", () => {
      const message = JSON.parse(body) as { id?: string; method: string; params?: unknown };
      const mirrored = Object.fromEntries(
        Object.entries(request.headers).filter(
          (entry): entry is [string, string] =>
            /^mcp-(method|name|param-.*)$/.test(entry[0]) && typeof entry[1] === "string",
        ),
      );
      const seen: Received = {
        method: message.method,
        ...(message.params === undefined ? {} : { params: message.params }),
        ...(typeof request.headers["mcp-session-id"] === "string"
          ? { sessionId: request.headers["mcp-session-id"] }
          : {}),
        ...(typeof request.headers["mcp-protocol-version"] === "string"
          ? { protocolVersion: request.headers["mcp-protocol-version"] }
          : {}),
        ...(Object.keys(mirrored).length === 0 ? {} : { mirrored }),
      };
      received.push(seen);
      if (options.legacy && seen.protocolVersion === "2026-07-28") {
        response.writeHead(400).end();
        return;
      }
      const reply = answer(seen);
      if (reply === "never") {
        return;
      }
      if (reply === "hang up") {
        request.socket.destroy();
        return;
      }
      if (reply === "trickle") {
        // Headers at once, then a byte now and then, never the end.
        response.writeHead(200, { "content-type": "application/json" });
        const drip = setInterval(() => response.write(" "), 50);
        response.on("close", () => clearInterval(drip));
        return;
      }
      if (reply === "half an answer") {
        response.writeHead(200, { "content-type": "application/json", "content-length": "1000" });
        response.write('{"jsonrpc":"2.0",', () => request.socket.destroy());
        return;
      }
      if (message.id === undefined || reply === undefined) {
        response.writeHead(202).end();
        return;
      }
      const { afterMs, ...rest } = reply;
      setTimeout(() => {
        response.writeHead(rest.status ?? 200, {
          "content-type": "application/json",
          ...(message.method === "initialize" ? { "mcp-session-id": "session-1" } : {}),
        });
        response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, ...rest }));
      }, afterMs ?? 0);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`, received };
}

const classSearch: ImageTool = {
  name: "class_search",
  description: "Find classes.",
  inputSchema: { type: "object", properties: { name: { type: "string" } } },
};

function standardAnswers(request: Received) {
  switch (request.method) {
    case "initialize":
      return { result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "MCP" } } };
    case "tools/list":
      return { result: { tools: [classSearch] } };
    case "tools/call":
      return { result: { content: [{ type: "text", text: "class=MCPToolRegistry" }] } };
    case "ping":
      return { result: {} };
    default:
      return undefined;
  }
}

describe("forwarding", () => {
  it("lists the image's tools in one modern request, which names the revision, PLexus and no capability", async () => {
    const { url, received } = await fakeMcpServer(standardAnswers);

    expect(await listTools({ url })).toEqual([classSearch]);
    expect(received).toEqual([
      {
        method: "tools/list",
        params: {
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientInfo": { name: "plexus", version: expect.any(String) },
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
        protocolVersion: "2026-07-28",
        mirrored: { "mcp-method": "tools/list" },
      },
    ]);
  });

  it("lists a legacy image's tools in the session it opens once the modern request is refused", async () => {
    const { url, received } = await fakeMcpServer(standardAnswers, { legacy: true });

    expect(await listTools({ url })).toEqual([classSearch]);
    expect(received.map((request) => request.method)).toEqual([
      "tools/list",
      "initialize",
      "notifications/initialized",
      "tools/list",
    ]);
    expect(received[1].params).toMatchObject({ protocolVersion: "2025-11-25" });
    expect(received[3]).toMatchObject({ sessionId: "session-1", protocolVersion: "2025-06-18" });
    expect(received[3]).not.toHaveProperty("params");
    expect(received[3]).not.toHaveProperty("mirrored");
  });

  it("falls back when a refusal says the image speaks only legacy revisions, and not when it names only modern ones", async () => {
    const unsupported = (supported: string[]) => (request: Received) =>
      request.protocolVersion === "2026-07-28"
        ? { status: 400, error: { code: -32022, message: "Unsupported protocol version", data: { supported, requested: "2026-07-28" } } }
        : standardAnswers(request);

    const legacy = await fakeMcpServer(unsupported(["2025-11-25", "2025-06-18"]));
    expect(await listTools({ url: legacy.url })).toEqual([classSearch]);
    expect(legacy.received.map((request) => request.method)).toEqual(["tools/list", "initialize", "notifications/initialized", "tools/list"]);

    const newer = await fakeMcpServer(unsupported(["2027-01-01"]));
    expect(await failureOf(listTools({ url: newer.url }))).toMatchObject({ kind: "answered", rpcCode: -32022 });
    expect(newer.received.map((request) => request.method)).toEqual(["tools/list"]);
  });

  it("does not fall back on an error only a modern server answers", async () => {
    for (const code of [-32020, -32021, -32601]) {
      const { url, received } = await fakeMcpServer((request) =>
        request.method === "tools/call" ? { status: code === -32601 ? 404 : 400, error: { code, message: "no" } } : standardAnswers(request),
      );
      expect(await failureOf(callTool({ url }, "class_search", {}, { inputSchema: classSearch.inputSchema }))).toMatchObject({
        kind: "answered",
        rpcCode: code,
      });
      expect(received.map((request) => request.method)).toEqual(["tools/call"]);
    }
  });

  it("mirrors the call's tool name, in the Base64 sentinel when it is no plain ASCII", async () => {
    const { url, received } = await fakeMcpServer(standardAnswers);

    await callTool({ url }, "class_search", {});
    await callTool({ url }, "cherche_\u00e9l\u00e8ve", {});
    await callTool({ url }, "=?base64?abc?=", {});

    expect(received.map((request) => request.mirrored)).toEqual([
      { "mcp-method": "tools/call", "mcp-name": "class_search" },
      { "mcp-method": "tools/call", "mcp-name": `=?base64?${Buffer.from("cherche_\u00e9l\u00e8ve").toString("base64")}?=` },
      { "mcp-method": "tools/call", "mcp-name": `=?base64?${Buffer.from("=?base64?abc?=").toString("base64")}?=` },
    ]);
  });

  it("calls a tool and answers its result as the server sent it", async () => {
    const { url, received } = await fakeMcpServer(standardAnswers);

    expect(await callTool({ url }, "class_search", { name: "MCPToolRegistry" })).toEqual({
      content: [{ type: "text", text: "class=MCPToolRegistry" }],
    });
    expect(received.at(-1)).toMatchObject({
      method: "tools/call",
      params: { name: "class_search", arguments: { name: "MCPToolRegistry" } },
    });
  });

  it("goes without a session when a legacy server takes no handshake", async () => {
    const { url, received } = await fakeMcpServer(
      (request) =>
        request.method === "initialize"
          ? { error: { code: -32601, message: "Method not found" } }
          : standardAnswers(request),
      { legacy: true },
    );

    expect(await listTools({ url })).toHaveLength(1);
    expect(received.map((request) => request.method)).toEqual(["tools/list", "initialize", "tools/list"]);
    expect(received.at(-1)?.sessionId).toBeUndefined();
    expect(received.at(-1)?.protocolVersion).toBeUndefined();
  });

  it("puts what the server said about a refused call in the error, as answered with its code", async () => {
    const { url } = await fakeMcpServer((request) =>
      request.method === "tools/call"
        ? { error: { code: -32602, message: "Invalid method parameter(s)", data: { name: "required" } } }
        : standardAnswers(request),
    );

    expect(await failureOf(callTool({ url }, "class_search"))).toEqual({
      message: 'MCP error -32602: Invalid method parameter(s) {"name":"required"}',
      kind: "answered",
      rpcCode: -32602,
    });
  });

  it("pings within its time, however slowly an answer trickles in", async () => {
    const { url } = await fakeMcpServer(() => "trickle");
    const startedAt = Date.now();
    expect(await ping({ url }, 200)).toBe(false);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  it("pings: any JSON-RPC answer counts, and nothing listening does not", async () => {
    const answering = await fakeMcpServer((request) =>
      request.method === "ping" ? { error: { code: -32601, message: "Method not found" } } : undefined,
    );
    expect(await ping({ url: answering.url })).toBe(true);

    const wantsASession = await fakeMcpServer(() => ({
      status: 400,
      error: { code: -32000, message: "Bad Request: no session" },
    }));
    expect(await ping({ url: wantsASession.url })).toBe(true);

    const closed = await fakeMcpServer(standardAnswers);
    await new Promise((resolve) => servers.pop()!.close(resolve));
    expect(await ping({ url: closed.url })).toBe(false);
  });
});

/** What a rejection says: its message, its kind, and what the kind carries. */
async function failureOf(promise: Promise<unknown>): Promise<Record<string, unknown>> {
  const error = (await promise.then(
    () => {
      throw new Error("expected a rejection");
    },
    (rejected: unknown) => rejected,
  )) as ForwardError;
  return {
    message: error.message,
    kind: error.kind,
    ...("rpcCode" in error ? { rpcCode: error.rpcCode } : {}),
    ...("waitedMs" in error ? { waitedMs: error.waitedMs } : {}),
  };
}

const testRun = {
  type: "object",
  properties: { timeoutSeconds: { type: "integer", default: 90 } },
} as const;

describe("a forwarded call", () => {
  it("says it was sent and not answered, in today's words, and is not sent again", async () => {
    const { url, received } = await fakeMcpServer((request) =>
      request.method === "tools/call" ? "never" : standardAnswers(request),
    );

    expect(await failureOf(callTool({ url }, "class_search", {}, { minimumMs: 100 }))).toEqual({
      message: "MCP request timed out after 100ms",
      kind: "timeout",
      waitedMs: 100,
    });
    expect(received.map((request) => request.method)).toEqual(["tools/call"]);
  });

  it("ends at its time, however slowly an answer trickles in", async () => {
    const { url } = await fakeMcpServer((request) =>
      request.method === "tools/call" ? "trickle" : standardAnswers(request),
    );

    expect(await failureOf(callTool({ url }, "class_search", {}, { minimumMs: 200 }))).toEqual({
      message: "MCP request timed out after 200ms",
      kind: "timeout",
      waitedMs: 200,
    });
  });

  it("is not sent again when a legacy image does not answer the handshake", async () => {
    const { url, received } = await fakeMcpServer(
      (request) => (request.method === "initialize" ? "never" : standardAnswers(request)),
      { legacy: true },
    );

    expect(await failureOf(callTool({ url }, "class_search", {}, { minimumMs: 100 }))).toEqual({
      message: "MCP initialize timed out after 100ms",
      kind: "no-handshake",
      waitedMs: 100,
    });
    expect(received.map((request) => request.method)).toEqual(["tools/call", "initialize"]);
  });

  it("says nothing was sent to a port nobody listens on", async () => {
    const { url } = await fakeMcpServer(standardAnswers);
    const server = servers.pop()!;
    await new Promise((resolve) => server.close(resolve));

    const failure = await failureOf(callTool({ url }, "class_search"));
    expect(failure.kind).toBe("refused");
    expect(failure.message).toContain("ECONNREFUSED");
  });

  it("says the connection closed after the call was sent, in Node's words", async () => {
    const { url } = await fakeMcpServer((request) =>
      request.method === "tools/call" ? "hang up" : standardAnswers(request),
    );

    expect(await failureOf(callTool({ url }, "class_search"))).toEqual({
      message: "socket hang up",
      kind: "closed",
    });
  });

  it("says the connection closed in the middle of the answer, rather than waiting on it", async () => {
    const { url } = await fakeMcpServer((request) =>
      request.method === "tools/call" ? "half an answer" : standardAnswers(request),
    );

    expect(await failureOf(callTool({ url }, "class_search"))).toEqual({ message: "aborted", kind: "closed" });
  });

  it("answers a refusal sent with an HTTP error status as the JSON-RPC error it carries", async () => {
    const { url } = await fakeMcpServer((request) =>
      request.method === "tools/call"
        ? { status: 400, error: { code: -32600, message: "Bad Request: MCP-Protocol-Version does not match the body" } }
        : standardAnswers(request),
    );

    expect(await failureOf(callTool({ url }, "class_search"))).toEqual({
      message: "MCP error -32600: Bad Request: MCP-Protocol-Version does not match the body",
      kind: "answered",
      rpcCode: -32600,
    });
  });

  it("says an HTTP error status whose body is no JSON-RPC error as other", async () => {
    const { url } = await fakeMcpServer((request) =>
      request.method === "tools/call" ? { status: 400, error: "Bad Request" } : standardAnswers(request),
    );

    expect(await failureOf(callTool({ url }, "class_search"))).toEqual({ message: "HTTP 400 Bad Request", kind: "other" });
  });

  it("sends the call without a session when a server refuses both the modern request and the handshake", async () => {
    const { url, received } = await fakeMcpServer((request) => {
      if (request.protocolVersion === "2026-07-28") {
        return { status: 400, error: { code: -32600, message: "Bad Request: no session" } };
      }
      return request.method === "initialize"
        ? { status: 400, error: { code: -32602, message: "Unsupported protocol version" } }
        : standardAnswers(request);
    });

    expect(await callTool({ url }, "class_search")).toEqual({ content: [{ type: "text", text: "class=MCPToolRegistry" }] });
    expect(received.map((request) => request.method)).toEqual(["tools/call", "initialize", "tools/call"]);
    expect(received[2]).not.toHaveProperty("sessionId");
  });

  it("says what else went wrong as other", async () => {
    const { url } = await fakeMcpServer((request) =>
      request.method === "tools/call" ? { status: 500 } : standardAnswers(request),
    );

    expect(await failureOf(callTool({ url }, "class_search"))).toEqual({
      message: "HTTP 500 Internal Server Error",
      kind: "other",
    });
  });

  it("waits the minimum with no time limit, and the call's limit plus 30 s with one", async () => {
    const { url } = await fakeMcpServer((request) =>
      request.method === "tools/call"
        ? { result: { content: [{ type: "text", text: "done" }] }, afterMs: 250 }
        : standardAnswers(request),
    );

    expect((await failureOf(callTool({ url }, "slow", {}, { minimumMs: 100 }))).kind).toBe("timeout");
    expect(await callTool({ url }, "slow", { timeoutSeconds: 0 }, { minimumMs: 100 })).toEqual({
      content: [{ type: "text", text: "done" }],
    });
  });

  it("takes a time limit longer than Node's timers keep, with no warning", async () => {
    const { url } = await fakeMcpServer(standardAnswers);
    const warnings: string[] = [];
    const onWarning = (warning: Error) => warnings.push(warning.name);
    process.on("warning", onWarning);
    try {
      for (const timeoutSeconds of [1e10, 1e308]) {
        expect(await callTool({ url }, "class_search", { timeoutSeconds })).toEqual({
          content: [{ type: "text", text: "class=MCPToolRegistry" }],
        });
      }
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      process.off("warning", onWarning);
    }
    expect(warnings).toEqual([]);
  });

  it("is cancelled by its signal, before it is sent and while it waits", async () => {
    const { url, received } = await fakeMcpServer((request) =>
      request.method === "tools/call" ? "never" : standardAnswers(request),
    );

    expect(
      await failureOf(callTool({ url }, "class_search", {}, { signal: AbortSignal.abort() })),
    ).toEqual({ message: "MCP request cancelled", kind: "cancelled" });
    expect(received).toEqual([]);

    const controller = new AbortController();
    const call = callTool({ url }, "class_search", {}, { signal: controller.signal });
    while (!received.some((request) => request.method === "tools/call")) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    controller.abort();
    expect(await failureOf(call)).toEqual({ message: "MCP request cancelled", kind: "cancelled" });
  });

  it("waits longer than the image's own limit, and never less than the minimum", () => {
    expect(callWaitMs({ timeoutSeconds: 120 })).toBe(150_000);
    expect(callWaitMs({ timeoutSeconds: 120 }, { inputSchema: testRun })).toBe(150_000);
    expect(callWaitMs({}, { inputSchema: testRun })).toBe(120_000);
    expect(callWaitMs({ timeoutSeconds: 10 })).toBe(60_000);
    expect(callWaitMs({})).toBe(60_000);
    expect(callWaitMs({ timeoutSeconds: 120 }, { minimumMs: 300_000 })).toBe(300_000);
    expect(callWaitMs({ timeoutSeconds: -1 }, { inputSchema: testRun })).toBe(120_000);
    expect(callWaitMs({ timeoutSeconds: "120" })).toBe(60_000);
  });

  it("waits no longer than the listed maximum allows, nor than Node's timers keep", () => {
    const evaluate = {
      type: "object",
      properties: { timeoutSeconds: { type: "integer", default: 30, maximum: 600 } },
    } as const;
    expect(callWaitMs({ timeoutSeconds: 1e10 }, { inputSchema: evaluate })).toBe(630_000);
    expect(callWaitMs({ timeoutSeconds: 300 }, { inputSchema: evaluate })).toBe(330_000);
    expect(callWaitMs({}, { inputSchema: evaluate })).toBe(60_000);
    expect(callWaitMs({ timeoutSeconds: 1e10 }, { inputSchema: testRun })).toBe(2 ** 31 - 1);
    expect(callWaitMs({ timeoutSeconds: 1e308 })).toBe(2 ** 31 - 1);
    expect(callWaitMs({}, { minimumMs: 1e12 })).toBe(2 ** 31 - 1);
  });
});

const sqlTool: ImageTool = {
  name: "execute_sql",
  inputSchema: {
    type: "object",
    properties: {
      region: { type: "string", "x-mcp-header": "Region" },
      options: { type: "object", properties: { dryRun: { type: "boolean", "x-mcp-header": "Dry-Run" } } },
      query: { type: "string" },
    },
  },
};

describe("x-mcp-header", () => {
  it("mirrors the annotated parameters a call gives", async () => {
    const { url, received } = await fakeMcpServer(standardAnswers);

    await callTool({ url }, "execute_sql", { region: "us-west1", options: { dryRun: true }, query: "SELECT 1" }, { inputSchema: sqlTool.inputSchema });
    await callTool({ url }, "execute_sql", { query: "SELECT 1" }, { inputSchema: sqlTool.inputSchema });

    expect(received.map((request) => request.mirrored)).toEqual([
      { "mcp-method": "tools/call", "mcp-name": "execute_sql", "mcp-param-region": "us-west1", "mcp-param-dry-run": "true" },
      { "mcp-method": "tools/call", "mcp-name": "execute_sql" },
    ]);
  });

  it("lists the image's tools and calls again with the headers when a call made without its schema is refused for them", async () => {
    const { url, received } = await fakeMcpServer((request) => {
      if (request.method === "tools/list") {
        return { result: { tools: [classSearch, sqlTool] } };
      }
      if (request.method === "tools/call" && request.mirrored?.["mcp-param-region"] === undefined) {
        return { status: 400, error: { code: -32020, message: "Header mismatch: Mcp-Param-Region is missing" } };
      }
      return standardAnswers(request);
    });

    expect(await callTool({ url }, "execute_sql", { region: "eu", query: "SELECT 1" })).toEqual({
      content: [{ type: "text", text: "class=MCPToolRegistry" }],
    });
    expect(received.map((request) => request.method)).toEqual(["tools/call", "tools/list", "tools/call"]);
    expect(received[2].mirrored).toMatchObject({ "mcp-param-region": "eu" });
  });

  it("does not call again when the listed schema asks for no header the call lacked", async () => {
    const { url, received } = await fakeMcpServer((request) =>
      request.method === "tools/call" ? { status: 400, error: { code: -32020, message: "Header mismatch" } } : standardAnswers(request),
    );

    expect(await failureOf(callTool({ url }, "class_search", { name: "X" }))).toMatchObject({ kind: "answered", rpcCode: -32020 });
    expect(received.map((request) => request.method)).toEqual(["tools/call", "tools/list"]);
  });

  it("leaves out a listed tool whose annotations break the rules, with a warning", async () => {
    const broken = { name: "broken", inputSchema: { type: "object", properties: { at: { type: "number", "x-mcp-header": "At" } } } };
    const { url } = await fakeMcpServer((request) =>
      request.method === "tools/list" ? { result: { tools: [classSearch, broken, sqlTool] } } : standardAnswers(request),
    );
    const warnings: string[] = [];
    const onWarning = (warning: Error) => warnings.push(warning.message);
    process.on("warning", onWarning);
    try {
      expect((await listTools({ url })).map((tool) => tool.name)).toEqual(["class_search", "execute_sql"]);
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      process.off("warning", onWarning);
    }
    expect(warnings).toEqual([expect.stringContaining("Left out tool broken")]);
  });
});

describe("the endpoint file", () => {
  it("reads what an image writes, with Pharo's bare cr", () => {
    expect(parseEndpointHandoff("transport=http\rhost=127.0.0.1\rport=8080\rpath=/\rpid=42\r")).toEqual({
      transport: "http",
      host: "127.0.0.1",
      port: 8080,
      path: "/",
      pid: 42,
    });
  });

  it("refuses anything it would have to guess at", () => {
    for (const body of [
      "transport=http\nhost=127.0.0.1\nport=08080\npath=/\n",
      "transport=http\nhost=127.0.0.1\nport=8080abc\npath=/\n",
      "transport=http\nhost=127.0.0.1\nport=8080\npath=/\nnonsense\n",
      "transport=stdio\nhost=127.0.0.1\nport=8080\npath=/\n",
      "transport=http\nhost=127.0.0.1\nport=8080\npath=mcp\n",
      "transport=http\nhost=127.0.0.1\nport=8080\npath=/\npid=0\n",
    ]) {
      expect(() => parseEndpointHandoff(body), body).toThrow();
    }
  });
});
