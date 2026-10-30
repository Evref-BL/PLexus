import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { gatewayTools, rawRoutingTool } from "../../../../src/gateway/server/mcp/server.js";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);
const serverRoot = path.join(packageRoot, "src", "gateway", "server");

function sourceFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return sourceFiles(filePath);
    }

    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")
      ? [filePath]
      : [];
  });
}

function importSpecifiers(source: string): string[] {
  return [...source.matchAll(/from\s+["']([^"']+)["']/g)].map(
    (match) => match[1] as string,
  );
}

describe("gateway server module boundary", () => {
  /**
   * The gateway knowing nothing about projects, config or lifecycle is what let
   * the route registry be replaced by reading files. Merging the packages moved
   * the rule from npm to the directory; it did not retire it.
   */
  it("reaches nothing outside its own directory", () => {
    const offenders: string[] = [];
    for (const filePath of sourceFiles(serverRoot)) {
      for (const specifier of importSpecifiers(
        fs.readFileSync(filePath, "utf8"),
      )) {
        if (specifier.startsWith("node:")) {
          continue;
        }

        if (!specifier.startsWith(".")) {
          // Third-party packages are fine; sibling PLexus modules are not.
          expect(specifier.startsWith("@evref-bl/")).toBe(false);
          continue;
        }

        const resolved = path.resolve(path.dirname(filePath), specifier);
        if (!resolved.startsWith(serverRoot + path.sep)) {
          offenders.push(
            `${path.relative(packageRoot, filePath)} -> ${specifier}`,
          );
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it("keeps default gateway-owned MCP tools to route management", () => {
    expect(gatewayTools.map((tool) => tool.name)).toEqual([
      "plexus_gateway_status",
    ]);
    expect(rawRoutingTool.name).toBe("plexus_route_to_image");
  });
});
