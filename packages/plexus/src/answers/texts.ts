/**
 * The sentences the image tools answer with, and the library's refusals that
 * name a tool to use. A tool is named by its MCP name, `image_start`, which
 * `plexus mcp` serves; the `plexus` CLI says which of its commands that is.
 *
 * Each is a function of names, pids and problems, so that the library, the
 * server and a test double say the same words.
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

/** A start of an image whose MCP server already answers. */
export function alreadyRunning(name: string, interactive: boolean): string {
  return `Image ${name} was already running${interactive ? ", with its window open" : ""}.`;
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

/** Several images that take no calls for the same `problem`, said once. */
export function takeNoCalls(images: ReadonlyArray<{ name: string; pids: readonly number[] }>, problem: string): string {
  const named = andList(images.map((each) => `${each.name} (${pidsText(each.pids)})`));
  return `Images ${named} run but take no calls: ${problem}. image_stop kills an image's VMs without saving; image_start then starts it as it was last saved.`;
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

/**
 * `meant`, a tool the image lists, is the one an agent asking for `tool` most
 * likely wants. `tool_search` is MCP's: its catalog tool, which MCP documents
 * as finding every tool a server registers, listed or not.
 */
export function noSuchTool(name: string, tool: string, meant?: string): string {
  return meant === undefined
    ? `Image ${name} answered that it has no tool ${tool}: tool_search finds the tools it has.`
    : `Image ${name} answered that it has no tool ${tool}, but it lists ${meant}: call that instead.`;
}

/** No image of those running, which a call naming none could go to, lists the tool; `meant` is the one listed tool an agent asking for it most likely wants. */
export function noImageHasTool(names: readonly string[], tool: string, meant?: { tool: string; image: string }): string {
  return meant === undefined
    ? `No running image (${names.join(", ")}) has a tool ${tool}: tool_search finds the tools an image has.`
    : `No running image (${names.join(", ")}) has a tool ${tool}, but ${meant.image} lists ${meant.tool}: call that instead.`;
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

/** Images that hold an older MCP release than the one images are created with. */
export function olderMcp(names: readonly string[], version: string, current: string): string {
  return names.length === 1
    ? `Image ${names[0]} holds Pharo MCP ${version}, and images are created with ${current} now, so its tools may differ from the current ones. Recreating it gives it the current MCP.`
    : `Images ${andList(names)} hold Pharo MCP ${version}, and images are created with ${current} now, so their tools may differ from the current ones. Recreating them gives them the current MCP.`;
}

/**
 * Why an image does not record its calls through OpenTelemetry, said when
 * PLexus enrolls images, and what makes it record. `pinned` is an image
 * holding the pinned MCP, which recreating it renews.
 */
export function recordsNothing(
  name: string,
  why: { reason?: string; detail?: string },
  pinned: boolean,
): string {
  const recreate = "Recreating it gives it MCP's Telemetry group.";
  const reasons: Record<string, string> = {
    "not-asked": "it was made without MCP's Telemetry group, by a PLexus that did not enroll images in OpenTelemetry. Recreating it adds the group.",
    "base-failed": `the base with MCP's Telemetry group failed to build${why.detail ? ` (${why.detail})` : ""}, so it was copied from the base without it. A create tries that base again a day after it failed.`,
    "no-backend": `its MCP has no OpenTelemetry backend. ${pinned ? recreate : "Its script must load MCP's Telemetry group."}`,
    "switch-failed": `its MCP server failed to switch to OpenTelemetry${why.detail ? `: ${why.detail.replace(/\.$/, "")}` : ""}.`,
  };
  return `Image ${name} does not record its calls: ${(why.reason === undefined ? undefined : reasons[why.reason]) ?? "its start did not say why."}`;
}

/** The telemetry of an image that records its calls, when the OTEL_* settings send them to no OTLP endpoint. */
export function recordedNotSent(): string {
  return "recorded, but the OTEL_* settings send it nowhere";
}

export function recordedNowhereToSend(): string {
  return "The images that record their calls through OpenTelemetry have OTEL_* settings that send them nowhere.";
}

/** A create, which the caller named the template of. */
export function created(name: string, from: { script?: string; everyStart?: boolean }): string {
  const script =
    from.script === undefined
      ? ""
      : `, with ${from.script} filed in instead of the pinned MCP${from.everyStart ? ", and again at every start" : ""}`;
  return `Created image ${name}${script}; image_start starts it.`;
}

export function started(name: string, how: { interactive?: boolean; everyStart?: string }): string {
  const clauses = [
    ...(how.interactive ? ["its window open"] : []),
    ...(how.everyStart === undefined ? [] : [`${how.everyStart} filed in again`]),
  ];
  return `Started image ${name}${clauses.length === 0 ? "" : `, with ${clauses.join(" and ")}`}.`;
}

/** What `plexus mcp` adds to a start while another image runs: a call naming no image goes to the only one that answers. */
export function passImage(name: string): string {
  return `Pass image: "${name}" to its tools while another image runs.`;
}

export function stopped(name: string): string {
  return `Stopped image ${name}; what it had not saved is lost.`;
}

export function savedAndStopped(name: string): string {
  return `Saved and stopped image ${name}.`;
}

// A stop asked to save, when the image did not save and quit. Each says
// whether it still runs, and what to do next.

const killsInstead = `image_stop without save kills it, and ${startsAsSaved}`;

export function saveTakesNoCalls(name: string, pids: readonly number[], problem: string): string {
  return `Image ${name} runs as ${pidsText(pids)} but takes no calls: ${problem}, so it cannot save itself. image_stop without save kills ${vmsText(pids)}; ${startsAsSaved}`;
}

/**
 * The image did not take the save, and still runs: it could not be asked,
 * refused or failed the call, or answered it with an error. `reason` says
 * which.
 */
export function notSaved(name: string, reason: string): string {
  return `Image ${name} did not save: ${reason}. It still runs: ${killsInstead}`;
}

/**
 * The image still runs after the wait. One that has written to its image
 * file may still be writing it, which a kill would break.
 */
export function saveTimedOut(name: string, seconds: number, written: boolean): string {
  return written
    ? `Image ${name} began writing its image file but did not stop within ${seconds} s, and still runs: it may still be writing it, and a kill before it is done can leave the file broken. image_list shows when it has stopped.`
    : `Image ${name} did not save or stop within ${seconds} s, and still runs: ${killsInstead}`;
}

/** The image's VM has gone, and its image file was not written. */
export function stoppedUnsaved(name: string): string {
  return `Image ${name} stopped without writing its image file, so what it had not saved is lost. image_start starts it as it was last saved.`;
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

export function argumentItem(argument: string, type: string, actual: string): string {
  return `${argument} must list non-blank ${type}s, not ${actual}.`;
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
