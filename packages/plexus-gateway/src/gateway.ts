import path from "node:path";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  closeProject,
  HttpPharoMcpHealthClient,
  loadProjectConfig,
  loadProjectState,
  openProject,
  projectStatePathForConfig,
  sanitizeRuntimeId,
  type PharoMcpHealthClient,
  type ProjectCloseResult,
  type ProjectConfig,
  type ProjectOpenResult,
  type ProjectState,
} from "@plexus/core";
import {
  StreamableHttpImageMcpToolRouter,
  type ImageMcpToolRouter,
} from "./imageMcpRouter.js";
import {
  buildPharoFacadeTools,
  parsePharoFacadeArguments,
} from "./pharoFacade.js";
import {
  PlexusRoutingTable,
  type GatewayImageRoute,
  type GatewayProjectRoute,
} from "./routingTable.js";

export interface PlexusGatewayOptions {
  routingTable?: PlexusRoutingTable;
  imageRouter?: ImageMcpToolRouter;
  healthClient?: PharoMcpHealthClient;
  projectOpen?: typeof openProject;
  projectClose?: typeof closeProject;
  pharoTools?: readonly Tool[];
  pharoScope?: ProjectReferenceInput;
}

export interface ProjectReferenceInput {
  projectPath?: string;
  projectId?: string;
  workspaceId?: string;
  targetId?: string;
  stateRoot?: string;
}

export interface ProjectOpenToolInput {
  projectPath: string;
  stateRoot?: string;
  workspaceId?: string;
  targetId?: string;
}

export interface ProjectCloseToolInput {
  projectPath: string;
  stateRoot?: string;
  workspaceId?: string;
}

export interface ProjectStatusToolInput extends ProjectReferenceInput {
  refreshHealth?: boolean;
}

export interface RouteToImageToolInput extends ProjectReferenceInput {
  imageId: string;
  toolName: string;
  arguments?: Record<string, unknown>;
}

export interface GatewayToolResult<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}

export interface RouteToImageResult {
  route: {
    projectId: string;
    workspaceId: string;
    targetId: string;
    imageId: string;
    imageName: string;
    port: number;
  };
  result: unknown;
}

export interface RoutedImageToolCall {
  route: RouteToImageResult["route"];
  result: unknown;
}

class GatewayInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GatewayInputError";
  }
}

function requireString(
  input: Record<string, unknown>,
  key: string,
): string {
  const value = input[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new GatewayInputError(`${key} is required`);
  }

  return value;
}

function optionalString(
  input: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = input[key];
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string" || value.length === 0) {
    throw new GatewayInputError(`${key} must be a non-empty string`);
  }

  return value;
}

function optionalBoolean(input: Record<string, unknown>, key: string): boolean {
  const value = input[key];
  if (value === undefined) {
    return false;
  }

  if (typeof value !== "boolean") {
    throw new GatewayInputError(`${key} must be a boolean`);
  }

  return value;
}

function optionalObject(
  input: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const value = input[key];
  if (value === undefined) {
    return {};
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new GatewayInputError(`${key} must be an object`);
  }

  return value as Record<string, unknown>;
}

function objectInput(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return {};
  }

  return input as Record<string, unknown>;
}

function projectReferenceFromPath(
  projectPath: string,
  stateRoot: string | undefined,
  workspaceId: string | undefined,
): {
  projectRoot: string;
  config: ProjectConfig;
  statePath: string;
  state?: ProjectState;
} {
  const projectRoot = path.resolve(projectPath);
  const config = loadProjectConfig(projectRoot);
  const statePath = projectStatePathForConfig({
    projectRoot,
    config,
    workspaceId,
    stateRoot,
  });

  return {
    projectRoot,
    config,
    statePath,
    state: loadProjectState(statePath),
  };
}

function assertProjectRoute(
  route: GatewayProjectRoute | undefined,
  identity: string,
): GatewayProjectRoute {
  if (!route) {
    throw new GatewayInputError(`No route is registered for: ${identity}`);
  }

  return route;
}

function assertImageRoute(
  project: GatewayProjectRoute,
  imageId: string,
): GatewayImageRoute {
  const image = project.images.find((candidate) => candidate.id === imageId);
  if (!image) {
    throw new GatewayInputError(
      `No route is registered for image ${imageId} in project ${project.projectId}`,
    );
  }

  return image;
}

function result<T>(data: T): GatewayToolResult<T> {
  return { ok: true, data };
}

function failure<T = unknown>(error: unknown): GatewayToolResult<T> {
  return {
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  };
}

