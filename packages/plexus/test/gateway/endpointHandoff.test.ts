import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { readImageMcpEndpointHandoff } from "../../src/gateway/projectImageMcpEndpoint.js";
import { discoverImageMcpServers } from "../../src/gateway/server/routing/routeDiscovery.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

/** Writes one handoff file and reads it back through both readers. */
function bothReaders(body: string): {
  observed: "valid" | "invalid" | "missing";
  routedPort?: number;
} {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "plexus-handoff-"));
  tempDirs.push(stateDir);
  const statePath = path.join(stateDir, "state.json");
  fs.mkdirSync(path.join(stateDir, "mcp-endpoints"), { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, "mcp-endpoints", "dev.properties"),
    body,
    "utf8",
  );

  const observed = readImageMcpEndpointHandoff(
    path.join(stateDir, "mcp-endpoints", "dev.properties"),
  ).status;
  const routed = discoverImageMcpServers(statePath, "dev");

  return {
    observed,
    ...(routed[0] ? { routedPort: routed[0].endpoint.port } : {}),
  };
}

describe("endpoint handoff", () => {
  it("routes exactly what the runtime observation calls valid", () => {
    // The gateway used to parse a port out of each of these and route to it,
    // while the runtime observation reported the same image as stopped.
    const malformed = [
      "transport=http\nhost=127.0.0.1\nport=08080\npath=/\n",
      "transport=http\nhost=127.0.0.1\nport=8080abc\npath=/\n",
      "transport=http\nhost=127.0.0.1\nport=8080\npath=/\nnonsense\n",
      "transport=stdio\nhost=127.0.0.1\nport=8080\npath=/\n",
      "transport=http\nhost=127.0.0.1\nport=8080\npath=mcp\n",
    ];

    for (const body of malformed) {
      expect(bothReaders(body)).toEqual({ observed: "invalid" });
    }

    expect(bothReaders("transport=http\nhost=127.0.0.1\nport=8080\npath=/\n")).toEqual(
      { observed: "valid", routedPort: 8080 },
    );
    // Pharo writes its lines with a bare cr.
    expect(
      bothReaders("transport=http\rhost=127.0.0.1\rport=8080\rpath=/mcp\r"),
    ).toEqual({ observed: "valid", routedPort: 8080 });
  });
});
