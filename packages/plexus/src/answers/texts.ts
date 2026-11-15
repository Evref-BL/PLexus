/**
 * The sentences the image tools answer with, and the library's refusals that
 * name a tool to use. A tool is named by its MCP name, `image_start`, which
 * both MCP servers serve; the `plexus` CLI says which of its commands that is.
 *
 * Each is a function of names, pids and problems, so that the library, both
 * servers and a test double say the same words.
 */

/** "a", "a and b", "a, b, and c". */
export function andList(items: readonly string[]): string {
  if (items.length <= 2) {
    return items.join(" and ");
  }
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

function pidsText(pids: readonly number[]): string {
  return `${pids.length === 1 ? "pid" : "pids"} ${pids.join(", ")}`;
}

function vmsText(pids: readonly number[]): string {
  return pids.length === 1 ? "that VM" : "those VMs";
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

const startsAsSaved = "image_start then starts it as it was last saved.";

// Refusals of the library.

export function noSuchImage(name: string): string {
  return `There is no image ${name}. image_list names the images there are; image_create makes one.`;
}

export function imageExists(name: string): string {
  return `Image ${name} already exists: choose another name, or delete it with image_delete first to create it again.`;
}

export function deleteRunning(name: string, pids: readonly number[]): string {
  return `Image ${name} is running as ${pidsText(pids)}. Stop it with image_stop before deleting it.`;
}

/** A start of an image whose MCP server answers. */
export function alreadyRunning(name: string): string {
  return `Image ${name} is already running; its tools answer now.`;
}

/** A start of an image a start of this PLexus launched, whose server does not answer yet. */
export function alreadyStarting(name: string, pids: readonly number[]): string {
  return `Image ${name} is already running as ${pidsText(pids)}, and is starting: its MCP server does not answer yet. Call its tools once image_list shows it running.`;
}

/** A start of an image a VM runs that takes no calls, for `problem`. */
export function alreadyRunningWithoutCalls(
  name: string,
  pids: readonly number[],
  problem: string,
): string {
  return `Image ${name} is already running as ${pidsText(pids)} but takes no calls: ${problem}. image_stop kills ${vmsText(pids)} without saving; ${startsAsSaved}`;
}

export function beingStarted(name: string, holder?: number): string {
  return `Image ${name} is being started${holder === undefined ? "" : ` by process ${holder}`}. Its tools take calls once image_list shows it running.`;
}

export function stillBuilding(name: string, holder?: number): string {
  return `Image ${name} is still being created${holder === undefined ? "" : ` by process ${holder}`}; image_list shows it as creating until it is done.`;
}

export function neverFinished(name: string): string {
  return `Image ${name} was never finished: the create that made it ended before it was done. Delete it with image_delete and create it again with image_create.`;
}

export function unknownTemplate(template: string): string {
  return `There is no template named ${template}. image_templates lists the templates there are.`;
}

// Whether a call can reach an image.

export function notRunning(name: string): string {
  return `Image ${name} is not running. Start it with image_start; it starts as it was last saved.`;
}

export function starting(name: string, pids: readonly number[]): string {
  return `Image ${name} is starting as ${pidsText(pids)}: its MCP server does not answer yet. Call it again once image_list shows it running.`;
}

/**
 * A VM runs the image, and no call reaches it, for `problem`. What a stop
 * would do is said, not ordered: such a VM may be one a person started.
 */
export function takesNoCalls(name: string, pids: readonly number[], problem: string): string {
  return `Image ${name} runs as ${pidsText(pids)} but takes no calls: ${problem}. image_stop kills ${vmsText(pids)} without saving; ${startsAsSaved}`;
}

export function severalAnswer(names: readonly string[]): string {
  return `Several images are running (${names.join(", ")}): name one with the image argument.`;
}

export function noneTakesCalls(names: readonly string[]): string {
  return `Images ${andList(names)} are running, but none takes calls: image_list says why.`;
}

export function noImageRunning(tool: string): string {
  return `No image is running to take ${tool}. Start one with image_start; it starts as it was last saved.`;
}

// What a forwarded call that failed did to the image.

export function olderMcpLacksTool(name: string, tool: string, version: string): string {
  return `Image ${name} answered that it has no tool ${tool}, but its Pharo MCP ${version} may hold the tool without listing it. Recreating the image gives it the current MCP.`;
}

export function noSuchTool(name: string, tool: string): string {
  return `Image ${name} answered that it has no tool ${tool}: tool_search finds the tools it has.`;
}

export function stoppedBeforeAnswering(name: string, tool: string): string {
  return `Image ${name} stopped before answering ${tool}. Start it with image_start; it starts as it was last saved.`;
}

export function noHandshake(name: string, tool: string, seconds: number): string {
  return `Image ${name} did not answer within ${seconds} s, so ${tool} was not sent. It still runs, and may be busy with an earlier call: image_stop kills it without saving, and ${startsAsSaved}`;
}

export function callTimedOut(name: string, tool: string, seconds: number): string {
  return `Image ${name} did not answer ${tool} within ${seconds} s, and still runs: it may still be working on the call. image_stop kills it without saving, and ${startsAsSaved}`;
}

export function connectionRefused(name: string, tool: string): string {
  return `Image ${name} runs, but refused the connection for ${tool}, so the call was not made.`;
}

export function connectionClosed(name: string, tool: string): string {
  return `Image ${name} closed the connection before answering ${tool}, and still runs: check whether the call took effect before making it again.`;
}

export function didNotAnswerRunning(name: string, tool: string, reason: string): string {
  return `Image ${name} did not answer ${tool}: ${reason}. It still runs.`;
}

export function didNotAnswer(name: string, tool: string, reason: string): string {
  return `Image ${name} did not answer ${tool}: ${reason}.`;
}

// The answers of the image tools.

export function templatesSummary(templates: number, categories: number): string {
  return `${plural(templates, "template")} in ${plural(categories, "category", "categories")}.`;
}

/** Said after the templates' summary for the names in several categories. */
export function ambiguousTemplates(names: readonly string[]): string {
  return names.length === 1
    ? `${names[0]} is in more than one, so image_create needs its category.`
    : `${andList(names)} are each in more than one, so image_create needs their category.`;
}

export function noTemplates(): string {
  return "No templates are listed.";
}

export function imagesSummary(images: number, running: number): string {
  return `${plural(images, "image")}, ${running === 0 ? "none" : running} running.`;
}

export function noImages(): string {
  return "No image yet: image_templates lists the templates image_create makes one from.";
}

export function imageRunning(name: string, interactive: boolean): string {
  return `Image ${name} is running${interactive ? ", with its window open" : ""}.`;
}

export function imageStarting(name: string): string {
  return `Image ${name} is starting: its MCP server does not answer yet.`;
}

export function imageCreating(name: string): string {
  return `Image ${name} is being created.`;
}

export function imageStopped(name: string): string {
  return `Image ${name} is not running.`;
}

export function olderMcp(name: string, version: string, current: string): string {
  return `Image ${name} holds Pharo MCP ${version}, and images are created with ${current} now, so its tools may differ from the current ones. Recreating it gives it the current MCP.`;
}

export function created(
  name: string,
  from: { template?: string; script?: string; everyStart?: boolean },
): string {
  const template = from.template === undefined ? "" : ` from ${from.template}`;
  const script =
    from.script === undefined
      ? ""
      : `, with ${from.script} filed in instead of the pinned MCP${from.everyStart ? ", and again at every start" : ""}`;
  return `Created image ${name}${template}${script}. It is not running yet; image_start starts it.`;
}

export function started(name: string, how: { interactive?: boolean; everyStart?: string }): string {
  const clauses = [
    ...(how.interactive ? ["its window open"] : []),
    ...(how.everyStart === undefined ? [] : [`${how.everyStart} filed in again`]),
  ];
  return `Started image ${name} as it was last saved${clauses.length === 0 ? "" : `, with ${clauses.join(" and ")}`}.`;
}

/** What `plexus mcp` adds to a start: a call naming no image goes to the only one that answers. */
export function passImage(name: string): string {
  return `Pass image: "${name}" to its tools while another image runs.`;
}

export function stopped(name: string): string {
  return `Stopped image ${name}; what it had not saved is lost.`;
}

export function wasNotRunning(name: string): string {
  return `Image ${name} was not running.`;
}

export function deleted(name: string): string {
  return `Deleted image ${name} and its files.`;
}

// Arguments checked against a tool's schema, in MCP's words.

export function invalidArguments(tool: string, violations: readonly string[]): string {
  return [`Invalid arguments for ${tool}.`, ...violations].join(" ");
}

export function argumentRequired(argument: string): string {
  return `${argument} is required.`;
}

export function argumentBlank(argument: string): string {
  return `${argument} is blank; leave it out or give it a value.`;
}

export function argumentNotOneOf(argument: string, accepted: readonly string[], actual: string): string {
  return `${argument} must be ${orList(accepted)}, not ${actual}.`;
}

export function argumentType(argument: string, types: readonly string[], actual: string): string {
  return `${argument} must be ${orList(types)}, not ${actual}.`;
}

export function argumentNotAccepted(argument: string, accepted: readonly string[]): string {
  return accepted.length === 0
    ? `${argument} is not accepted here.`
    : `${argument} is not accepted here; expected one of ${accepted.join(", ")}.`;
}

/** "a", "a or b", "a, b or c", as MCP lists the values a schema allows. */
function orList(items: readonly string[]): string {
  if (items.length <= 2) {
    return items.join(" or ");
  }
  return `${items.slice(0, -1).join(", ")} or ${items[items.length - 1]}`;
}
