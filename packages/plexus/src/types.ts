export type Display = "headless" | "interactive";

/** An MCP server an image runs: `http://127.0.0.1:<port><path>`. */
export interface Endpoint {
  url: string;
  /** The VM that wrote it, when the image could tell. */
  pid?: number;
}

export interface Template {
  name: string;
  category: string;
  /**
   * The name is in more than one category: a create takes the one in
   * `Official distributions`, else in `Deprecated distributions`, and
   * otherwise needs the category.
   */
  ambiguous?: true;
}

/**
 * What an image is doing, as observed when asked:
 *
 * - `creating`: a create is still preparing it, whatever VM runs it.
 * - `unfinished`: the create that made it ended before it was done; only
 *   `delete` takes it.
 * - `stopped`: no VM runs it.
 * - `starting`: a start of this PLexus launched it, and its MCP server has
 *   not said where it answers yet.
 * - `running`: it takes calls at its `endpoint`.
 * - `unreachable`: a VM runs it and it takes no calls through PLexus;
 *   `endpointProblem` says why.
 */
export type ImageState = "creating" | "unfinished" | "stopped" | "starting" | "running" | "unreachable";

/**
 * Why an image records no calls through OpenTelemetry:
 *
 * - `not-asked`: the PLexus that made it, or that started it, was not asked
 *   to enroll images in OpenTelemetry;
 * - `base-failed`: the base holding MCP's `Telemetry` group could not be
 *   built, so it is a copy of the base without it;
 * - `no-backend`: its MCP has no OpenTelemetry backend;
 * - `switch-failed`: its MCP server did not switch to that backend when it
 *   started.
 */
export type TelemetryOffReason = "not-asked" | "base-failed" | "no-backend" | "switch-failed";

/** Whether an image records its calls through OpenTelemetry; when not, why, and the failure's own words for one that failed. */
export type ImageTelemetry = { on: true } | { on: false; reason?: TelemetryOffReason; detail?: string };

/**
 * How MCP got into an image: the pinned release, or a script, which every
 * start files in again when `everyStart` says so.
 */
export type ImageMcp = { source: "pin"; version: string } | { source: "script"; script: string; everyStart?: true };

/** One image, as observed when asked. */
export interface ImageInfo {
  /** The name the caller uses, without the scope. */
  name: string;
  /** The absolute path of its image file. */
  path: string;
  state: ImageState;
  /** A VM runs this image file now, whatever its state. */
  running: boolean;
  pids: number[];
  display?: Display;
  /** Only when it belongs to a VM running this image. */
  endpoint?: Endpoint;
  /** Why an `unreachable` image takes no calls, in words for a person. */
  endpointProblem?: string;
  template?: string;
  /** As Pharo says it: `14.0`. */
  pharoVersion?: string;
  mcp?: ImageMcp;
  /**
   * Whether it records its calls through OpenTelemetry: for a running image,
   * what its start did; otherwise what its create gave it, whether a start
   * that enrolls it records them. Absent when neither said.
   */
  telemetry?: ImageTelemetry;
  /**
   * When it was last used, as an ISO date and time: the later of its last
   * start and its last save. Absent when neither left a file.
   */
  lastUsed?: string;
  /** The size of its image file, in bytes. */
  imageBytes?: number;
}

/** The image a create made, as `list` would show it, and how long the create took. */
export type CreateResult = ImageInfo & { seconds: number };

export interface StartResult {
  name: string;
  pids: number[];
  endpoint: Endpoint;
  display: Display;
  seconds: number;
  /** Whether its server records its calls through OpenTelemetry, and why not: see `ImageInfo.telemetry`. */
  telemetry?: ImageTelemetry;
  /** The image was already running and answering, and was left as it was. */
  alreadyRunning?: true;
}

export interface StopResult {
  name: string;
  /** The VMs killed: those left after the image quit or saved, or every one that ran it when it did neither. */
  killed: number[];
  /** The image quit without saving when asked. */
  quit?: true;
  /** The image saved itself and quit. */
  saved?: true;
}

export interface DeleteResult {
  name: string;
}

export interface CreateOptions {
  /**
   * The template's name, found in the template list as `chooseTemplate` says:
   * a mainline Pharo or Moose version such as `14` names its template, and
   * none is the current stable Pharo.
   */
  template?: string;
  /** Resolved from the template list when absent. */
  category?: string;
  /** Filed in instead of loading the pinned MCP; relative to the working directory. */
  script?: string;
  /** File the script in at every start as well. */
  everyStart?: boolean;
}

export interface StartOptions {
  display?: Display;
  /** How long the image has to answer: 300000 unless given. */
  timeoutMs?: number;
}

export interface StopOptions {
  /**
   * Have the image save itself and quit, through its MCP server. Unless
   * given, it is asked to quit without saving, and killed if it does not.
   */
  save?: boolean;
}

/** The library reads no environment: what the command takes from it, a program passes here. */
export interface ImagesOptions {
  /** `~/.plexus` unless given; `plexusHome()` is where the `plexus` command keeps them. */
  home?: string;
  /**
   * Where Pharo Launcher is installed, when not in its usual place for the
   * platform. The `plexus` command takes it from `PHARO_LAUNCHER_DIR`.
   */
  launcherDir?: string;
  /**
   * A name prefix, without dashes: image `dev` is the directory `<scope>-dev`.
   * Without one, an image is named by its directory, so `shop-dev` is image
   * `dev` of scope `shop`, and every image in the store is reached.
   */
  scope?: string;
  /**
   * Enroll the images handled in OpenTelemetry: an image made without a
   * script loads MCP's `Telemetry` group as well, and an image started
   * switches its MCP server to the OpenTelemetry backend when it has one.
   * Off unless given.
   */
  telemetry?: boolean;
}

/** A tool an image lists, as the protocol sends it. */
export interface ImageTool {
  name: string;
  description?: string;
  inputSchema: { type: "object"; properties?: Record<string, unknown>; required?: string[]; [key: string]: unknown };
  [key: string]: unknown;
}

/** An image tool's answer, as the protocol sends it. */
export interface ImageToolResult {
  content: Array<{ type: string; [key: string]: unknown }>;
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
  [key: string]: unknown;
}
