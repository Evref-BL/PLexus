import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { parseEndpointHandoff } from "../../src/forward/endpointHandoffFormat.js";
import { callTool, listTools, ping } from "../../src/forward/index.js";

interface Received {
  method: string;
  params?: unknown;
  sessionId?: string;
  protocolVersion?: string;
}

const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))),
  );
});

/** An MCP server over HTTP, as far as forwarding needs one: canned answers. */
async function fakeMcpServer(
  answer: (request: Received) => { result?: unknown; error?: unknown; status?: number } | undefined,
): Promise<{ url: string; received: Received[] }> {
  const received: Received[] = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    request.on("end", () => {
      const message = JSON.parse(body) as { id?: string; method: string; params?: unknown };
      const seen: Received = {
        method: message.method,
        ...(message.params === undefined ? {} : { params: message.params }),
        ...(typeof request.headers["mcp-session-id"] === "string"
          ? { sessionId: request.headers["mcp-session-id"] }
          : {}),
        ...(typeof request.headers["mcp-protocol-version"] === "string"
          ? { protocolVersion: request.headers["mcp-protocol-version"] }
          : {}),
      };
      received.push(seen);
      const reply = answer(seen);
      if (message.id === undefined || reply === undefined) {
        response.writeHead(202).end();
        return;
      }
      response.writeHead(reply.status ?? 200, {
        "content-type": "application/json",
        ...(message.method === "initialize" ? { "mcp-session-id": "session-1" } : {}),
      });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, ...reply }));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`, received };
}

const classSearch = {
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
  it("lists the image's tools in the session its server opened", async () => {
    const { url, received } = await fakeMcpServer(standardAnswers);

    expect(await listTools({ url })).toEqual([classSearch]);
    expect(received.map((request) => request.method)).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/list",
    ]);
    expect(received[2]).toMatchObject({ sessionId: "session-1", protocolVersion: "2025-06-18" });
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

  it("goes without a session when the server takes no handshake", async () => {
    const { url, received } = await fakeMcpServer((request) =>
      request.method === "initialize"
        ? { error: { code: -32601, message: "Method not found" } }
        : standardAnswers(request),
    );

    expect(await listTools({ url })).toHaveLength(1);
    expect(received.at(-1)?.sessionId).toBeUndefined();
  });

  it("puts what the server said about a refused call in the error", async () => {
    const { url } = await fakeMcpServer((request) =>
      request.method === "tools/call"
        ? { error: { code: -32602, message: "Invalid method parameter(s)", data: { name: "required" } } }
        : standardAnswers(request),
    );

    await expect(callTool({ url }, "class_search")).rejects.toThrow(
      'MCP error -32602: Invalid method parameter(s) {"name":"required"}',
    );
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