export class PlexusGateway {
  private readonly routingTable: PlexusRoutingTable;
  private readonly imageRouter: ImageMcpToolRouter;
  private readonly healthClient: PharoMcpHealthClient;
  private readonly projectOpen: typeof openProject;
  private readonly projectClose: typeof closeProject;
  private readonly pharoTools: Tool[];
  private readonly pharoToolNames: Set<string>;
  private readonly pharoScope: ProjectReferenceInput;

  constructor(options: PlexusGatewayOptions = {}) {
    this.routingTable = options.routingTable ?? new PlexusRoutingTable();
    this.imageRouter =
      options.imageRouter ?? new StreamableHttpImageMcpToolRouter();
    this.healthClient =
      options.healthClient ?? new HttpPharoMcpHealthClient();
    this.projectOpen = options.projectOpen ?? openProject;
    this.projectClose = options.projectClose ?? closeProject;
    this.pharoTools = buildPharoFacadeTools(options.pharoTools ?? []);
    this.pharoToolNames = new Set(this.pharoTools.map((tool) => tool.name));
    this.pharoScope = options.pharoScope ?? {};
  }

  listPharoTools(): Tool[] {
    return this.pharoTools.map((tool) => ({ ...tool }));
  }

  isPharoTool(name: string): boolean {
    return this.pharoToolNames.has(name);
  }

  async open(input: ProjectOpenToolInput): Promise<GatewayToolResult<ProjectOpenResult>> {
    try {
      const openResult = await this.projectOpen({
        projectRoot: input.projectPath,
        stateRoot: input.stateRoot,
        workspaceId: input.workspaceId,
        targetId: input.targetId,
      });

      this.routingTable.upsertProject(
        openResult.projectRoot,
        openResult.statePath,
        openResult.state,
      );

      return result(openResult);
    } catch (error) {
      return failure(error);
    }
  }

  async close(
    input: ProjectCloseToolInput,
  ): Promise<GatewayToolResult<ProjectCloseResult>> {
    try {
      const closeResult = await this.projectClose({
        projectRoot: input.projectPath,
        stateRoot: input.stateRoot,
        workspaceId: input.workspaceId,
      });

      if (closeResult.state) {
        this.routingTable.upsertProject(
          closeResult.projectRoot,
          closeResult.statePath,
          closeResult.state,
        );
      }

      return result(closeResult);
    } catch (error) {
      return failure(error);
    }
  }

  async status(
    input: ProjectStatusToolInput,
  ): Promise<GatewayToolResult<GatewayProjectRoute | GatewayProjectRoute[]>> {
    try {
      const routes = await this.resolveProjectRoutes(input);

      if (input.refreshHealth) {
        for (const route of routes) {
          await this.refreshProjectHealth(route);
        }
      }

      return result(routes.length === 1 ? routes[0] : routes);
    } catch (error) {
      return failure(error);
    }
  }

  async routeToImage(
    input: RouteToImageToolInput,
  ): Promise<GatewayToolResult<RouteToImageResult>> {
    try {
      return result(
        await this.callRoutedImageTool(
          input,
          input.imageId,
          input.toolName,
          input.arguments ?? {},
        ),
      );
    } catch (error) {
      return failure(error);
    }
  }

  async callPharoTool(
    toolName: string,
    inputValue: unknown,
  ): Promise<GatewayToolResult<unknown>> {
    try {
      if (!this.isPharoTool(toolName)) {
        throw new GatewayInputError(`Unknown Pharo tool: ${toolName}`);
      }

      const parsed = parsePharoFacadeArguments(inputValue);
      const routed = await this.callRoutedImageTool(
        this.pharoScope,
        parsed.imageId,
        toolName,
        parsed.argumentsValue,
      );

      return result(routed.result);
    } catch (error) {
      return failure(error);
    }
  }

