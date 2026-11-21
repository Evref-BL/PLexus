import path from "node:path";
import { callTool, listTools, ping, type CallToolOptions } from "../forward/index.js";
import { defaultHome } from "../home.js";
import {
  openLauncherPort,
  type LauncherPort,
} from "../launcher/pharoLauncherMcpClient.js";
import type { Endpoint, ImagesOptions, ImageToolResult } from "../types.js";
import { checkScope } from "./names.js";

/**
 * What every operation works with. The clock, the ping and the calls a stop
 * makes to save an image are here so that a test can run a start or a stop
 * without an image.
 */
export interface ImagesContext {
  home: string;
  scope?: string;
  /** Whether the images made and started are enrolled in OpenTelemetry. */
  telemetry: boolean;
  launcher(): LauncherPort;
  ping(endpoint: Endpoint): Promise<boolean>;
  /** The tools an image lists, for the one a stop that saves evaluates with. */
  listTools(endpoint: Endpoint): Promise<ReadonlyArray<{ name: string }>>;
  /** One call to an image's tool, as forwarding makes it. */
  callTool(
    endpoint: Endpoint,
    name: string,
    args: Record<string, unknown>,
    options: CallToolOptions,
  ): Promise<ImageToolResult>;
  sleep(ms: number): Promise<void>;
  now(): number;
  /** How often a start or a stop asks the host again. */
  pollMs: number;
  /** How long a start waits for a VM to appear on the image at all. */
  vmAppearMs: number;
  /** How long a stop waits for the VMs it killed to go. */
  stopWaitMs: number;
  /** How long a stop that saves waits for the image to take the save, and for its VM to quit. */
  saveWaitMs: number;
}

/**
 * How long a stop that saves waits on each request of the image's tool
 * listing: an image that cannot list its tools in that time will not take
 * the save either.
 */
const listingWaitMs = 10_000;

/**
 * The options of an `Images`, with what only tests pass: a launcher that
 * runs no Pharo. It is not exported from the package, so no program depends
 * on pharo-launcher-mcp's types through PLexus's.
 */
export interface InternalImagesOptions extends ImagesOptions {
  launcher?: LauncherPort;
}

export function imagesContext(options: InternalImagesOptions = {}): ImagesContext {
  // The launcher is handed these paths, and a VM's command line is compared
  // with them, so they are absolute whatever the caller's directory.
  const home = options.home === undefined ? defaultHome() : path.resolve(options.home);
  const scope = checkScope(options.scope);
  let launcher = options.launcher;
  return {
    home,
    ...(scope === undefined ? {} : { scope }),
    telemetry: options.telemetry === true,
    // Opening resolves the launcher installation, which an operation that
    // never reaches the launcher has no reason to pay for.
    launcher: () => (launcher ??= openLauncherPort(home)),
    ping: (endpoint) => ping(endpoint),
    listTools: (endpoint) => listTools(endpoint, { timeoutMs: listingWaitMs }),
    callTool: (endpoint, name, args, callOptions) => callTool(endpoint, name, args, callOptions),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    pollMs: 250,
    vmAppearMs: 30_000,
    stopWaitMs: 10_000,
    saveWaitMs: 60_000,
  };
}
