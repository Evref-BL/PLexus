import fs from "node:fs";
import path from "node:path";

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
  targetId?: string;
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

export interface GatewayProjectImageCreationSourceState {
  kind: string;
  profileId?: string;
  templateName?: string;
  templateCategory?: string;
}

export interface GatewayProjectImageCreationRouteState {
  serverName?: string;
  targetKey?: string;
  imageArgument?: string;
  imageId?: string;
}

export interface GatewayProjectImageCreationState {
  role?: string;
  source?: GatewayProjectImageCreationSourceState;
  cleanupPolicy?: string;
  route?: GatewayProjectImageCreationRouteState;
}

export interface GatewayProjectImageState {
  id: string;
  imageName: string;
  assignedPort?: number;
  mcpServers?: GatewayProjectImageMcpServer[];
  pid?: number;
  status: GatewayProjectImageStatus;
  creation?: GatewayProjectImageCreationState;
  pharoMcpContract?: GatewayProjectImagePharoMcpContractState;
}

export interface GatewayProjectState {
  projectId: string;
  projectName: string;
  workspaceId: string;
  targetId: string;
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
    targetId: string;
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
  pid?: number;
  status: GatewayProjectImageStatus;
  health: GatewayImageHealth;
  routable: GatewayImageRoutability;
  routeMetadata: GatewayImageRouteMetadata;
  creation?: GatewayProjectImageCreationState;
  pharoMcpContract?: GatewayProjectImagePharoMcpContractState;
  updatedAt: string;
}

export interface GatewayProjectRoute {
  projectId: string;
  projectName: string;
  workspaceId: string;
  targetId: string;
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
      targetId: state.targetId,
    },
    mcpServerIdSource: "Read images[].mcpServers[].id from gateway status",
    recordHint:
      "Record the selected mcpServerId with the scoped project/workspace/target before calling pharo_gateway tools",
  };
}

export class PlexusRoutingTable {
  private readonly targets = new Map<string, GatewayProjectRoute>();

  upsertProject(
    projectRoot: string,
    statePath: string,
    state: GatewayProjectState,
  ): GatewayProjectRoute {
    const mcpServerIds = new Set<string>();
    for (const image of state.images) {
      for (const server of imageMcpServers(image)) {
        if (mcpServerIds.has(server.id)) {
          throw new Error(
            `MCP server id ${server.id} is duplicated in target ${state.targetId}`,
          );
        }
        mcpServerIds.add(server.id);
      }
    }

    const existing = this.targets.get(state.targetId);
    const existingHealth = new Map(
      existing?.images.map((image) => [image.mcpServerId, image.health]) ?? [],
    );
    const route: GatewayProjectRoute = {
      projectId: state.projectId,
      projectName: state.projectName,
      workspaceId: state.workspaceId,
      targetId: state.targetId,
      projectRoot: path.resolve(projectRoot),
      statePath,
      ...(state.pharoMcpContract
        ? { pharoMcpContract: state.pharoMcpContract }
        : {}),
      updatedAt: state.updatedAt,
      images: state.images.flatMap((image) =>
        imageMcpServers(image).map((server) => {
          const port = server.endpoint.port;
          const health = existingHealth.get(server.id) ?? "unknown";
          return {
            id: image.id,
            mcpServerId: server.id,
            imageName: image.imageName,
            ...(port !== undefined ? { port } : {}),
            endpoint: server.endpoint,
            ...(image.pid ? { pid: image.pid } : {}),
            status: image.status,
            health,
            routable: imageRoutability(state.pharoMcpContract, {
              ...image,
              endpoint: server.endpoint,
              health,
              remoteGateway: state.remoteGateway,
            }),
            routeMetadata: imageRouteMetadata(state, server.id),
            ...(image.creation ? { creation: image.creation } : {}),
            ...(image.pharoMcpContract
              ? { pharoMcpContract: image.pharoMcpContract }
              : {}),
            updatedAt: state.updatedAt,
          };
        }),
      ),
      ...(state.remoteGateway ? { remoteGateway: state.remoteGateway } : {}),
    };

    this.targets.set(route.targetId, route);
    return route;
  }

  getTarget(targetId: string): GatewayProjectRoute | undefined {
    return this.targets.get(targetId);
  }

  removeTarget(targetId: string): GatewayProjectRoute | undefined {
    const route = this.targets.get(targetId);
    if (route) {
      this.targets.delete(targetId);
    }

    return route;
  }

  removeProjectWorkspace(
    projectId: string,
    workspaceId: string,
  ): GatewayProjectRoute | undefined {
    const route = this.getProjectWorkspace(projectId, workspaceId);
    return route ? this.removeTarget(route.targetId) : undefined;
  }

  removeRoutesWithMissingStatePaths(
    statePathExists: (statePath: string) => boolean = fs.existsSync,
  ): GatewayProjectRoute[] {
    const removed: GatewayProjectRoute[] = [];

    for (const route of this.listTargets()) {
      if (!statePathExists(route.statePath)) {
        const deleted = this.removeTarget(route.targetId);
        if (deleted) {
          removed.push(deleted);
        }
      }
    }

    return removed;
  }

  getProjectWorkspace(
    projectId: string,
    workspaceId: string,
  ): GatewayProjectRoute | undefined {
    return this.listProjectTargets(projectId).find(
      (route) => route.workspaceId === workspaceId,
    );
  }

  listProjectTargets(projectId: string): GatewayProjectRoute[] {
    return this.listTargets().filter((route) => route.projectId === projectId);
  }

  listTargets(): GatewayProjectRoute[] {
    return [...this.targets.values()];
  }

  findMcpServerOutsideTarget(
    projectId: string,
    targetId: string,
    mcpServerId: string,
  ): GatewayProjectRoute | undefined {
    return this.listProjectTargets(projectId).find(
      (route) =>
        route.targetId !== targetId &&
        route.images.some((image) => image.mcpServerId === mcpServerId),
    );
  }

  updateImageHealth(
    targetId: string,
    mcpServerId: string,
    health: GatewayImageHealth,
  ): void {
    const project = this.targets.get(targetId);
    const image = project?.images.find(
      (candidate) => candidate.mcpServerId === mcpServerId,
    );
    if (image) {
      image.health = health;
      image.routable = imageRoutability(project?.pharoMcpContract, image);
      image.updatedAt = new Date().toISOString();
    }
  }
}
