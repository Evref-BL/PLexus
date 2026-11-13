/**
 * How PLexus reaches the launcher.
 *
 * It used to spawn `pharo-launcher-mcp` and send tool names over stdio. The
 * package answers those names as functions now, so the call is a call: no
 * process, no handshake, and no object stringified into a text block for the
 * other side to parse back. Asking the host what it is running went from
 * 175ms to the 46ms the question itself costs.
 *
 * The names stay because PLexus uses them: an operation that needs approval is
 * described before it is performed, and what it names is a tool.
 */
import {
  openPharoLauncher,
  type PharoLauncher,
} from "@evref-bl/pharo-launcher-mcp/launcher";
import { vmRenewalHint } from "./vmRenewal.js";

export interface PharoLauncherMcpToolClient {
  callTool<K extends LauncherToolName>(
    name: K,
    argumentsValue?: LauncherToolInput<K>,
  ): Promise<LauncherToolResult<K>>;
  close?(): Promise<void>;
}

export class PharoLauncherMcpToolError extends Error {
  constructor(
    message: string,
    public readonly toolName: string,
    public readonly result: unknown,
  ) {
    super(message);
    this.name = "PharoLauncherMcpToolError";
  }
}

export interface OpenPharoLauncherClientOptions {
  /** The profile this caller works in, as the launcher's own variables. */
  profileEnvironment?: Record<string, string> | undefined;
}

const launcherFailureDetailLength = 500;

function failureDetailField(payload: unknown, key: string): string | undefined {
  if (!payload || typeof payload !== "object") {
    return undefined;
  }

  const value = (payload as Record<string, unknown>)[key];
  if (typeof value !== "string") {
    return undefined;
  }

  const detail = value.trim();
  if (!detail) {
    return undefined;
  }

  return detail.length > launcherFailureDetailLength
    ? `${detail.slice(0, launcherFailureDetailLength)}…`
    : detail;
}

// The launcher says what went wrong and what to do about it. A message naming
// only the tool throws that away, and the caller above us has nothing left to
// report. Carry the explanation, trimmed: a diagnostic built from launcher
// output can run to pages.
export function launcherToolFailureMessage(
  toolName: string,
  payload: unknown,
): string {
  const detail =
    failureDetailField(payload, "message") ??
    [
      failureDetailField(payload, "diagnostic"),
      failureDetailField(payload, "action"),
    ]
      .filter(Boolean)
      .join(" ");
  const message = detail
    ? `pharo-launcher-mcp tool failed: ${toolName}: ${detail}`
    : `pharo-launcher-mcp tool failed: ${toolName}`;
  const renewal = launchVmRenewalHint(toolName, payload);
  return renewal ? `${message}\n${renewal}` : message;
}

// A launch that waited for its VM has the VM's output in the launcher's raw
// result, after the launcher's own report of which VM it ran.
function launchVmRenewalHint(toolName: string, payload: unknown): string | undefined {
  if (toolName !== "pharo_launcher_image_start" || !payload || typeof payload !== "object") {
    return undefined;
  }
  const raw = (payload as Record<string, unknown>).raw;
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const { stdout, stderr } = raw as Record<string, unknown>;
  const report = typeof stdout === "string" ? stdout : "";
  const output = `${report}\n${typeof stderr === "string" ? stderr : ""}`;
  return vmRenewalHint(output, report);
}

/**
 * The tool names PLexus speaks, and what each one is.
 *
 * The launcher's own test keeps its thirteen tools and thirteen functions
 * level with each other. This table is the third list, and it is here rather
 * than there because the names are PLexus's vocabulary: they appear in the
 * plans it shows for approval and in what it reports when one fails.
 */
export const launcherMethodForTool = {
  pharo_launcher_config: "describeConfig",
  pharo_launcher_image_copy: "copyImage",
  pharo_launcher_image_copy_between_profiles: "copyImageBetweenProfiles",
  pharo_launcher_image_create: "createImage",
  pharo_launcher_image_delete: "deleteImage",
  pharo_launcher_image_info: "imageInfo",
  pharo_launcher_image_list: "listImages",
  pharo_launcher_image_start: "startImage",
  pharo_launcher_process_kill: "killProcess",
  pharo_launcher_process_list: "listProcesses",
  pharo_launcher_template_category_list: "listTemplateCategories",
  pharo_launcher_template_list: "listTemplates",
  pharo_launcher_template_update: "updateTemplates",
} as const satisfies Record<string, keyof PharoLauncher>;

export type LauncherToolName = keyof typeof launcherMethodForTool;

type LauncherMethodFor<K extends LauncherToolName> =
  PharoLauncher[(typeof launcherMethodForTool)[K]];

/** What that tool takes, read off the function it calls. */
export type LauncherToolInput<K extends LauncherToolName> = Parameters<
  LauncherMethodFor<K>
>[0];

/** What that tool answers, read off the function it calls. */
export type LauncherToolResult<K extends LauncherToolName> = Awaited<
  ReturnType<LauncherMethodFor<K>>
>;

/**
 * The tools an operation plan may name: the ones that change something, and
 * are therefore written down and approved before they run. Every one of them
 * answers with an `ok`, which is what the caller checks afterwards.
 */
export type LauncherMutationToolName =
  | "pharo_launcher_image_copy"
  | "pharo_launcher_image_copy_between_profiles"
  | "pharo_launcher_image_create"
  | "pharo_launcher_image_delete"
  | "pharo_launcher_image_start"
  | "pharo_launcher_template_update";

export const launcherToolNames = Object.keys(
  launcherMethodForTool,
) as LauncherToolName[];

function failed(result: unknown): boolean {
  return (
    Boolean(result) &&
    typeof result === "object" &&
    (result as { ok?: unknown }).ok === false
  );
}

export function openPharoLauncherClient(
  options: OpenPharoLauncherClientOptions = {},
): PharoLauncherMcpToolClient {
  const launcher = openPharoLauncher(
    options.profileEnvironment === undefined
      ? {}
      : { env: options.profileEnvironment },
  );

  return {
    async callTool<K extends LauncherToolName>(
      name: K,
      argumentsValue?: LauncherToolInput<K>,
    ): Promise<LauncherToolResult<K>> {
      const method = launcherMethodForTool[name];
      if (!method) {
        throw new PharoLauncherMcpToolError(
          `pharo-launcher-mcp has no tool named ${name}`,
          name,
          undefined,
        );
      }

      // The one cast left: every method takes its own input, and the table
      // above is what ties a name to the right one.
      const call = launcher[method] as (input: unknown) => unknown;
      const result = (await call.call(launcher, argumentsValue ?? {})) as
        LauncherToolResult<K>;
      if (failed(result)) {
        throw new PharoLauncherMcpToolError(
          launcherToolFailureMessage(name, result),
          name,
          result,
        );
      }

      return result;
    },
  };
}
