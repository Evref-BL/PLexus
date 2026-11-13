import { describe, expect, it } from "vitest";
import { PlexusError } from "../../src/errors.js";
import { imagesContext } from "../../src/images/context.js";
import { checkScope, diskName, nameOfDisk } from "../../src/images/names.js";

function code(action: () => unknown): string | undefined {
  try {
    action();
  } catch (error) {
    return error instanceof PlexusError ? error.code : String(error);
  }
  return undefined;
}

describe("names", () => {
  it("prefixes the scope to make the directory name", () => {
    expect(diskName("dev", "Pharo4Agents")).toBe("Pharo4Agents-dev");
    expect(diskName("dev", undefined)).toBe("dev");
  });

  it("takes letters, digits, dots, dashes and underscores, up to 64", () => {
    expect(diskName("a.b_c-9", undefined)).toBe("a.b_c-9");
    expect(diskName("x".repeat(64), undefined)).toHaveLength(64);
    for (const bad of ["", "-dev", ".dev", "dev/x", "../dev", "de v", "x".repeat(65), 42, undefined]) {
      expect(code(() => diskName(bad, undefined)), String(bad)).toBe("invalid-name");
    }
  });

  it("keeps the build prefix for the bases being built", () => {
    expect(code(() => diskName("plexus-build-1", undefined))).toBe("invalid-name");
    expect(nameOfDisk("plexus-build-1a2b", undefined)).toBeUndefined();
  });

  it("holds a scope to the same rule", () => {
    expect(checkScope("Pharo4Agents")).toBe("Pharo4Agents");
    expect(checkScope(undefined)).toBeUndefined();
    expect(code(() => checkScope("my workspace"))).toBe("invalid-name");
    expect(code(() => imagesContext({ scope: "a/b" }))).toBe("invalid-name");
  });

  it("reads a directory back as a name in scope, or as out of it", () => {
    expect(nameOfDisk("Pharo4Agents-dev", "Pharo4Agents")).toBe("dev");
    expect(nameOfDisk("Pharo4Agents-Pharo4Agents-dev-pharo14", "Pharo4Agents")).toBe(
      "Pharo4Agents-dev-pharo14",
    );
    expect(nameOfDisk("Other-dev", "Pharo4Agents")).toBeUndefined();
    expect(nameOfDisk("Pharo4Agents-", "Pharo4Agents")).toBeUndefined();
    expect(nameOfDisk("Pharo4Agents", "Pharo4Agents")).toBeUndefined();
    expect(nameOfDisk("pifs-linux", undefined)).toBe("pifs-linux");
  });
});
