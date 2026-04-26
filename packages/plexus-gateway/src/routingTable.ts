import type { ProjectImageState, ProjectState } from "@plexus/core";

export type GatewayImageHealth = "unknown" | "healthy" | "unhealthy";

export interface GatewayImageRoute {
  id: string;
  imageName: string;
  port: number;
  pid?: number;
  status: ProjectImageState["status"];
  health: GatewayImageHealth;
  updatedAt: string;
}

export interface GatewayProjectRoute {
  projectId: string;
  projectName: string;
  workspaceId: string;
  targetId: string;
  projectRoot: string;
  statePath: string;
  images: GatewayImageRoute[];
  updatedAt: string;
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
      updatedAt: state.updatedAt,
      images: state.images.map((image) => ({
        id: image.id,
        imageName: image.imageName,
        port: image.assignedPort,
        ...(image.pid ? { pid: image.pid } : {}),
        status: image.status,
        health: existingHealth.get(image.id) ?? "unknown",
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
