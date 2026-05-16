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
  | "mismatched";

export interface GatewayPharoMcpContractReference {
  id?: string;
  hash?: string;
}

export interface GatewayProjectImagePharoMcpContractState
  extends GatewayPharoMcpContractReference {
  status?: GatewayPharoMcpContractStatus;
  expectedId?: string;
  expectedHash?: string;
}

export interface GatewayProjectImageState {
  id: string;
  imageName: string;
  assignedPort: number;
  pid?: number;
  status: GatewayProjectImageStatus;
  pharoMcpContract?: GatewayProjectImagePharoMcpContractState;
}

export interface GatewayProjectState {
  projectId: string;
  projectName: string;
  workspaceId: string;
  targetId: string;
  pharoMcpContract?: GatewayPharoMcpContractReference;
  images: GatewayProjectImageState[];
  updatedAt: string;
}

export type GatewayImageHealth = "unknown" | "healthy" | "unhealthy";
export type GatewayImageRoutabilityCode =
  | "ready"
  | "image_unavailable"
  | "contract_unknown"
  | "contract_mismatch";

export interface GatewayImageRoutability {
  ok: boolean;
  code: GatewayImageRoutabilityCode;
  message: string;
}

export interface GatewayImageRouteMetadata {
  serverName: "gateway";
  requiredArgument: "imageId";
  imageId: string;
  routeReference: {
    projectId: string;
    workspaceId: string;
    targetId: string;
  };
  imageIdSource: string;
  recordHint: string;
}

export interface GatewayImageRoute {
  id: string;
  imageName: string;
  port: number;
  pid?: number;
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
  targetId: string;
  projectRoot: string;
  statePath: string;
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
  image: GatewayProjectImageState,
): GatewayImageRoutability {
  if (image.status !== "running") {
    return {
      ok: false,
      code: "image_unavailable",
      message: `Image ${image.id} is not running; current status is ${image.status}`,
    };
  }

  return contractRoutability(
    projectContract,
    image.pharoMcpContract,
    image.id,
  );
}

function imageRouteMetadata(
  state: GatewayProjectState,
  imageId: string,
): GatewayImageRouteMetadata {
  return {
    serverName: "gateway",
    requiredArgument: "imageId",
    imageId,
    routeReference: {
      projectId: state.projectId,
      workspaceId: state.workspaceId,
      targetId: state.targetId,
    },
    imageIdSource:
      "Read images[].imageId from PLexus scoped context, pharo-launcher image list, or gateway status",
    recordHint:
      "Record the selected imageId with the scoped project/workspace/target before calling gateway tools",
  };
}

export class PlexusRoutingTable {
  private readonly targets = new Map<string, GatewayProjectRoute>();

  upsertProject(
    projectRoot: string,
    statePath: string,
    state: GatewayProjectState,
  ): GatewayProjectRoute {
    const existing = this.targets.get(state.targetId);
    const existingHealth = new Map(
      existing?.images.map((image) => [image.id, image.health]) ?? [],
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
      images: state.images.map((image) => ({
        id: image.id,
        imageName: image.imageName,
        port: image.assignedPort,
        ...(image.pid ? { pid: image.pid } : {}),
        status: image.status,
        health: existingHealth.get(image.id) ?? "unknown",
        routable: imageRoutability(state.pharoMcpContract, image),
        routeMetadata: imageRouteMetadata(state, image.id),
        ...(image.pharoMcpContract
          ? { pharoMcpContract: image.pharoMcpContract }
          : {}),
        updatedAt: state.updatedAt,
      })),
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

  findImageOutsideTarget(
    projectId: string,
    targetId: string,
    imageId: string,
  ): GatewayProjectRoute | undefined {
    return this.listProjectTargets(projectId).find(
      (route) =>
        route.targetId !== targetId &&
        route.images.some((image) => image.id === imageId),
    );
  }

  updateImageHealth(
    targetId: string,
    imageId: string,
    health: GatewayImageHealth,
  ): void {
    const project = this.targets.get(targetId);
    const image = project?.images.find((candidate) => candidate.id === imageId);
    if (image) {
      image.health = health;
      image.updatedAt = new Date().toISOString();
    }
  }
}
