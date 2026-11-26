import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { chooseTemplate, resolveTemplate, templates } from "../../src/images/templates.js";
import type { Template } from "../../src/types.js";
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

  it("takes a name given with its category as it is, without listing", async () => {
    const home = tempHome();
    const launcher = new FakeLauncher(home);

    expect(await resolveTemplate(testContext(home, launcher), "Pharo 9.0", "Elsewhere")).toEqual({
      name: "Pharo 9.0",
      category: "Elsewhere",
    });
    expect(launcher.called("updateTemplates")).toEqual([]);
    expect(launcher.called("listTemplates")).toEqual([]);
  });

  it("names the category of a template in one, and refuses one in several outside the official ones", async () => {
    const home = tempHome();
    const launcher = new FakeLauncher(home);
    writeSourcesList(home, ["Official distributions", "Moose's", "Retired"]);
    launcher.templatesByCategory = {
      "Official distributions": ["Pharo 14.0 - 64bit", "Pharo 13.0 - 64bit"],
      "Moose's": ["Pharo 13.0 - 64bit", "Pharo 9.0"],
      Retired: ["Pharo 9.0"],
    };
    const context = testContext(home, launcher);

    expect(await resolveTemplate(context, "Pharo 14.0 - 64bit")).toEqual({
      name: "Pharo 14.0 - 64bit",
      category: "Official distributions",
    });
    expect(await resolveTemplate(context, "Pharo 13.0 - 64bit")).toEqual({
      name: "Pharo 13.0 - 64bit",
      category: "Official distributions",
    });
    expect(await resolveTemplate(context, "Pharo 13.0 - 64bit", "Moose's")).toEqual({
      name: "Pharo 13.0 - 64bit",
      category: "Moose's",
    });
    await expect(resolveTemplate(context, "Pharo 99")).rejects.toMatchObject({
      code: "unknown-template",
      message: "There is no template named Pharo 99. image_templates lists the templates there are.",
    });
    await expect(resolveTemplate(context, "Pharo 9.0")).rejects.toMatchObject({
      code: "ambiguous-template",
      message: "Template Pharo 9.0 is in several categories: Moose's, Retired. Say which with a category.",
      details: { categories: ["Moose's", "Retired"] },
    });
  });
});

// The Launcher's list on 2026-11-26, the groups PLexus reads.
const launcherList: Template[] = [
  ["Pharo Courses", ["Pharo Mooc", "Pharo 10.0 - 64bit", "Smic (Compiler Course)"]],
  [
    "Official distributions",
    [
      "Pharo 15.0 - 64bit (development version, latest)",
      "Pharo 14.0 - 64bit (stable)",
      "Pharo 13.1 - 64bit (old stable)",
      "Moose Suite 14 (development)",
      "Moose Suite 13 (stable)",
      "Moose Suite 13 (stable) - Pharo 14",
      "Moose Suite 12 (old-stable)",
    ],
  ],
  ["Spec-Toplo", ["Spec-Toplo Pharo 14 (development)", "Spec-Toplo Pharo 15 (development)"]],
  ["Pharo-Music distributions", ["Pharo-Music (beta)"]],
  ["Pharo-LLM distributions", ["Pharo-LLM 14 (development)"]],
  [
    "Deprecated distributions",
    [
      "Pharo 12.0 - 64bit",
      "Pharo 11.0 - 64bit",
      "Pharo 10.0 - 64bit",
      "Pharo 10.0 - 32bit",
      "Pharo 9.0 - 64bit",
      "Pharo 9.0 - 32bit",
      "Pharo 8.0 - 64bit",
      "Pharo 8.0 - 32bit",
      "Pharo 7.0 - 32bit",
      "Pharo 7.0 - 64bit",
      "Pharo 6.1 - 32bit",
      "Pharo 6.1 - 64bit",
      "Pharo 5.0",
      "Pharo 4.0",
      "Pharo 3.0",
      "Pharo 2.0",
      "Moose Suite 8.0",
      "Moose Suite 9.0",
      "Moose Suite 10",
      "Moose Suite 11 (old stable)",
    ],
  ],
].flatMap(([category, names]) => (names as string[]).map((name) => ({ name, category: category as string })));

function chosen(given?: string, category?: string): string {
  const template = chooseTemplate(launcherList, given, category);
  return `${template.name} | ${template.category}`;
}

const official = "Official distributions";
const deprecated = "Deprecated distributions";

