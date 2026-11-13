import path from "node:path";
import { ping } from "../forward/index.js";
import { plexusHome } from "../home.js";
import {
  openLauncherPort,
  type LauncherPort,
} from "../launcher/pharoLauncherMcpClient.js";
import type { Endpoint, ImagesOptions } from "../types.js";
import { checkScope } from "./names.js";

/**
 * What every operation works with. The clock and the ping are here so that a
 * test can run a start without waiting for one.
 */
export interface ImagesContext {
  home: string;
  scope?: string;
  launcher(): LauncherPort;
  ping(endpoint: Endpoint): Promise<boolean>;
  sleep(ms: number): Promise<void>;
  now(): number;
  /** How often a start or a stop asks the host again. */
  pollMs: number;
  /** How long a start waits for a VM to appear on the image at all. */
  vmAppearMs: number;
  /** How long a stop waits for the VMs it killed to go. */
  stopWaitMs: number;
}

export function imagesContext(options: ImagesOptions = {}): ImagesContext {
  // The launcher is handed these paths, and a VM's command line is compared
  // with them, so they are absolute whatever the caller's directory.
  const home = options.home === undefined ? plexusHome() : path.resolve(options.home);
  const scope = checkScope(options.scope);
  let launcher = options.launcher;
  return {
    home,
    ...(scope === undefined ? {} : { scope }),
    // Opening resolves the launcher installation, which an operation that
    // never reaches the launcher has no reason to pay for.
    launcher: () => (launcher ??= openLauncherPort(home)),
    ping: (endpoint) => ping(endpoint),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    pollMs: 250,
    vmAppearMs: 30_000,
    stopWaitMs: 10_000,
  };
}
