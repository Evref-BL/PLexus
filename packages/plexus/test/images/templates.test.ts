import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { templates } from "../../src/images/templates.js";
import { failed, FakeLauncher, tempHome, testContext } from "../support/fakeLauncher.js";

function writeSourcesList(home: string, groups: string[]): void {
  const dir = path.join(home, "profiles", "templates");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "sources.list"),
    groups
      .map((group) => `{ #type : #URLGroup, #name : '${group.replaceAll("'", "''")}', #templates : [ ] }`)
      .join(",\n"),
  );
}

describe("templates", () => {
  it("walks the sources list's categories and marks a name in two as ambiguous", async () => {
    const home = tempHome();
    const launcher = new FakeLauncher(home);
    writeSourcesList(home, ["Official distributions", "Moose's", "Retired"]);
    launcher.templatesByCategory = {
      "Official distributions": ["Pharo 14.0 - 64bit", "Pharo 13.0 - 64bit"],
      "Moose's": ["Pharo 13.0 - 64bit", "Moose 12"],
    };

    expect(await templates(testContext(home, launcher))).toEqual([
      { name: "Pharo 14.0 - 64bit", category: "Official distributions" },
      { name: "Pharo 13.0 - 64bit", category: "Official distributions", ambiguous: true },
      { name: "Pharo 13.0 - 64bit", category: "Moose's", ambiguous: true },
      { name: "Moose 12", category: "Moose's" },
    ]);
    expect(launcher.called("updateTemplates")).toHaveLength(1);
    expect(launcher.called("listTemplateCategories")).toEqual([]);
    expect(launcher.called("listTemplates")).toEqual([
      { templateCategory: "Official distributions" },
      { templateCategory: "Moose's" },
      { templateCategory: "Retired" },
    ]);
  });

  it("asks the launcher for categories when there is no sources list", async () => {
    const home = tempHome();
    const launcher = new FakeLauncher(home);

    expect(await templates(testContext(home, launcher))).toEqual([
      { name: "Pharo 14.0 - 64bit", category: "Official distributions" },
    ]);
    expect(launcher.called("listTemplateCategories")).toHaveLength(1);
  });

  it("skips a category the launcher cannot list, unless it can list none", async () => {
    const home = tempHome();
    const launcher = new FakeLauncher(home);
    writeSourcesList(home, ["Official distributions", "Retired"]);

    expect(await templates(testContext(home, launcher))).toEqual([
      { name: "Pharo 14.0 - 64bit", category: "Official distributions" },
    ]);

    launcher.listTemplates = async () => failed("The launcher timed out.");
    await expect(templates(testContext(home, launcher))).rejects.toMatchObject({
      code: "launcher-failed",
      message: "Pharo Launcher listTemplates failed: The launcher timed out.",
    });
  });

  it("says what the launcher said when it could not refresh", async () => {
    const home = tempHome();
    const launcher = new FakeLauncher(home);
    launcher.updateTemplates = async () => failed("Could not reach files.pharo.org");

    await expect(templates(testContext(home, launcher))).rejects.toMatchObject({
      code: "launcher-failed",
      message: "Pharo Launcher updateTemplates failed: Could not reach files.pharo.org",
    });
  });
});