describe("chooseTemplate", () => {
  it("takes the current stable Pharo when none is given", () => {
    expect(chosen()).toBe(`Pharo 14.0 - 64bit (stable) | ${official}`);
  });

  it("finds a mainline Pharo by its version or its label", () => {
    for (const given of ["14", "14.0", "140", "Pharo 14", "pharo 14.0", "pharo14", "Pharo-14", "v14", "stable", "Pharo stable"]) {
      expect(chosen(given), given).toBe(`Pharo 14.0 - 64bit (stable) | ${official}`);
    }
    for (const given of ["13", "13.1", "130", "13.0", "old stable", "old-stable", "Pharo oldstable"]) {
      expect(chosen(given), given).toBe(`Pharo 13.1 - 64bit (old stable) | ${official}`);
    }
    for (const given of ["15", "150", "latest", "development", "dev", "Pharo dev"]) {
      expect(chosen(given), given).toBe(`Pharo 15.0 - 64bit (development version, latest) | ${official}`);
    }
    expect(chosen("12")).toBe(`Pharo 12.0 - 64bit | ${deprecated}`);
    expect(chosen("90")).toBe(`Pharo 9.0 - 64bit | ${deprecated}`);
    expect(chosen("60")).toBe(`Pharo 6.1 - 64bit | ${deprecated}`);
    expect(chosen("5")).toBe(`Pharo 5.0 | ${deprecated}`);
    expect(chosen("20")).toBe(`Pharo 2.0 | ${deprecated}`);
  });

  it("finds a whole mainline name by its version when its label has moved", () => {
    expect(chosen("Pharo 14.0 - 64bit (next stable)")).toBe(`Pharo 14.0 - 64bit (stable) | ${official}`);
    expect(chosen("Pharo 13.0 - 64bit (stable)")).toBe(`Pharo 13.1 - 64bit (old stable) | ${official}`);
    expect(chosen("Pharo 14.0 - 64bit (development version, latest)")).toBe(`Pharo 14.0 - 64bit (stable) | ${official}`);
    expect(chosen("Moose Suite 13 (old stable)")).toBe(`Moose Suite 13 (stable) | ${official}`);
  });

  it("finds a mainline Moose when Moose is named, and only its plain suite", () => {
    for (const given of ["Moose 13", "moose suite 13", "Moose13", "Moose stable"]) {
      expect(chosen(given), given).toBe(`Moose Suite 13 (stable) | ${official}`);
    }
    expect(chosen("Moose 14")).toBe(`Moose Suite 14 (development)`.concat(` | ${official}`));
    expect(chosen("Moose development")).toBe(`Moose Suite 14 (development) | ${official}`);
    expect(chosen("Moose 12")).toBe(`Moose Suite 12 (old-stable) | ${official}`);
    expect(chosen("Moose 8")).toBe(`Moose Suite 8.0 | ${deprecated}`);
    expect(chosen("Moose Suite 13 (stable) - Pharo 14")).toBe(`Moose Suite 13 (stable) - Pharo 14 | ${official}`);
  });

  it("takes Pharo first, then Moose, then the others", () => {
    expect(chosen("12")).toBe(`Pharo 12.0 - 64bit | ${deprecated}`);
    expect(chosen("stable")).toBe(`Pharo 14.0 - 64bit (stable) | ${official}`);
    expect(chosen("8")).toBe(`Pharo 8.0 - 64bit | ${deprecated}`);
    // Without a Pharo of that major, a bare version is Moose's.
    const mooseOnly: Template[] = [
      { name: "Pharo 9.0 - 32bit", category: deprecated },
      { name: "Moose Suite 9.0", category: deprecated },
    ];
    expect(chooseTemplate(mooseOnly, "9")).toEqual({ name: "Moose Suite 9.0", category: deprecated });
  });

  it("takes a name in several categories from the official ones", () => {
    expect(chosen("Pharo 10.0 - 64bit")).toBe(`Pharo 10.0 - 64bit | ${deprecated}`);
    expect(chosen("10")).toBe(`Pharo 10.0 - 64bit | ${deprecated}`);
    expect(chosen("10", "Pharo Courses")).toBe("Pharo 10.0 - 64bit | Pharo Courses");
  });

  it("finds any other template by its exact name, in any case, and nothing looser", () => {
    expect(chosen("Pharo-Music (beta)")).toBe("Pharo-Music (beta) | Pharo-Music distributions");
    expect(chosen("pharo-music (BETA)")).toBe("Pharo-Music (beta) | Pharo-Music distributions");
    expect(chosen("Pharo 10.0 - 32bit")).toBe(`Pharo 10.0 - 32bit | ${deprecated}`);
    for (const given of ["Pharo-LLM 14", "Spec-Toplo 14", "Pharo 10 32bit", "Pharo 9.0 - 32bit (stable)", "16", "99", "61", "131", "Moose 99", "Pharo Mooc 2"]) {
      expect(() => chooseTemplate(launcherList, given), given).toThrow(
        expect.objectContaining({ code: "unknown-template" }),
      );
    }
  });

  it("looks only in the category given", () => {
    expect(() => chooseTemplate(launcherList, "14", "Spec-Toplo")).toThrow(
      expect.objectContaining({ code: "unknown-template" }),
    );
    expect(chosen(undefined, deprecated)).toBe(`Pharo 12.0 - 64bit | ${deprecated}`);
  });

  it("takes the newest released Pharo when none is labelled stable, and refuses without one", () => {
    const unlabelled: Template[] = [
      { name: "Pharo 15.0 - 64bit (development version, latest)", category: official },
      { name: "Pharo 14.0 - 64bit (next stable)", category: official },
      { name: "Pharo 12.0 - 64bit", category: deprecated },
    ];
    expect(chooseTemplate(unlabelled)).toEqual({ name: "Pharo 12.0 - 64bit", category: deprecated });
    expect(() => chooseTemplate([{ name: "Pharo-Music (beta)", category: "Music" }])).toThrow(
      expect.objectContaining({
        code: "unknown-template",
        message:
          "The template list has no stable Pharo to create from: name a template. image_templates lists the templates there are.",
      }),
    );
  });
});
