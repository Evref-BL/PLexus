import type {
  PharoMcpContractReference,
  ProjectImagePharoMcpContractState,
  ProjectImageState,
  ProjectState,
} from "@plexus/core";

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

export interface GatewayImageRoute {
  id: string;
  imageName: string;
  port: number;
  pid?: number;
  status: ProjectImageState["status"];
  health: GatewayImageHealth;
  routable: GatewayImageRoutability;
  pharoMcpContract?: ProjectImagePharoMcpContractState;
  updatedAt: string;
}

export interface GatewayProjectRoute {
  projectId: string;
  projectName: string;
  workspaceId: string;
  targetId: string;
  projectRoot: string;
  statePath: string;
  pharoMcpContract?: PharoMcpContractReference;
  images: GatewayImageRoute[];
  updatedAt: string;
}

function contractLabel(contract: PharoMcpContractReference | undefined): string {
  if (!contract) {
    return "none";
  }

  return contract.hash ?? contract.id ?? "unknown";
}

function requiredProjectContractFields(
  contract: PharoMcpContractReference | undefined,
): Array<keyof PharoMcpContractReference> {
  if (!contract) {
    return [];
  }

  return (["id", "hash"] as const).filter((key) => contract[key] !== undefined);
}

function contractRoutability(
  projectContract: PharoMcpContractReference | undefined,
  imageContract: ProjectImagePharoMcpContractState | undefined,
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
  projectContract: PharoMcpContractReference | undefined,
  image: ProjectImageState,
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

export class PlexusRoutingTable {
  private readonly targets = new Map<string, GatewayProjectRoute>();

  upsertProject(
    projectRoot: string,
    statePath: string,
    state: ProjectState,
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
      projectRoot,
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
