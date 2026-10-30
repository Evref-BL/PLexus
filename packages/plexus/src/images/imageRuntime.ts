import fs from "node:fs";
import net from "node:net";
import {
  imageMcpEndpointHandoffPath,
  readImageMcpEndpointHandoff,
} from "../gateway/projectImageMcpEndpoint.js";
import { joinPathLike } from "../support/pathStyle.js";
import type { ProjectStatePathOptions } from "../workspace/projectState.js";

/**
 * What an image is doing, observed when asked rather than read from a record.
 *
 * "absent" means no image file on disk, "stopped" means a file and nothing
 * alive, "starting" means a live process whose MCP has not bound yet, and
 * "running" means an endpoint that answers. The gap between the last two is
 * the window the endpoint handoff covers.
 */
export type ImageRuntimeStatus = "absent" | "stopped" | "starting" | "running";

export interface ImageProcessObservation {
  /** The pid PLexus recorded, still running. */
  alive: boolean;
  /**
   * Whether the host reports a VM on this image, when the host was asked.
   * A fact, not a handle: the pids themselves stay out of a scoped listing.
   */
  onHost?: boolean;
}

export interface ImageEndpointObservation {
  handoff: "missing" | "valid" | "invalid";
  listening: boolean;
  url?: string;
  error?: string;
}

export interface ImageRuntimeObservation {
  status: ImageRuntimeStatus;
  /** Undefined when the launcher profile does not say where images live. */
  materialized?: boolean;
  process: ImageProcessObservation;
  endpoint: ImageEndpointObservation;
}

export interface ObserveImageRuntimeOptions extends ProjectStatePathOptions {
  imageId: string;
  /** Rendered image name; without it materialization cannot be observed. */
  imageName?: string;
  /** The launcher profile's images directory, when one is known. */
  imagesDirectory?: string;
  /** The pid PLexus recorded when it launched the image, if any. */
  pid?: number;
  /**
   * Whether the host reports a VM on this image. Undefined means the host was
   * not asked, and the observation falls back to the pid and the port.
   */
  runningOnHost?: boolean;
  isPidAlive?: (pid: number) => boolean;
  isPortListening?: (host: string, port: number) => Promise<boolean>;
}

/**
 * Something is listening there. Binding the port ourselves is the cheapest
 * honest answer: if the bind fails, the port is taken.
 */
export async function isPortInUse(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    const finish = (unavailable: boolean): void => {
      server.removeAllListeners();
      resolve(unavailable);
    };

    server.once("error", () => finish(true));
    server.listen(port, host, () => {
      server.close(() => finish(false));
    });
  });
}

export function isPidAlive(pid: number): boolean {
  try {
    globalThis.process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means a process exists that we may not signal.
    return errorCode(error) === "ESRCH" ? false : true;
  }
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

export function imageFileExists(
  imagesDirectory: string,
  imageName: string,
): boolean {
  return fs.existsSync(joinPathLike(imagesDirectory, imageName));
}

export async function observeImageRuntime(
  options: ObserveImageRuntimeOptions,
): Promise<ImageRuntimeObservation> {
  const pidAlive = options.isPidAlive ?? isPidAlive;
  const portListening = options.isPortListening ?? isPortInUse;

  const materialized =
    options.imagesDirectory === undefined || options.imageName === undefined
      ? undefined
      : imageFileExists(options.imagesDirectory, options.imageName);

  const process: ImageProcessObservation = {
    alive: options.pid === undefined ? false : pidAlive(options.pid),
    ...(options.runningOnHost === undefined
      ? {}
      : { onHost: options.runningOnHost }),
  };

  const endpoint = await observeEndpoint(options, portListening);

  return {
    status: runtimeStatus(materialized, process, endpoint),
    ...(materialized === undefined ? {} : { materialized }),
    process,
    endpoint,
  };
}

async function observeEndpoint(
  options: ObserveImageRuntimeOptions,
  portListening: (host: string, port: number) => Promise<boolean>,
): Promise<ImageEndpointObservation> {
  const handoff = readImageMcpEndpointHandoff(
    imageMcpEndpointHandoffPath({
      projectRoot: options.projectRoot,
      projectId: options.projectId,
      ...(options.workspaceId === undefined
        ? {}
        : { workspaceId: options.workspaceId }),
      ...(options.stateRoot === undefined
        ? {}
        : { stateRoot: options.stateRoot }),
      imageId: options.imageId,
    }),
  );

  if (handoff.status === "missing") {
    return { handoff: "missing", listening: false };
  }

  if (handoff.status === "invalid") {
    return { handoff: "invalid", listening: false, error: handoff.error };
  }

  const { host, port, transport, path } = handoff.endpoint;
  return {
    handoff: "valid",
    listening: await portListening(host, port),
    url: `${transport === "http" ? "http" : transport}://${host}:${port}${path}`,
  };
}

function runtimeStatus(
  materialized: boolean | undefined,
  process: ImageProcessObservation,
  endpoint: ImageEndpointObservation,
): ImageRuntimeStatus {
  // The host is the authority when it was asked, whoever started the VM: no VM
  // on the image means the port the handoff names belongs to something else,
  // because an image that binds port 0 leaves that port to be reused the
  // moment it dies.
  const onHost = process.onHost;
  if (onHost === false) {
    return materialized === false ? "absent" : "stopped";
  }

  // A port that refuses to bind is not the same as something answering, so it
  // only decides when nothing better was asked.
  if (endpoint.listening) {
    return "running";
  }
  if (onHost === true || process.alive) {
    return "starting";
  }

  return materialized === false ? "absent" : "stopped";
}
