import path from "node:path";

import { isPidAlive } from "../support/processLiveness.js";
import {
  discoverImageMcpServers,
  readProjectState,
  type RouteDiscoveryDependencies,
  type RouteDiscoverySource,
} from "./routeDiscovery.js";

export type GatewayProjectImageStatus =
  | "starting"
  | "running"
  | "stopped"
  | "failed";
export type GatewayPharoMcpContractStatus =
  | "unknown"
  | "matching"
  | "mismatched"
  | "unsupported";
export type GatewayImageMcpEndpointTransport = "http";

export interface GatewayImageMcpEndpoint {
  transport: GatewayImageMcpEndpointTransport;
  host: string;
  port: number;
  path: string;
  /** The process that bound the port, when the image could tell. */
  pid?: number;
}

export interface GatewayProjectImageMcpServer {
  id: string;
  endpoint: GatewayImageMcpEndpoint;
}

export interface GatewayRemoteGatewayUpstream {
  remoteNodeId: string;
  endpoint: GatewayImageMcpEndpoint;
  projectId?: string;
  workspaceId?: string;
}

export interface GatewayPharoMcpContractReference {
  id?: string;
  hash?: string;
}

export interface GatewayProjectImagePharoMcpContractState
  extends GatewayPharoMcpContractReference {
  status?: GatewayPharoMcpContractStatus;
  expectedId?: string;
  expectedHash?: string;
  metadataKey?: string;
  actualMajorVersion?: number;
  supportedMajorVersions?: number[];
  reason?: string;
}




export interface GatewayProjectImageState {
  id: string;
  imageName: string;
  mcpServers?: GatewayProjectImageMcpServer[];
  status: GatewayProjectImageStatus;
  pharoMcpContract?: GatewayProjectImagePharoMcpContractState;
}

export interface GatewayProjectState {
  projectId: string;
  projectName: string;
  workspaceId: string;
  remoteGateway?: GatewayRemoteGatewayUpstream;
  pharoMcpContract?: GatewayPharoMcpContractReference;
  images: GatewayProjectImageState[];
  updatedAt: string;
}

export type GatewayImageHealth = "unknown" | "healthy" | "unhealthy";
export type GatewayImageRoutabilityCode =
  | "ready"
  | "image_unavailable"
  | "unsupported"
  | "contract_unknown"
  | "contract_mismatch";

export interface GatewayImageRoutability {
  ok: boolean;
  code: GatewayImageRoutabilityCode;
  message: string;
}

export interface GatewayImageRouteMetadata {
  serverName: "pharo_gateway";
  requiredArgument: "mcpServerId";
  mcpServerId: string;
  routeReference: {
    projectId: string;
    workspaceId: string;
  };
  mcpServerIdSource: string;
  recordHint: string;
}

export interface GatewayImageRoute {
  id: string;
  mcpServerId: string;
  imageName: string;
  port?: number;
  endpoint: GatewayImageMcpEndpoint;
  status: GatewayProjectImageStatus;
  health: GatewayImageHealth;
  routable: GatewayImageRoutability;
  routeMetadata: GatewayImageRouteMetadata;
  pharoMcpContract?: GatewayProjectImagePharoMcpContractState;
  updatedAt: string;
}

export interface GatewayProjectRoute {
  projectId: string;
  projectName: string;
  workspaceId: string;
  projectRoot: string;
  statePath: string;
  remoteGateway?: GatewayRemoteGatewayUpstream;
  pharoMcpContract?: GatewayPharoMcpContractReference;
  images: GatewayImageRoute[];
  updatedAt: string;
}

function contractLabel(
  contract: GatewayPharoMcpContractReference | undefined,
): string {
  if (!contract) {
    return "none";
  }

  return contract.hash ?? contract.id ?? "unknown";
}

function requiredProjectContractFields(
  contract: GatewayPharoMcpContractReference | undefined,
): Array<keyof GatewayPharoMcpContractReference> {
  if (!contract) {
    return [];
  }

  return (["id", "hash"] as const).filter((key) => contract[key] !== undefined);
}