  async handleTool(
    name: string,
    inputValue: unknown,
  ): Promise<GatewayToolResult> {
    try {
      const input = objectInput(inputValue);

      switch (name) {
        case "plexus_project_open":
          return this.open({
            projectPath: requireString(input, "projectPath"),
            stateRoot: optionalString(input, "stateRoot"),
            workspaceId: optionalString(input, "workspaceId"),
            targetId: optionalString(input, "targetId"),
          });

        case "plexus_project_close":
          return this.close({
            projectPath: requireString(input, "projectPath"),
            stateRoot: optionalString(input, "stateRoot"),
            workspaceId: optionalString(input, "workspaceId"),
          });

        case "plexus_project_status":
          return this.status({
            projectPath: optionalString(input, "projectPath"),
            projectId: optionalString(input, "projectId"),
            workspaceId: optionalString(input, "workspaceId"),
            targetId: optionalString(input, "targetId"),
            stateRoot: optionalString(input, "stateRoot"),
            refreshHealth: optionalBoolean(input, "refreshHealth"),
          });

        case "plexus_route_to_image":
          return this.routeToImage({
            projectPath: optionalString(input, "projectPath"),
            projectId: optionalString(input, "projectId"),
            workspaceId: optionalString(input, "workspaceId"),
            targetId: optionalString(input, "targetId"),
            stateRoot: optionalString(input, "stateRoot"),
            imageId: requireString(input, "imageId"),
            toolName: requireString(input, "toolName"),
            arguments: optionalObject(input, "arguments"),
          });

        default:
          return {
            ok: false,
            error: `Unknown tool: ${name}`,
          };
      }
    } catch (error) {
      return failure(error);
    }
  }

  private async resolveProjectRoutes(
    input: ProjectReferenceInput,
  ): Promise<GatewayProjectRoute[]> {
    if (input.projectPath) {
      const reference = projectReferenceFromPath(
        input.projectPath,
        input.stateRoot,
        input.workspaceId,
      );
      if (!reference.state) {
        return [];
      }

      return [
        this.routingTable.upsertProject(
          reference.projectRoot,
          reference.statePath,
          reference.state,
        ),
      ];
    }

    if (input.targetId) {
      return [
        assertProjectRoute(
          this.routingTable.getTarget(input.targetId),
          input.targetId,
        ),
      ];
    }

    if (input.projectId && input.workspaceId) {
      const workspaceId = sanitizeRuntimeId(input.workspaceId);
      return [
        assertProjectRoute(
          this.routingTable.getProjectWorkspace(input.projectId, workspaceId),
          `${input.projectId}/${workspaceId}`,
        ),
      ];
    }

    if (input.projectId) {
      return this.routingTable.listProjectTargets(input.projectId);
    }

    return this.routingTable.listTargets();
  }

  private async resolveSingleProjectRoute(
    input: ProjectReferenceInput,
  ): Promise<GatewayProjectRoute> {
    const routes = await this.resolveProjectRoutes(input);

    if (routes.length === 0) {
      throw new GatewayInputError(
        "projectPath, targetId, or projectId with workspaceId is required",
      );
    }

    if (routes.length > 1) {
      throw new GatewayInputError(
        "Multiple routes match; provide targetId or workspaceId",
      );
    }

    return routes[0];
  }

  private async callRoutedImageTool(
    projectReference: ProjectReferenceInput,
    imageId: string,
    toolName: string,
    argumentsValue: Record<string, unknown>,
  ): Promise<RoutedImageToolCall> {
    const project = await this.resolveSingleProjectRoute(projectReference);

    const image = this.resolveImageRoute(project, imageId);
    if (!image.routable.ok) {
      throw new GatewayInputError(image.routable.message);
    }

    const route = {
      projectId: project.projectId,
      workspaceId: project.workspaceId,
      targetId: project.targetId,
      imageId: image.id,
      imageName: image.imageName,
      port: image.port,
    };

    const toolResult = await this.imageRouter.callTool(
      route,
      toolName,
      argumentsValue,
    );

    return {
      route,
      result: toolResult,
    };
  }

  private resolveImageRoute(
    project: GatewayProjectRoute,
    imageId: string,
  ): GatewayImageRoute {
    const image = project.images.find((candidate) => candidate.id === imageId);
    if (image) {
      return image;
    }

    const otherWorkspace = this.routingTable.findImageOutsideTarget(
      project.projectId,
      project.targetId,
      imageId,
    );
    if (otherWorkspace) {
      throw new GatewayInputError(
        `Image ${imageId} is registered outside workspace ${project.workspaceId}; requested target ${project.targetId}, found target ${otherWorkspace.targetId}`,
      );
    }

    return assertImageRoute(project, imageId);
  }

  private async refreshProjectHealth(route: GatewayProjectRoute): Promise<void> {
    for (const image of route.images) {
      if (image.status !== "running") {
        this.routingTable.updateImageHealth(route.targetId, image.id, "unknown");
        continue;
      }

      const healthy = await this.healthClient.check(image.port);
      this.routingTable.updateImageHealth(
        route.targetId,
        image.id,
        healthy ? "healthy" : "unhealthy",
      );
    }
  }
}
