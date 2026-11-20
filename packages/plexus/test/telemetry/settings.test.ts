import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { applySettingsFile, parseSettings, settingsFile } from "../../src/telemetry/settings.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function fileHolding(text: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "plexus-settings-"));
  directories.push(directory);
  const file = path.join(directory, "otel.env");
  fs.writeFileSync(file, text);
  return file;
}

describe("the settings file the Pharo tools share", () => {
  it("is where the plugin and Pharo MCP look", () => {
    expect(settingsFile({ XDG_CONFIG_HOME: "/config" }, "linux", "/home/ada")).toBe("/config/pharo-agent/otel.env");
    expect(settingsFile({ XDG_CONFIG_HOME: "relative" }, "darwin", "/Users/ada")).toBe("/Users/ada/.config/pharo-agent/otel.env");
    expect(settingsFile({ APPDATA: "C:\\Users\\Ada\\AppData\\Roaming" }, "win32", "C:\\Users\\Ada")).toBe(
      "C:\\Users\\Ada\\AppData\\Roaming\\pharo-agent\\otel.env",
    );
  });

  it("gives its OTEL_* settings and nothing else", () => {
    expect(
      parseSettings(
        "# joined\n\nexport OTEL_EXPORTER_OTLP_ENDPOINT = https://c.test\nOTEL_EXPORTER_OTLP_HEADERS=\"authorization=Bearer%20t\"\nPATH=/elsewhere\nnot a setting\n",
      ),
    ).toEqual({
      OTEL_EXPORTER_OTLP_ENDPOINT: "https://c.test",
      OTEL_EXPORTER_OTLP_HEADERS: "authorization=Bearer%20t",
    });
  });

  it("is applied only to an environment without settings of its own", () => {
    const file = fileHolding("OTEL_EXPORTER_OTLP_ENDPOINT=https://c.test\n");
    const bare: NodeJS.ProcessEnv = {};
    expect(applySettingsFile(bare, file)).toEqual({ OTEL_EXPORTER_OTLP_ENDPOINT: "https://c.test" });
    expect(bare.OTEL_EXPORTER_OTLP_ENDPOINT).toBe("https://c.test");

    const own: NodeJS.ProcessEnv = { OTEL_SERVICE_NAME: "mine" };
    expect(applySettingsFile(own, file)).toEqual({});
    expect(own.OTEL_EXPORTER_OTLP_ENDPOINT).toBeUndefined();

    expect(applySettingsFile({}, path.join(os.tmpdir(), "no-such-dir", "otel.env"))).toEqual({});
  });
});

const cli = fileURLToPath(new URL("../../dist/cli.js", import.meta.url));

describe("the plexus command", () => {
  it("sends its spans where the settings file says, when its environment says nothing", async () => {
    const bodies: string[] = [];
    const server = http.createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8").on("data", (chunk) => { body += chunk; }).on("end", () => {
        bodies.push(body);
        response.writeHead(200, { "content-type": "application/json" }).end("{}");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const config = fs.mkdtempSync(path.join(os.tmpdir(), "plexus-config-"));
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "plexus-home-"));
      directories.push(config, home);
      fs.mkdirSync(path.join(config, "pharo-agent"));
      fs.writeFileSync(
        path.join(config, "pharo-agent", "otel.env"),
        `OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:${(server.address() as AddressInfo).port}\nOTEL_EXPORTER_OTLP_PROTOCOL=http/json\n`,
      );
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("OTEL_") && key !== "PLEXUS_TELEMETRY"));
      const status = await new Promise<number | null>((resolve) => {
        const child = spawn(process.execPath, [cli, "image", "stop", "no-such-image", "--home", home], {
          env: { ...env, XDG_CONFIG_HOME: config, XDG_CACHE_HOME: home },
          stdio: "ignore",
        });
        child.on("close", resolve);
      });
      expect(status).toBe(1);
      expect(bodies.join("\n")).toContain("plexus.image.stop");
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
