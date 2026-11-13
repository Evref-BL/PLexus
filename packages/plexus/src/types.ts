import type { LauncherPort } from "./launcher/pharoLauncherMcpClient.js";

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
  /** The name is in more than one category, so a create must say which. */
  ambiguous?: true;
}

/** One image, as observed when asked. */
export interface ImageInfo {
  /** The name the caller uses, without the scope. */
  name: string;
  /** Its directory and file base name in the store. */
  diskName: string;
  /** The absolute path of `<diskName>.image`. */
  path: string;
  /** A VM runs this image file now. */
  running: boolean;
  pids: number[];
  display?: Display;
  /** Only when it belongs to a VM running this image. */
  endpoint?: Endpoint;
  /** Why a running image has no endpoint. */
  endpointProblem?: string;
  /** A create is still preparing it. */
  building?: true;
  template?: string;
  pharoVersion?: string;
  /** How MCP got into it: the pinned release, or a script. */
  mcp?: { source: "pin"; version: string } | { source: "script"; script: string };
  /** The script every start files in before MCP starts. */
  everyStart?: string;
}

export interface CreateOptions {
  template: string;
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

export interface ImagesOptions {
  /** `plexusHome()` unless given. */
  home?: string;
  /** A name prefix: image `dev` is the directory `<scope>-dev`. */
  scope?: string;
  /** The launcher on the home's profile unless given. */
  launcher?: LauncherPort;
}
