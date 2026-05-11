import path from "node:path";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  closeProject,
  HttpPharoMcpHealthClient,
  rescueImage,
  loadProjectConfig,
  loadProjectState,
  openProject,
  projectStatePathForConfig,
  sanitizeRuntimeId,
  type ImageRescueEntrySelection,
  type ImageRescueOperation,
  type ImageRescueRepositoryAction,
  type ImageRescueResult,
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
  imageRescue?: typeof rescueImage;
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

export interface GatewayUnregisterTargetResult {
  removed: boolean;
  route?: GatewayProjectRoute;
}

export interface RouteToImageToolInput extends ProjectReferenceInput {
  imageId: string;
  toolName: string;
  arguments?: Record<string, unknown>;
}

export interface RescueImageToolInput extends ProjectReferenceInput {
  operation: ImageRescueOperation;
  sourceImageId: string;
  targetImageId?: string;
  targetImageName?: string;
  targetTemplateName?: string;
  targetTemplateCategory?: string;
  targetMcpPort?: number;
  sourceHistoryDirectoryPath?: string;
  historyFilePath?: string;
  selection?: ImageRescueEntrySelection;
  exclude?: ImageRescueEntrySelection;
  codeChangesOnly?: boolean;
  includeEntryCounts?: boolean;
  loadRepositories?: boolean;
  repositoryActions?: ImageRescueRepositoryAction[];
  confirm?: boolean;
}

export interface RouteToImageRoute {
  projectId: string;
  workspaceId: string;
  targetId: string;
  imageId: string;
  imageName: string;
  port: number;
}

export interface GatewayToolResult<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
  route?: RouteToImageRoute;
}

export interface RouteToImageResult {
  route: RouteToImageRoute;
  result: unknown;
}

export interface RoutedImageToolCall {
  route: RouteToImageRoute;
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

function optionalNumber(
  input: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = input[key];
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new GatewayInputError(`${key} must be an integer`);
  }

  return value;
}

function numberArray(
  value: unknown,
  key: string,
): number[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value) || !value.every(Number.isInteger)) {
    throw new GatewayInputError(`${key} must be an array of integers`);
  }

  return value;
}

function stringArray(
  value: unknown,
  key: string,
): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (
    !Array.isArray(value) ||
    !value.every((item) => typeof item === "string" && item.length > 0)
  ) {
    throw new GatewayInputError(`${key} must be an array of non-empty strings`);
  }

  return value;
}

function optionalEntrySelection(
  input: Record<string, unknown>,
  key: string,
): ImageRescueEntrySelection | undefined {
  const value = input[key];
  if (value === undefined) {
    return undefined;
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new GatewayInputError(`${key} must be an object`);
  }

  const object = value as Record<string, unknown>;
  return {
    indexes: numberArray(object.indexes, `${key}.indexes`),
    entryReferences: stringArray(
      object.entryReferences,
      `${key}.entryReferences`,
    ),
    startIndex: optionalNumber(object, "startIndex"),
    endIndex: optionalNumber(object, "endIndex"),
    latestCount: optionalNumber(object, "latestCount"),
  };
}

function optionalRepositoryActions(
  input: Record<string, unknown>,
  key: string,
): ImageRescueRepositoryAction[] | undefined {
  const value = input[key];
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value)) {
    throw new GatewayInputError(`${key} must be an array`);
  }

  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new GatewayInputError(`${key}[${index}] must be an object`);
    }

    const object = item as Record<string, unknown>;
    const toolName = object.toolName;
    if (
      toolName !== undefined &&
      toolName !== "load_repository" &&
      toolName !== "edit_repository"
    ) {
      throw new GatewayInputError(
        `${key}[${index}].toolName must be load_repository or edit_repository`,
      );
    }

    return {
      label: optionalString(object, "label"),
      toolName: toolName as ImageRescueRepositoryAction["toolName"],
      arguments: optionalObject(object, "arguments"),
    };
  });
}

