import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const cli = fileURLToPath(new URL("../../dist/cli.js", import.meta.url));
const directories: string[] = [];
const servers: http.Server[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

/** A collector that keeps every body it receives. */
async function receiver(): Promise<{ endpoint: string; bodies: string[] }> {
  const bodies: string[] = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8").on("data", (chunk) => { body += chunk; }).on("end", () => {
      bodies.push(body);
      response.writeHead(200, { "content-type": "application/json" }).end("{}");
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, bodies };
}

/** `plexus mcp` sending to `endpoint`, with the host's handshake done and one tools/call answered. */
async function servingOneCall(endpoint: string, delayMs: number): Promise<ChildProcess> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "plexus-mcp-home-"));
  directories.push(home);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("OTEL_") && key !== "PLEXUS_TELEMETRY"));
  const child = spawn(process.execPath, [cli, "mcp", "--home", home], {
    env: {
      ...env,
      XDG_CONFIG_HOME: home,
      XDG_CACHE_HOME: home,
      OTEL_EXPORTER_OTLP_ENDPOINT: endpoint,
      OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
      OTEL_BSP_SCHEDULE_DELAY: String(delayMs),
    },
    stdio: ["pipe", "pipe", "ignore"],
  });
  let buffer = "";
  const answered = new Map<number, () => void>();
  child.stdout!.setEncoding("utf8").on("data", (chunk: string) => {
    buffer += chunk;
    let end: number;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const message = JSON.parse(buffer.slice(0, end)) as { id?: number };
      buffer = buffer.slice(end + 1);
      if (message.id !== undefined) answered.get(message.id)?.();
    }
  });
  const send = (id: number, method: string, params: object) =>
    new Promise<void>((resolve) => {
      answered.set(id, resolve);
      child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  await send(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude-code", version: "2.1.330" } });
  child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  await send(2, "tools/call", { name: "image_list", arguments: {} });
  return child;
}

const ended = (child: ChildProcess) => new Promise<number | null>((resolve) => child.on("close", (code) => resolve(code)));

describe("plexus mcp's telemetry", () => {
  // Windows has no signal to handle: killing a process there ends it outright.
  it.skipIf(process.platform === "win32")("sends its spans before a host's SIGTERM ends it", async () => {
    const { endpoint, bodies } = await receiver();
    // A delay no test waits out: only the flush on the signal can send.
    const child = await servingOneCall(endpoint, 60_000);
    const exit = ended(child);
    child.kill("SIGTERM");
    expect(await exit).toBe(143);
    const sent = bodies.join("\n");
    expect(sent).toContain("tools/call image_list");
    expect(sent).toContain("plexus.client.name");
    expect(sent).toContain("session.id");
  }, 30_000);

  it("exits once its input closes, while an export still waits on a collector that never finishes answering", async () => {
    const trickles: NodeJS.Timeout[] = [];
    const server = http.createServer((request, response) => {
      request.resume();
      response.writeHead(200, { "content-type": "application/json" });
      trickles.push(setInterval(() => response.write(" "), 100));
    });
    servers.push(server);
    server.on("close", () => trickles.forEach(clearInterval));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const child = await servingOneCall(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, 100);
    await new Promise((resolve) => setTimeout(resolve, 500));
    const exit = ended(child);
    const closedAt = Date.now();
    child.stdin!.end();
    expect(await exit).toBe(0);
    expect(Date.now() - closedAt).toBeLessThan(5_000);
    trickles.forEach(clearInterval);
    server.closeAllConnections();
  }, 30_000);

  it("sends a batch after OTEL_BSP_SCHEDULE_DELAY, while it keeps serving", async () => {
    const { endpoint, bodies } = await receiver();
    const child = await servingOneCall(endpoint, 100);
    try {
      for (let attempt = 0; attempt < 40 && bodies.length === 0; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(bodies.join("\n")).toContain("tools/call image_list");
    } finally {
      const exit = ended(child);
      child.kill("SIGTERM");
      await exit;
    }
  }, 30_000);
});
