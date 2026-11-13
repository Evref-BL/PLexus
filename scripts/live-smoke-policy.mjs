/**
 * What the live smoke may do, kept apart from doing it so that it is tested
 * without a Pharo image.
 *
 * The smoke creates, starts, lists the tools of, stops and deletes one image,
 * in a scope of its own: a scratch scope cannot name an image anyone works in.
 */

export const scratchScopePrefix = "plexus_smoke_";

const valueOptions = new Set([
  "template",
  "category",
  "home",
  "scope",
  "name",
  "timeout",
  "tool",
  "arguments",
  "expect",
]);
const flagOptions = new Set(["keep"]);

/** A run id that sorts by time and fits in a scope, which holds no dash. */
export function defaultRunId(now = new Date()) {
  return now.toISOString().replace(/[-:]/g, "").slice(0, 15);
}

/**
 * The smoke's options. The template may be the start of a name: the launcher
 * suffixes Pharo versions with a lifecycle, "(next stable)" today and
 * something else later.
 *
 * @param {readonly string[]} argv
 * @param {{ now?: Date }} [context]
 */
export function parseSmokeArgs(argv, context = {}) {
  /** @type {Record<string, string | true>} */
  const given = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      throw new Error(`Unexpected argument ${arg}`);
    }
    const [name, inline] = arg.slice(2).split(/=(.*)/s, 2);
    if (flagOptions.has(name)) {
      given[name] = true;
    } else if (valueOptions.has(name)) {
      const value = inline ?? argv[++index];
      if (value === undefined) {
        throw new Error(`--${name} needs a value`);
      }
      given[name] = value;
    } else {
      throw new Error(`Unknown option --${name}`);
    }
  }

  const scope = /** @type {string | undefined} */ (given.scope) ?? `${scratchScopePrefix}${defaultRunId(context.now)}`;
  if (!scope.startsWith(scratchScopePrefix)) {
    throw new Error(`A smoke runs in a scratch scope: --scope must start with ${scratchScopePrefix}`);
  }

  const timeout = given.timeout === undefined ? 600 : Number(given.timeout);
  if (!(Number.isFinite(timeout) && timeout > 0)) {
    throw new Error("--timeout is a number of seconds");
  }

  /** @type {Record<string, unknown>} */
  let toolArguments = {};
  if (given.arguments !== undefined) {
    toolArguments = JSON.parse(/** @type {string} */ (given.arguments));
    if (!toolArguments || typeof toolArguments !== "object" || Array.isArray(toolArguments)) {
      throw new Error("--arguments is a JSON object");
    }
  }
  if (given.expect !== undefined && given.tool === undefined) {
    throw new Error("--expect needs --tool");
  }

  return {
    template: /** @type {string} */ (given.template ?? "Pharo 14.0 - 64bit"),
    ...(given.category === undefined ? {} : { category: /** @type {string} */ (given.category) }),
    ...(given.home === undefined ? {} : { home: /** @type {string} */ (given.home) }),
    scope,
    name: /** @type {string} */ (given.name ?? "smoke"),
    timeoutMs: Math.round(timeout * 1000),
    ...(given.tool === undefined ? {} : { tool: /** @type {string} */ (given.tool) }),
    toolArguments,
    ...(given.expect === undefined ? {} : { expectedText: /** @type {string} */ (given.expect) }),
    keep: given.keep === true,
  };
}

/** The steps a run takes, in order. */
export function smokeSteps(options) {
  return ["create", "start", "listTools", ...(options.tool ? ["callTool"] : []), "stop", "delete"];
}

/**
 * The template a run creates from: the one named, or the one whose name is
 * that followed by a parenthesised suffix, in the category given if any.
 *
 * @param {{ template: string; category?: string }} options
 * @param {readonly { name: string; category: string }[]} templates
 */
export function resolveTemplate(options, templates) {
  const inCategory = templates.filter(
    (template) => options.category === undefined || template.category === options.category,
  );
  const exact = inCategory.filter((template) => template.name === options.template);
  const matches = exact.length > 0
    ? exact
    : inCategory.filter((template) => template.name.startsWith(`${options.template} (`));
  if (matches.length === 1) {
    return { name: matches[0].name, category: matches[0].category };
  }
  const named = matches.length === 0 ? inCategory : matches;
  throw new Error(
    `${matches.length === 0 ? "No" : "More than one"} template matches ${options.template}`
      + `${options.category === undefined ? "" : ` in ${options.category}`}: `
      + named.map((template) => `${template.name} (${template.category})`).join(", "),
  );
}

/** A started image must offer tools, and the one asked for. */
export function checkListedTools(tools, tool) {
  if (tools.length === 0) {
    throw new Error("The image listed no tools.");
  }
  if (tool !== undefined && !tools.some((each) => each.name === tool)) {
    throw new Error(`The image does not list ${tool}: ${tools.map((each) => each.name).join(", ")}`);
  }
}

/** A call must succeed, and say what was expected when something was. */
export function checkToolResult(result, expectedText) {
  const text = (result.content ?? [])
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("\n");
  if (result.isError) {
    throw new Error(`The tool answered an error: ${text}`);
  }
  if (expectedText !== undefined && !text.includes(expectedText)) {
    throw new Error(`The tool's answer does not contain ${expectedText}: ${text}`);
  }
}

/** One line per step that failed, with the code PLexus gave when it gave one. */
export function formatFailure(step, error) {
  const code = error && typeof error === "object" && "code" in error ? ` [${error.code}]` : "";
  const message = error instanceof Error ? error.message : String(error);
  return `smoke failed at ${step}${code}: ${message}`;
}