function requireRescueOperation(
  input: Record<string, unknown>,
): ImageRescueOperation {
  const value = input.operation;
  if (
    value === "snapshotSource" ||
    value === "plan" ||
    value === "prepareTarget" ||
    value === "applyPlan"
  ) {
    return value;
  }

  throw new GatewayInputError(
    "operation must be snapshotSource, plan, prepareTarget, or applyPlan",
  );
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
  private readonly imageRescue: typeof rescueImage;
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
    this.imageRescue = options.imageRescue ?? rescueImage;
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
        this.routingTable.removeTarget(closeResult.state.targetId);
      } else {
        this.routingTable.removeProjectRootRoutes(
          closeResult.projectRoot,
          input.workspaceId ? sanitizeRuntimeId(input.workspaceId) : undefined,
        );
      }

      return result(closeResult);
    } catch (error) {
      return failure(error);
    }
  }

  async unregisterTarget(
    input: ProjectReferenceInput,
  ): Promise<GatewayToolResult<GatewayUnregisterTargetResult>> {
    try {
      const route = this.findRegisteredRoute(input);
      const removed = route
        ? this.routingTable.removeTarget(route.targetId)
        : undefined;

      return result({
        removed: Boolean(removed),
        ...(removed ? { route: removed } : {}),
      });
    } catch (error) {
      return failure(error);
    }
  }

  async status(
    input: ProjectStatusToolInput,
  ): Promise<GatewayToolResult<GatewayProjectRoute | GatewayProjectRoute[]>> {
    try {
      if (!input.projectPath && !input.projectId && !input.targetId) {
        this.routingTable.removeRoutesWithMissingStatePaths();
      }

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
  ): Promise<GatewayToolResult<unknown>> {
    try {
      const routed = await this.callRoutedImageTool(
        input,
        input.imageId,
        input.toolName,
        input.arguments ?? {},
      );

      return {
        ok: true,
        data: routed.result,
        route: routed.route,
      };
    } catch (error) {
      return failure(error);
    }
  }

  async rescueImage(
    input: RescueImageToolInput,
  ): Promise<GatewayToolResult<ImageRescueResult>> {
    try {
      if (!input.projectPath) {
        throw new GatewayInputError("projectPath is required for image rescue");
      }

      const rescueResult = await this.imageRescue({
        ...input,
        projectRoot: input.projectPath,
        imageMcpClient: {
          callTool: async (image, toolName, argumentsValue) => {
            const routed = await this.callRoutedImageTool(
              input,
              image.id,
              toolName,
              argumentsValue,
            );
            return routed.result;
          },
        },
        healthClient: this.healthClient,
      });

      if (rescueResult.state) {
        this.routingTable.upsertProject(
          rescueResult.projectRoot,
          rescueResult.statePath,
          rescueResult.state,
        );
      }

      return result(rescueResult);
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

        case "plexus_gateway_unregister_target":
          return this.unregisterTarget({
            projectPath: optionalString(input, "projectPath"),
            projectId: optionalString(input, "projectId"),
            workspaceId: optionalString(input, "workspaceId"),
            targetId: optionalString(input, "targetId"),
            stateRoot: optionalString(input, "stateRoot"),
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

        case "plexus_rescue_image":
          return this.rescueImage({
            projectPath: requireString(input, "projectPath"),
            projectId: optionalString(input, "projectId"),
            workspaceId: optionalString(input, "workspaceId"),
            targetId: optionalString(input, "targetId"),
            stateRoot: optionalString(input, "stateRoot"),
            operation: requireRescueOperation(input),
            sourceImageId: requireString(input, "sourceImageId"),
            targetImageId: optionalString(input, "targetImageId"),
            targetImageName: optionalString(input, "targetImageName"),
            targetTemplateName: optionalString(input, "targetTemplateName"),
            targetTemplateCategory: optionalString(input, "targetTemplateCategory"),
            targetMcpPort: optionalNumber(input, "targetMcpPort"),
            sourceHistoryDirectoryPath: optionalString(
              input,
              "sourceHistoryDirectoryPath",
            ),
            historyFilePath: optionalString(input, "historyFilePath"),
            selection: optionalEntrySelection(input, "selection"),
            exclude: optionalEntrySelection(input, "exclude"),
            codeChangesOnly: optionalBoolean(input, "codeChangesOnly"),
            includeEntryCounts: optionalBoolean(input, "includeEntryCounts"),
            loadRepositories: optionalBoolean(input, "loadRepositories"),
            repositoryActions: optionalRepositoryActions(
              input,
              "repositoryActions",
            ),
            confirm: optionalBoolean(input, "confirm"),
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

  private findRegisteredRoute(
    input: ProjectReferenceInput,
  ): GatewayProjectRoute | undefined {
    if (input.targetId) {
      return this.routingTable.getTarget(input.targetId);
    }

    if (input.projectId && input.workspaceId) {
      return this.routingTable.getProjectWorkspace(
        input.projectId,
        sanitizeRuntimeId(input.workspaceId),
      );
    }

    if (input.projectPath) {
      const reference = projectReferenceFromPath(
        input.projectPath,
        input.stateRoot,
        input.workspaceId,
      );

      if (reference.state) {
        return this.routingTable.getTarget(reference.state.targetId);
      }

      return this.routingTable.findProjectRootRoutes(
        reference.projectRoot,
        input.workspaceId ? sanitizeRuntimeId(input.workspaceId) : undefined,
      )[0];
    }

    throw new GatewayInputError(
      "targetId, projectId with workspaceId, or projectPath is required",
    );
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