function contractRoutability(
  projectContract: GatewayPharoMcpContractReference | undefined,
  imageContract: GatewayProjectImagePharoMcpContractState | undefined,
  imageId: string,
): GatewayImageRoutability {
  if (imageContract?.status === "unsupported") {
    return {
      ok: false,
      code: "unsupported",
      message:
        imageContract.reason ??
        `Image ${imageId} Pharo MCP contract is unsupported`,
    };
  }

  if (imageContract?.status === "mismatched") {
    return {
      ok: false,
      code: "contract_mismatch",
      message: `Image ${imageId} Pharo MCP contract is marked as mismatched`,
    };
  }

  const requiredFields = requiredProjectContractFields(projectContract);
  if (requiredFields.length === 0) {
    return {
      ok: true,
      code: "ready",
      message: "Image is routable",
    };
  }

  if (!imageContract || imageContract.status === "unknown") {
    return {
      ok: false,
      code: "contract_unknown",
      message: `Image ${imageId} Pharo MCP contract is unknown; expected ${contractLabel(projectContract)}`,
    };
  }

  for (const field of requiredFields) {
    if (imageContract[field] === undefined) {
      return {
        ok: false,
        code: "contract_unknown",
        message: `Image ${imageId} Pharo MCP contract is missing ${String(field)}; expected ${contractLabel(projectContract)}`,
      };
    }

    if (imageContract[field] !== projectContract?.[field]) {
      return {
        ok: false,
        code: "contract_mismatch",
        message: `Image ${imageId} Pharo MCP contract does not match project contract`,
      };
    }
  }

  return {
    ok: true,
    code: "ready",
    message: "Image is routable",
  };
}

function imageRoutability(
  projectContract: GatewayPharoMcpContractReference | undefined,
  image: Pick<
    GatewayProjectImageState,
    "id" | "status" | "pharoMcpContract"
  > & {
    endpoint?: GatewayImageMcpEndpoint;
    health?: GatewayImageHealth;
    remoteGateway?: GatewayRemoteGatewayUpstream;
  },
  processIsAlive: (pid: number) => boolean = isPidAlive,
): GatewayImageRoutability {
  if (image.pharoMcpContract?.status === "unsupported") {
    return contractRoutability(
      projectContract,
      image.pharoMcpContract,
      image.id,
    );
  }

  if (
    !image.endpoint &&
    image.remoteGateway === undefined
  ) {
    return {
      ok: false,
      code: "image_unavailable",
      message: `Image ${image.id} has no registered MCP endpoint`,
    };
  }

  if (image.status !== "running") {
    return {
      ok: false,
      code: "image_unavailable",
      message: `Image ${image.id} is not running; current status is ${image.status}`,
    };
  }

  // The endpoint names the process that bound the port. That process is gone,
  // so whatever holds the port now is not this image, and routing a tool call
  // to it would be routing it to a stranger. An image binds port 0, so the
  // port it wrote down is free to be reused the moment it dies.
  if (
    image.endpoint?.pid !== undefined &&
    !processIsAlive(image.endpoint.pid)
  ) {
    return {
      ok: false,
      code: "image_unavailable",
      message: `Image ${image.id} left an endpoint behind: the process that bound its port has exited`,
    };
  }

  if (image.health === "unhealthy") {
    return {
      ok: false,
      code: "image_unavailable",
      message: `Image ${image.id} health check failed`,
    };
  }

  return contractRoutability(
    projectContract,
    image.pharoMcpContract,
    image.id,
  );
}

function imageMcpServers(
  image: GatewayProjectImageState,
): GatewayProjectImageMcpServer[] {
  return image.mcpServers ?? [];
}

function imageRouteMetadata(
  state: GatewayProjectState,
  mcpServerId: string,
): GatewayImageRouteMetadata {
  return {
    serverName: "pharo_gateway",
    requiredArgument: "mcpServerId",
    mcpServerId,
    routeReference: {
      projectId: state.projectId,
      workspaceId: state.workspaceId,
    },
    mcpServerIdSource: "Read images[].mcpServers[].id from gateway status",
    recordHint:
      "Record the selected mcpServerId with the scoped project and workspace before calling pharo_gateway tools",
  };
}

