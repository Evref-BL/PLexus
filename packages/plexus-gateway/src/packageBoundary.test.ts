import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { gatewayTools, rawRoutingTool } from "./server.js";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

function readPackageJson(): {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
} {
  return JSON.parse(
    fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"),
  ) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
}

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

describe("gateway package boundary", () => {
  it("does not import or depend on PLexus core", () => {
    const packageJson = readPackageJson();
    const dependencies = {
      ...packageJson.dependencies,
      ...packageJson.devDependencies,
    };

    expect(dependencies).not.toHaveProperty("@plexus/core");

    for (const filePath of sourceFiles(path.join(packageRoot, "src"))) {
      expect(fs.readFileSync(filePath, "utf8")).not.toContain("@plexus/core");
    }
  });

  it("keeps default gateway-owned MCP tools to route management", () => {
    expect(gatewayTools.map((tool) => tool.name)).toEqual([
      "plexus_gateway_register_target",
      "plexus_gateway_unregister_target",
      "plexus_gateway_status",
      "plexus_gateway_cleanup_stale_routes",
    ]);
    expect(rawRoutingTool.name).toBe("plexus_route_to_image");
  });
});
