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

export interface PharoLauncherMcpToolClient {
  callTool<T = unknown>(
    name: string,
    argumentsValue?: Record<string, unknown>,
  ): Promise<T>;
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

  return detail
    ? `pharo-launcher-mcp tool failed: ${toolName}: ${detail}`
    : `pharo-launcher-mcp tool failed: ${toolName}`;
}

/**
 * The tool names PLexus speaks, and what each one is.
 *
 * The launcher's own test keeps its thirteen tools and thirteen functions
 * level with each other. This table is the third list, and it is here rather
 * than there because the names are PLexus's vocabulary: they appear in the
 * plans it shows for approval and in what it reports when one fails.
 */
export const launcherToolNames: readonly string[] = [
  "pharo_launcher_config",
  "pharo_launcher_image_copy",
  "pharo_launcher_image_copy_between_profiles",
  "pharo_launcher_image_create",
  "pharo_launcher_image_delete",
  "pharo_launcher_image_info",
  "pharo_launcher_image_list",
  "pharo_launcher_image_start",
  "pharo_launcher_process_kill",
  "pharo_launcher_process_list",
  "pharo_launcher_template_category_list",
  "pharo_launcher_template_list",
  "pharo_launcher_template_update",
];

const callForTool: Record<
  string,
  (launcher: PharoLauncher, input: Record<string, unknown>) => unknown
> = {
  pharo_launcher_config: (launcher) => launcher.describeConfig(),
  pharo_launcher_image_copy: (launcher, input) =>
    launcher.copyImage(input as never),
  pharo_launcher_image_copy_between_profiles: (launcher, input) =>
    launcher.copyImageBetweenProfiles(input),
  pharo_launcher_image_create: (launcher, input) =>
    launcher.createImage(input as never),
  pharo_launcher_image_delete: (launcher, input) =>
    launcher.deleteImage(input as never),
  pharo_launcher_image_info: (launcher, input) =>
    launcher.imageInfo(input as never),
  pharo_launcher_image_list: (launcher, input) => launcher.listImages(input),
  pharo_launcher_image_start: (launcher, input) =>
    launcher.startImage(input as never),
  pharo_launcher_process_kill: (launcher, input) =>
    launcher.killProcess(input as never),
  pharo_launcher_process_list: (launcher, input) =>
    launcher.listProcesses(input),
  pharo_launcher_template_category_list: (launcher, input) =>
    launcher.listTemplateCategories(input),
  pharo_launcher_template_list: (launcher, input) =>
    launcher.listTemplates(input),
  pharo_launcher_template_update: (launcher, input) =>
    launcher.updateTemplates(input),
};

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
    async callTool<T = unknown>(
      name: string,
      argumentsValue: Record<string, unknown> = {},
    ): Promise<T> {
      const call = callForTool[name];
      if (!call) {
        throw new PharoLauncherMcpToolError(
          `pharo-launcher-mcp has no tool named ${name}`,
          name,
          undefined,
        );
      }

      const result = await call(launcher, argumentsValue);
      if (failed(result)) {
        throw new PharoLauncherMcpToolError(
          launcherToolFailureMessage(name, result),
          name,
          result,
        );
      }

      return result as T;
    },
  };
}
