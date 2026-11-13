import fs from "node:fs";
import path from "node:path";
import { PlexusError } from "../errors.js";
import { launcherFailureMessage } from "../launcher/pharoLauncherMcpClient.js";
import { homeProfileEnvironment } from "../launcher/pharoLauncherProfile.js";
import type { Template } from "../types.js";
import type { ImagesContext } from "./context.js";

// A group of the sources list is one template category.
const sourcesGroupName =
  /#type\s*:\s*#(?:URLGroup|Cache)\s*,\s*#name\s*:\s*'((?:[^']|'')*)'/g;

/**
 * The launcher's templates with their category, refreshed from the Pharo
 * Launcher's own list first.
 *
 * A template listed without a category comes from the launcher's default
 * group only, so every category is walked. A name in two categories is marked
 * ambiguous: a create from it has to say which.
 */
export async function templates(context: ImagesContext): Promise<Template[]> {
  const launcher = context.launcher();
  const update = await launcher.updateTemplates();
  if (!update.ok) {
    throw new PlexusError("launcher-failed", launcherFailureMessage("updateTemplates", update));
  }

  const listed: Template[] = [];
  let failure: string | undefined;
  for (const category of await categories(context)) {
    const result = await launcher.listTemplates({ templateCategory: category });
    if (!result.ok) {
      // A group the sources list names but this launcher cannot open, unless
      // no group opens at all.
      failure ??= launcherFailureMessage("listTemplates", result);
      continue;
    }
    for (const template of result.data ?? []) {
      if (
        template.name &&
        !listed.some((seen) => seen.name === template.name && seen.category === category)
      ) {
        listed.push({ name: template.name, category });
      }
    }
  }

  if (listed.length === 0 && failure !== undefined) {
    throw new PlexusError("launcher-failed", failure);
  }

  return listed.map((template) =>
    listed.some((other) => other.name === template.name && other.category !== template.category)
      ? { ...template, ambiguous: true }
      : template,
  );
}

/** The category a create from this template uses, when it named none. */
export async function categoryOf(context: ImagesContext, template: string): Promise<string> {
  const found = (await templates(context)).filter((each) => each.name === template);
  if (found.length === 0) {
    throw new PlexusError(
      "unknown-template",
      `There is no template named ${template}: the template list says which there are.`,
    );
  }
  if (found.length > 1) {
    const names = found.map((each) => each.category);
    throw new PlexusError(
      "ambiguous-template",
      `Template ${template} is in several categories: ${names.join(", ")}. Say which with a category.`,
      { categories: names },
    );
  }
  return found[0].category;
}

// The launcher's category listing walks the whole template tree and answers
// template names and URLs beside the groups, so the groups come from the
// sources list it reads, and from the launcher only when that names none.
async function categories(context: ImagesContext): Promise<string[]> {
  const fromSources = sourcesListGroups(context.home);
  if (fromSources.length > 0) {
    return fromSources;
  }
  const result = await context.launcher().listTemplateCategories();
  if (!result.ok) {
    throw new PlexusError(
      "launcher-failed",
      launcherFailureMessage("listTemplateCategories", result),
    );
  }
  return [...new Set(result.data ?? [])];
}

function sourcesListGroups(home: string): string[] {
  let sources: string;
  try {
    sources = fs.readFileSync(
      path.join(homeProfileEnvironment(home).PHARO_LAUNCHER_MCP_TEMPLATE_SOURCES_DIR, "sources.list"),
      "utf8",
    );
  } catch {
    return [];
  }
  return [
    ...new Set(
      [...sources.matchAll(sourcesGroupName)].map((match) => match[1].replaceAll("''", "'")),
    ),
  ];
}
