import fs from "node:fs";
import path from "node:path";
import * as texts from "../answers/texts.js";
import { PlexusError } from "../errors.js";
import { launcherFailureMessage } from "../launcher/pharoLauncherMcpClient.js";
import { homeTemplateSources } from "../launcher/pharoLauncherProfile.js";
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
    const result = await launcher.listTemplates({ category });
    if (!result.ok) {
      // A group the sources list names but this launcher cannot open, unless
      // no group opens at all.
      failure ??= launcherFailureMessage("listTemplates", result);
      continue;
    }
    for (const template of result.data?.templates ?? []) {
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

/**
 * The template a create uses: the one given, found in the launcher's list
 * (see `chooseTemplate`), or the current stable Pharo when none is given. A
 * name given with its category is taken as it is, without listing, so that a
 * create from a base already built needs no network.
 */
export async function resolveTemplate(
  context: ImagesContext,
  given?: string,
  category?: string,
): Promise<Template> {
  if (given !== undefined && category !== undefined) {
    return { name: given, category };
  }
  return chooseTemplate(await templates(context), given, category);
}

/** What a mainline Pharo or Moose template's name says: its family, version and labels. */
interface Mainline {
  family: Family;
  major: number;
  minor: number;
  bits?: number;
  labels: string[];
}

type Family = "pharo" | "moose";

const families: readonly Family[] = ["pharo", "moose"];

// The Launcher's own names: "Pharo 14.0 - 64bit (stable)", "Pharo 5.0",
// "Moose Suite 13 (stable)", "Moose Suite 8.0". A suffix such as
// " - Pharo 14" makes a variant, which only its exact name finds.
const pharoName = /^pharo (\d+)\.(\d+)(?: - (32|64)bit)?(?: \(([^()]*)\))?$/i;
const mooseName = /^moose suite (\d+)(?:\.(\d+))?(?: \(([^()]*)\))?$/i;

// The categories the same name is taken from, first to last, when it is in several.
const preferredCategories = ["Official distributions", "Deprecated distributions"];

function mainline(name: string): Mainline | undefined {
  const pharo = pharoName.exec(name);
  if (pharo !== null) {
    return {
      family: "pharo",
      major: Number(pharo[1]),
      minor: Number(pharo[2]),
      ...(pharo[3] === undefined ? {} : { bits: Number(pharo[3]) }),
      labels: labelsOf(pharo[4]),
    };
  }
  const moose = mooseName.exec(name);
  if (moose !== null) {
    return { family: "moose", major: Number(moose[1]), minor: Number(moose[2] ?? 0), labels: labelsOf(moose[3]) };
  }
  return undefined;
}

/** "development version, latest" -> ["development version", "latest"]; "old-stable" -> ["old stable"]. */
function labelsOf(text: string | undefined): string[] {
  return text === undefined ? [] : text.split(",").map(normalized).filter((label) => label !== "");
}

function normalized(text: string): string {
  return text.trim().toLowerCase().replace(/[-_]/g, " ").replace(/\s+/g, " ");
}

/** What a loose request asks for: a version of a family, or a label of one. */
type Wanted =
  | { family?: Family; major: number; minor?: number; pharoDigits?: boolean }
  | { family?: Family; label: string };

const labelWords: Record<string, string> = {
  stable: "stable",
  "old stable": "old stable",
  oldstable: "old stable",
  "next stable": "next stable",
  development: "development",
  dev: "development",
  latest: "latest",
};

function wanted(given: string): Wanted | undefined {
  const whole = mainline(given.trim());
  if (whole !== undefined) {
    // A whole name whose label has moved: its version decides.
    return whole.bits === 32 ? undefined : { family: whole.family, major: whole.major, minor: whole.minor };
  }
  const request = /^(pharo|moose suite|moose)?\s*(.*)$/.exec(normalized(given));
  if (request === null) {
    return undefined;
  }
  const family = request[1] === undefined ? undefined : request[1] === "pharo" ? "pharo" : "moose";
  const rest = request[2];
  const label = labelWords[rest];
  if (label !== undefined) {
    return { ...(family === undefined ? {} : { family }), label };
  }
  const version = /^v?(\d+)(?:\.(\d+))?$/.exec(rest);
  if (version === null) {
    return undefined;
  }
  return {
    ...(family === undefined ? {} : { family }),
    major: Number(version[1]),
    ...(version[2] === undefined ? {} : { minor: Number(version[2]) }),
    ...(version[2] === undefined ? { pharoDigits: true } : {}),
  };
}

/**
 * The major a version written without a dot names: below 20, itself; from 20
 * on, a series as files.pharo.org writes it, `140` for 14 and `60` for 6, and
 * no version when it does not end in 0.
 */
function pharoMajor(digits: number): number | undefined {
  if (digits < 20) {
    return digits;
  }
  return digits % 10 === 0 ? digits / 10 : undefined;
}

/**
 * The template a create names, from the launcher's list:
 *
 * 1. a template of that exact name;
 * 2. else of that name in another case;
 * 3. else, for mainline Pharo and Moose only, one found loosely: a version
 *    (`14`, `14.0`, `140`, `Pharo 14`, `Moose 13`) names the newest template
 *    of its major, or of its minor when that is listed; a label (`stable`,
 *    `old stable`, `development`, `latest`) the template carrying it; and a
 *    whole mainline name whose label has moved, its version. A 32-bit
 *    template is found by its name only.
 *
 * With none given, the current stable Pharo. On a conflict Pharo comes
 * first, then Moose, then the others; the same name in several categories
 * takes the category given, else Official distributions, then Deprecated
 * distributions, and is refused as ambiguous when neither holds it.
 */
export function chooseTemplate(listed: readonly Template[], given?: string, category?: string): Template {
  const candidates = category === undefined ? listed : listed.filter((each) => each.category === category);
  if (given === undefined) {
    return stablePharo(candidates);
  }
  const exact = candidates.filter((each) => each.name === given);
  if (exact.length > 0) {
    return oneCategory(given, exact);
  }
  const anyCase = candidates.filter((each) => normalized(each.name) === normalized(given));
  if (anyCase.length > 0) {
    return oneCategory(anyCase[0].name, firstFamily(anyCase));
  }
  const loose = wanted(given);
  const found = loose === undefined ? undefined : looseMatch(candidates, loose);
  if (found === undefined) {
    throw new PlexusError("unknown-template", texts.unknownTemplate(given));
  }
  return found;
}

function stablePharo(listed: readonly Template[]): Template {
  const pharo = mainlines(listed).filter(({ line }) => line.family === "pharo");
  const stable = pharo.filter(({ line }) => line.labels.includes("stable"));
  const released = pharo.filter(
    ({ line }) => !line.labels.some((label) => /^(development|latest|next)\b/.test(label)),
  );
  const chosen = newest(stable.length > 0 ? stable : released);
  if (chosen === undefined) {
    throw new PlexusError("unknown-template", texts.noStableTemplate());
  }
  return chosen;
}

function looseMatch(listed: readonly Template[], loose: Wanted): Template | undefined {
  for (const family of loose.family === undefined ? families : [loose.family]) {
    const ofFamily = mainlines(listed).filter(({ line }) => line.family === family);
    let fits: Array<{ template: Template; line: Mainline }>;
    if ("label" in loose) {
      fits = ofFamily.filter(({ line }) =>
        line.labels.some((label) => label === loose.label || label.startsWith(`${loose.label} `)),
      );
    } else {
      const major = family === "pharo" && loose.pharoDigits === true ? pharoMajor(loose.major) : loose.major;
      const ofMajor = ofFamily.filter(({ line }) => line.major === major);
      const ofMinor =
        loose.minor === undefined ? [] : ofMajor.filter(({ line }) => line.minor === loose.minor);
      fits = ofMinor.length > 0 ? ofMinor : ofMajor;
    }
    const chosen = newest(fits);
    if (chosen !== undefined) {
      return chosen;
    }
  }
  return undefined;
}

/** The mainline templates of a list, 32-bit ones left out. */
function mainlines(listed: readonly Template[]): Array<{ template: Template; line: Mainline }> {
  return listed.flatMap((template) => {
    const line = mainline(template.name);
    return line === undefined || line.bits === 32 ? [] : [{ template, line }];
  });
}

/** The newest version among these; of one name in several categories, the preferred category's. */
function newest(fits: ReadonlyArray<{ template: Template; line: Mainline }>): Template | undefined {
  const sorted = [...fits].sort(
    (a, b) => b.line.major - a.line.major || b.line.minor - a.line.minor,
  );
  if (sorted.length === 0) {
    return undefined;
  }
  const name = sorted[0].template.name;
  return byPreference(sorted.filter(({ template }) => template.name === name).map(({ template }) => template));
}

/** The family that comes first among templates of one name in another case: Pharo, Moose, then the others. */
function firstFamily(found: readonly Template[]): Template[] {
  const rank = (template: Template) => {
    const family = mainline(template.name)?.family;
    return family === undefined ? families.length : families.indexOf(family);
  };
  const best = Math.min(...found.map(rank));
  const first = found.filter((template) => rank(template) === best);
  return first.filter((template) => template.name === first[0].name);
}

function oneCategory(name: string, found: readonly Template[]): Template {
  if (found.length === 1) {
    return { name: found[0].name, category: found[0].category };
  }
  const preferred = byPreference(found, false);
  if (preferred !== undefined) {
    return preferred;
  }
  const names = found.map((each) => each.category);
  throw new PlexusError(
    "ambiguous-template",
    `Template ${name} is in several categories: ${names.join(", ")}. Say which with a category.`,
    { categories: names },
  );
}

function byPreference(found: readonly Template[], orFirst = true): Template | undefined {
  for (const category of preferredCategories) {
    const inIt = found.find((each) => each.category === category);
    if (inIt !== undefined) {
      return { name: inIt.name, category: inIt.category };
    }
  }
  return orFirst && found.length > 0 ? { name: found[0].name, category: found[0].category } : undefined;
}

/**
 * Fetches the launcher's sources list when the profile has none, which only
 * a template update does: until then the launcher knows no category, and a
 * create naming one fails. What failed, when it did.
 */
export async function ensureTemplateSources(context: ImagesContext): Promise<string | undefined> {
  if (nonEmpty(sourcesListPath(context.home))) {
    return undefined;
  }
  const update = await context.launcher().updateTemplates();
  return update.ok ? undefined : launcherFailureMessage("updateTemplates", update);
}

function sourcesListPath(home: string): string {
  return homeTemplateSources(home);
}

function nonEmpty(file: string): boolean {
  try {
    return fs.statSync(file).size > 0;
  } catch {
    return false;
  }
}

// The launcher's category listing names every group, the HTTP listings among
// them, which list every build of a Pharo version as a template, hundreds
// each. So the groups come from the sources list it reads, its URL groups and
// its cache, and from the launcher only when that names none.
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
  return [...new Set(result.data?.categories ?? [])];
}

function sourcesListGroups(home: string): string[] {
  let sources: string;
  try {
    sources = fs.readFileSync(sourcesListPath(home), "utf8");
  } catch {
    return [];
  }
  return [
    ...new Set(
      [...sources.matchAll(sourcesGroupName)].map((match) => match[1].replaceAll("''", "'")),
    ),
  ];
}
