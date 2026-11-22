import fs from "node:fs";
import * as texts from "../answers/texts.js";
import { PlexusError } from "../errors.js";
import {
  parseEndpointHandoff,
  type EndpointHandoff,
} from "../forward/endpointHandoffFormat.js";
import type { LauncherProcess } from "../launcher/pharoLauncherMcpClient.js";
import type { Endpoint, ImageInfo, ImageTelemetry } from "../types.js";
import { parseProperties, telemetryOf, type ImageFiles } from "./store.js";

/**
 * Where a running image answers, and whether its server records its calls
 * when its start said; or that a start of this PLexus launched it and its
 * server has not written where yet, so it is starting and will; or why it
 * takes no calls.
 */
export type EndpointObservation =
  | { endpoint: Endpoint; telemetry?: ImageTelemetry }
  | { starting: true }
  | { problem: string };

/**
 * The endpoint a running image wrote, when it belongs to one of the VMs
 * running it now. A port outlives the VM that bound it, so a file alone says
 * nothing: an image that binds port 0 leaves that port to be reused.
 */
export function observeEndpoint(
  files: ImageFiles,
  vms: readonly LauncherProcess[],
): EndpointObservation {
  let text: string;
  try {
    text = fs.readFileSync(files.endpoint, "utf8");
  } catch {
    // A VM this PLexus launched names the start script and writes its
    // endpoint soon; any other VM on the image never will, so waiting is
    // not the answer for it.
    return vms.some((vm) => namesStartScript(vm, files))
      ? { starting: true }
      : { problem: "not started by this PLexus" };
  }

  let handoff: EndpointHandoff;
  try {
    handoff = parseEndpointHandoff(text);
  } catch (error) {
    return {
      problem: `the endpoint file is invalid: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const url = endpointUrl(handoff);
  const telemetry = telemetryOf(parseProperties(text));
  const said = telemetry === undefined ? {} : { telemetry };
  if (handoff.pid !== undefined) {
    return vms.some((vm) => vm.pid === handoff.pid)
      ? { endpoint: { url, pid: handoff.pid }, ...said }
      : { problem: `the endpoint names pid ${handoff.pid}, which does not run this image` };
  }
  // An image that cannot tell its pid writes none. A VM this PLexus launched
  // names the start script on its command line, and that VM is the writer.
  return vms.some((vm) => namesStartScript(vm, files))
    ? { endpoint: { url }, ...said }
    : { problem: "not started by this PLexus" };
}

/**
 * Where a call to the image goes, or why none can, from one look at it. A
 * create still making the image comes first whatever runs it: a script
 * create's own VM does not name the start script, and stopping it would kill
 * the create.
 */
export function endpointOf(row: ImageInfo): Endpoint {
  switch (row.state) {
    case "creating":
      throw new PlexusError("building", texts.stillBuilding(row.name));
    case "stopped":
      throw new PlexusError("not-running", texts.notRunning(row.name));
    case "starting":
      throw new PlexusError("starting", texts.starting(row.name, row.pids), { pids: row.pids });
    case "unreachable":
      throw new PlexusError(
        "no-endpoint",
        texts.takesNoCalls(row.name, row.pids, row.endpointProblem ?? "it wrote no endpoint"),
        { pids: row.pids },
      );
    case "running":
      if (row.endpoint !== undefined) {
        return row.endpoint;
      }
      throw new PlexusError(
        "no-endpoint",
        texts.takesNoCalls(row.name, row.pids, "it wrote no endpoint"),
        { pids: row.pids },
      );
  }
}

export function endpointUrl(handoff: EndpointHandoff): string {
  const host = handoff.host.includes(":") && !handoff.host.startsWith("[")
    ? `[${handoff.host}]`
    : handoff.host;
  return `http://${host}:${handoff.port}${handoff.path}`;
}

function namesStartScript(vm: LauncherProcess, files: ImageFiles): boolean {
  const spellings = new Set([files.startScript]);
  try {
    spellings.add(
      fs.realpathSync.native(files.plexusDir) + files.startScript.slice(files.plexusDir.length),
    );
  } catch {
    // No plexus directory, so no start script either.
  }
  return [...spellings].some((spelling) => vm.commandLine.includes(spelling));
}