/**
 * Routes are resolved when asked, from the project's own files: the state file
 * for what is declared, the handoff files for what is listening. Nothing is
 * registered, so nothing can go stale.
 */
export class PlexusRoutingTable {
  private readonly sources: RouteDiscoverySource[];
  private readonly dependencies: RouteDiscoveryDependencies;
  // Health is the outcome of calls we made, which no file records.
  private readonly health = new Map<string, GatewayImageHealth>();

  constructor(
    sources: readonly RouteDiscoverySource[] = [],
    dependencies: RouteDiscoveryDependencies = {},
  ) {
    this.sources = [...sources];
    this.dependencies = dependencies;
  }

  /**
   * Which projects this gateway looks in. A source is a directory, not a
   * route: it cannot go stale, because nothing is claimed about what is in it.
   */
  addSource(source: RouteDiscoverySource): void {
    this.sources.push(source);
  }

  getProjectWorkspace(
    projectId: string,
    workspaceId: string,
  ): GatewayProjectRoute | undefined {
    return this.listTargets().find(
      (route) =>
        route.projectId === projectId && route.workspaceId === workspaceId,
    );
  }

  listProjectTargets(projectId: string): GatewayProjectRoute[] {
    return this.listTargets().filter((route) => route.projectId === projectId);
  }

  listTargets(): GatewayProjectRoute[] {
    const routes: GatewayProjectRoute[] = [];
    for (const source of this.sources) {
      const route = this.resolve(source);
      if (route) {
        routes.push(route);
      }
    }

    return routes;
  }

  findMcpServerOutsideWorkspace(
    projectId: string,
    workspaceId: string,
    mcpServerId: string,
  ): GatewayProjectRoute | undefined {
    return this.listProjectTargets(projectId).find(
      (route) =>
        route.workspaceId !== workspaceId &&
        route.images.some((image) => image.mcpServerId === mcpServerId),
    );
  }

  updateImageHealth(
    projectId: string,
    workspaceId: string,
    mcpServerId: string,
    health: GatewayImageHealth,
  ): void {
    this.health.set(healthKey(projectId, workspaceId, mcpServerId), health);
  }

  private resolve(
    source: RouteDiscoverySource,
  ): GatewayProjectRoute | undefined {
    const state = readProjectState(source.statePath, this.dependencies);
    if (!state) {
      return undefined;
    }

    const images = state.images.flatMap((image) =>
      discoverImageMcpServers(
        source.statePath,
        image.id,
        this.dependencies,
      ).map((server) => {
        const health =
          this.health.get(
            healthKey(state.projectId, state.workspaceId, server.id),
          ) ?? "unknown";
        return {
          id: image.id,
          mcpServerId: server.id,
          imageName: image.imageName,
          port: server.endpoint.port,
          endpoint: server.endpoint,
          status: image.status,
          health,
          routable: imageRoutability(
            state.pharoMcpContract,
            {
              ...image,
              endpoint: server.endpoint,
              health,
              remoteGateway: state.remoteGateway,
            },
            this.dependencies.isPidAlive ?? isPidAlive,
          ),
          routeMetadata: imageRouteMetadata(state, server.id),
          ...(image.pharoMcpContract
            ? { pharoMcpContract: image.pharoMcpContract }
            : {}),
          updatedAt: state.updatedAt,
        };
      }),
    );

    return {
      projectId: state.projectId,
      projectName: state.projectName,
      workspaceId: state.workspaceId,
      projectRoot: path.resolve(source.projectRoot),
      statePath: source.statePath,
      ...(state.pharoMcpContract
        ? { pharoMcpContract: state.pharoMcpContract }
        : {}),
      updatedAt: state.updatedAt,
      images,
      ...(state.remoteGateway ? { remoteGateway: state.remoteGateway } : {}),
    };
  }
}

function healthKey(
  projectId: string,
  workspaceId: string,
  mcpServerId: string,
): string {
  return `${projectId}/${workspaceId}/${mcpServerId}`;
}
