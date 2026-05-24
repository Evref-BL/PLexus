import crypto from "node:crypto";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  StreamableHttpImageMcpToolRouter,
  type ImageMcpConnectionInfo,
  type ImageMcpToolRouter,
} from "./imageMcpRouter.js";
import {
  buildPharoFacadeTools,
  parsePharoFacadeArguments,
} from "./pharoFacade.js";
import {
  PlexusRoutingTable,
  type GatewayImageMcpEndpoint,
  type GatewayImageRoute,
  type GatewayProjectRoute,
  type GatewayProjectState,
} from "./routingTable.js";

export interface GatewayImageHealthClient {
  check(port: number): Promise<boolean>;
}

export interface HttpGatewayImageHealthClientOptions {
  host?: string;
  paths?: string[];
  mcpPath?: string;
  probeMethods?: string[];
  timeoutMs?: number;
}

export class HttpGatewayImageHealthClient implements GatewayImageHealthClient {
  private readonly host: string;
  private readonly paths: string[];
  private readonly mcpPath: string;
  private readonly probeMethods: string[];
  private readonly timeoutMs: number;

  constructor(options: HttpGatewayImageHealthClientOptions = {}) {
    this.host = options.host ?? "127.0.0.1";
    this.paths = options.paths ?? ["/health"];
    this.mcpPath = options.mcpPath ?? "/";
    this.probeMethods = options.probeMethods ?? ["ping"];
    this.timeoutMs = options.timeoutMs ?? 1_000;
  }

  async check(port: number): Promise<boolean> {
    for (const method of this.probeMethods) {
      try {
        const response = await this.fetchWithTimeout(
          `http://${this.host}:${port}${this.mcpPath}`,
          {
            method: "POST",
            headers: {
              accept: "application/json, text/event-stream",
              "content-type": "application/json",
            },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: "plexus-gateway-health-check",
              method,
            }),
          },
        );

        if (await this.isJsonRpcResponse(response)) {
          return true;
        }
      } catch {
        // Route health is best-effort and should not hide route status.
      }
    }

    for (const pathname of this.paths) {
      try {
        const response = await this.fetchWithTimeout(
          `http://${this.host}:${port}${pathname}`,
        );
        if (response.ok) {
          return true;
        }
      } catch {
        // Route health is best-effort and should not hide route status.
      }
    }

    return false;
  }

  private async fetchWithTimeout(
    input: string,
    init: Record<string, unknown> = {},
  ): Promise<{ ok: boolean; json(): Promise<unknown> }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(input, {
        ...init,
        signal: controller.signal,
      });
      return response as { ok: boolean; json(): Promise<unknown> };
    } finally {
      clearTimeout(timeout);
    }
  }

  private async isJsonRpcResponse(
    response: { json(): Promise<unknown> },
  ): Promise<boolean> {
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      return false;
    }

    if (!isObject(payload)) {
      return false;
    }

    return (
      payload.jsonrpc === "2.0" &&
      ("result" in payload || "error" in payload)
    );
  }
}

export interface PlexusGatewayOptions {
  routingTable?: PlexusRoutingTable;
  imageRouter?: ImageMcpToolRouter;
  healthClient?: GatewayImageHealthClient;
  pharoTools?: readonly Tool[];
  pharoScope?: GatewayRouteReferenceInput;
}

export interface GatewayRouteReferenceInput {
  projectId?: string;
  workspaceId?: string;
  targetId?: string;
}

export interface GatewayRegisterTargetInput {
  projectRoot: string;
  statePath: string;
  state: GatewayProjectState;
}

export interface GatewayStatusToolInput extends GatewayRouteReferenceInput {
  refreshHealth?: boolean;
  refreshTools?: boolean;
}

export interface GatewayUnregisterTargetResult {
  removed: boolean;
  route?: GatewayProjectRoute;
}

export interface GatewayCleanupStaleRoutesResult {
  removed: GatewayProjectRoute[];
}

export interface RouteToImageToolInput extends GatewayRouteReferenceInput {
  imageId: string;
  toolName: string;
  arguments?: Record<string, unknown>;
}

export interface RouteToImageRoute {
  projectId: string;
  workspaceId: string;
  targetId: string;
  imageId: string;
  imageName: string;
  port?: number;
  mcpEndpoint?: GatewayImageMcpEndpoint;
}

export interface GatewayToolResult<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
  route?: RouteToImageRoute;
}

export type GatewayPharoToolSchemaState =
  | "unknown"
  | "matching"
  | "mismatched"
  | "unavailable";

export interface GatewayPharoToolSchemaSource {
  targetId: string;
  imageId: string;
  fingerprint?: string;
  toolCount?: number;
  lifecycle?: ImageMcpConnectionInfo["lifecycle"];
  protocolVersion?: string;
  capabilities?: Record<string, unknown>;
  serverInfo?: ImageMcpConnectionInfo["serverInfo"];
  error?: string;
}

export interface GatewayPharoToolSchemaStatus {
  state: GatewayPharoToolSchemaState;
  refreshedAt?: string;
  fingerprint?: string;
  sourceCount: number;
  sources: GatewayPharoToolSchemaSource[];
  error?: string;
}

export type GatewayProjectRouteWithSchema = GatewayProjectRoute & {
  pharoToolSchema?: GatewayPharoToolSchemaStatus;
};

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

class GatewayPharoSchemaMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GatewayPharoSchemaMismatchError";
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
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

  if (!isObject(value)) {
    throw new GatewayInputError(`${key} must be an object`);
  }

  return value;
}

function objectInput(input: unknown): Record<string, unknown> {
  if (!isObject(input)) {
    return {};
  }

  return input;
}

function endpointInput(
  image: Record<string, unknown>,
  index: number,
): GatewayImageMcpEndpoint | undefined {
  const value = image.mcpEndpoint;
  if (value === undefined) {
    return undefined;
  }

  if (!isObject(value)) {
    throw new GatewayInputError(
      `state.images[${index}].mcpEndpoint must be an object`,
    );
  }

  if (value.transport !== "http") {
    throw new GatewayInputError(
      `state.images[${index}].mcpEndpoint.transport must be http`,
    );
  }

  if (typeof value.host !== "string" || value.host.length === 0) {
    throw new GatewayInputError(
      `state.images[${index}].mcpEndpoint.host must be a non-empty string`,
    );
  }

  if (typeof value.port !== "number" || !Number.isInteger(value.port)) {
    throw new GatewayInputError(
      `state.images[${index}].mcpEndpoint.port must be an integer`,
    );
  }

  if (typeof value.path !== "string" || value.path.length === 0) {
    throw new GatewayInputError(
      `state.images[${index}].mcpEndpoint.path must be a non-empty string`,
    );
  }

  return {
    transport: "http",
    host: value.host,
    port: value.port,
    path: value.path,
  };
}

function stateInput(input: Record<string, unknown>): GatewayProjectState {
  const value = input.state;
  if (!isObject(value)) {
    throw new GatewayInputError("state is required");
  }

  const images = value.images;
  if (!Array.isArray(images)) {
    throw new GatewayInputError("state.images must be an array");
  }

  return {
    projectId: requireString(value, "projectId"),
    projectName: requireString(value, "projectName"),
    workspaceId: requireString(value, "workspaceId"),
    targetId: requireString(value, "targetId"),
    updatedAt: requireString(value, "updatedAt"),
    ...(isObject(value.pharoMcpContract)
      ? { pharoMcpContract: value.pharoMcpContract }
      : {}),
    images: images.map((image, index) => {
      if (!isObject(image)) {
        throw new GatewayInputError(`state.images[${index}] must be an object`);
      }

      const assignedPort = image.assignedPort;
      const mcpEndpoint = endpointInput(image, index);
      const pharoMcpContract = isObject(image.pharoMcpContract)
        ? image.pharoMcpContract
        : undefined;
      const unsupportedPharoMcp =
        pharoMcpContract?.status === "unsupported";
      const pid = image.pid;
      if (
        assignedPort !== undefined &&
        (typeof assignedPort !== "number" || !Number.isInteger(assignedPort))
      ) {
        throw new GatewayInputError(
          `state.images[${index}].assignedPort must be an integer`,
        );
      }
      if (assignedPort === undefined && !mcpEndpoint && !unsupportedPharoMcp) {
        throw new GatewayInputError(
          `state.images[${index}] must include assignedPort or mcpEndpoint`,
        );
      }
      if (pid !== undefined && (typeof pid !== "number" || !Number.isInteger(pid))) {
        throw new GatewayInputError(
          `state.images[${index}].pid must be an integer`,
        );
      }

      const status = requireString(image, "status");
      if (
        status !== "starting" &&
        status !== "running" &&
        status !== "stopped" &&
        status !== "failed"
      ) {
        throw new GatewayInputError(
          `state.images[${index}].status must be starting, running, stopped, or failed`,
        );
      }

      return {
        id: requireString(image, "id"),
        imageName: requireString(image, "imageName"),
        ...(assignedPort !== undefined ? { assignedPort } : {}),
        ...(mcpEndpoint ? { mcpEndpoint } : {}),
        ...(pid ? { pid } : {}),
        status,
        ...(pharoMcpContract ? { pharoMcpContract } : {}),
      };
    }),
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

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }

  if (isObject(value)) {
    const entries = Object.entries(value).sort(([left], [right]) =>
      left.localeCompare(right),
    );
    return `{${entries
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
}

function toolSchemaFingerprint(tools: readonly Tool[]): string {
  const canonicalTools = [...tools].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  const hash = crypto
    .createHash("sha256")
    .update(canonicalJson(canonicalTools))
    .digest("hex");
  return `sha256:${hash}`;
}

function schemaSourceConnectionFields(
  connectionInfo: ImageMcpConnectionInfo | undefined,
): Pick<
  GatewayPharoToolSchemaSource,
  "lifecycle" | "protocolVersion" | "capabilities" | "serverInfo"
> {
  if (!connectionInfo) {
    return {};
  }

  return {
    lifecycle: connectionInfo.lifecycle,
    ...(connectionInfo.protocolVersion
      ? { protocolVersion: connectionInfo.protocolVersion }
      : {}),
    ...(connectionInfo.capabilities
      ? { capabilities: connectionInfo.capabilities }
      : {}),
    ...(connectionInfo.serverInfo ? { serverInfo: connectionInfo.serverInfo } : {}),
  };
}

export class PlexusGateway {
  private readonly routingTable: PlexusRoutingTable;
  private readonly imageRouter: ImageMcpToolRouter;
  private readonly healthClient: GatewayImageHealthClient;
  private pharoTools: Tool[];
  private pharoToolNames: Set<string>;
  private readonly pharoScope: GatewayRouteReferenceInput;
  private pharoToolSchemaStatus: GatewayPharoToolSchemaStatus = {
    state: "unknown",
    sourceCount: 0,
    sources: [],
  };

  constructor(options: PlexusGatewayOptions = {}) {
    this.routingTable = options.routingTable ?? new PlexusRoutingTable();
    this.imageRouter =
      options.imageRouter ?? new StreamableHttpImageMcpToolRouter();
    this.healthClient =
      options.healthClient ?? new HttpGatewayImageHealthClient();
    this.pharoTools = [];
    this.pharoToolNames = new Set();
    this.pharoScope = options.pharoScope ?? {};
    this.setPharoTools(options.pharoTools ?? []);
  }

  listPharoTools(): Tool[] {
    return this.pharoTools.map((tool) => ({ ...tool }));
  }

  async refreshPharoTools(): Promise<Tool[]> {
    let tools: Tool[] | undefined;
    try {
      tools = await this.refreshPharoToolsForScope(this.pharoScope, {
        throwOnMismatch: true,
      });
    } catch (error) {
      if (error instanceof GatewayPharoSchemaMismatchError) {
        throw error;
      }

      if (this.pharoTools.length === 0) {
        throw error;
      }

      return this.listPharoTools();
    }

    if (tools !== undefined) {
      this.setPharoTools(tools);
    }

    return this.listPharoTools();
  }

  isPharoTool(name: string): boolean {
    return this.pharoToolNames.has(name);
  }

  async registerTarget(
    input: GatewayRegisterTargetInput,
  ): Promise<GatewayToolResult<GatewayProjectRoute>> {
    try {
      return result(
        this.routingTable.upsertProject(
          input.projectRoot,
          input.statePath,
          input.state,
        ),
      );
    } catch (error) {
      return failure(error);
    }
  }

  async registerProjectRoute(
    input: GatewayRegisterTargetInput,
  ): Promise<GatewayToolResult<GatewayProjectRoute>> {
    return this.registerTarget(input);
  }

  async unregisterTarget(
    input: GatewayRouteReferenceInput,
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

  async unregisterProjectRoute(
    input: GatewayRouteReferenceInput,
  ): Promise<GatewayToolResult<GatewayUnregisterTargetResult>> {
    return this.unregisterTarget(input);
  }

  async status(
    input: GatewayStatusToolInput,
  ): Promise<
    GatewayToolResult<
      GatewayProjectRouteWithSchema | GatewayProjectRouteWithSchema[]
    >
  > {
    try {
      if (input.refreshTools) {
        await this.refreshPharoToolsForScope(input, {
          throwOnMismatch: false,
        });
      }

      const routes = await this.resolveProjectRoutes(input);

      if (input.refreshHealth) {
        for (const route of routes) {
          await this.refreshProjectHealth(route);
        }
      }

      const routesWithSchema = routes.map((route) =>
        this.routeWithPharoToolSchema(route),
      );
      return result(
        routesWithSchema.length === 1 ? routesWithSchema[0] : routesWithSchema,
      );
    } catch (error) {
      return failure(error);
    }
  }

  async getRouteStatus(
    input: GatewayStatusToolInput,
  ): Promise<GatewayToolResult<GatewayProjectRoute | GatewayProjectRoute[]>> {
    return this.status(input);
  }

  async cleanupStaleRoutes(): Promise<
    GatewayToolResult<GatewayCleanupStaleRoutesResult>
  > {
    try {
      return result({
        removed: this.routingTable.removeRoutesWithMissingStatePaths(),
      });
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

  async callImageTool(
    reference: GatewayRouteReferenceInput,
    imageId: string,
    toolName: string,
    argumentsValue: Record<string, unknown>,
  ): Promise<unknown> {
    const routed = await this.routeToImage({
      ...reference,
      imageId,
      toolName,
      arguments: argumentsValue,
    });
    if (!routed.ok) {
      throw new GatewayInputError(routed.error ?? "Image route failed");
    }

    return routed.data;
  }

  async callPharoTool(
    toolName: string,
    inputValue: unknown,
  ): Promise<GatewayToolResult<unknown>> {
    try {
      if (!this.isPharoTool(toolName)) {
        throw new GatewayInputError(`Unknown Pharo tool: ${toolName}`);
      }

      if (this.pharoToolSchemaStatus.state === "mismatched") {
        throw new GatewayInputError(
          "Pharo gateway tool schemas differ across routable images; refresh or reload images before routed Pharo calls",
        );
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
        case "plexus_gateway_register_target":
          return this.registerTarget({
            projectRoot: requireString(input, "projectRoot"),
            statePath: requireString(input, "statePath"),
            state: stateInput(input),
          });

        case "plexus_gateway_unregister_target":
          return this.unregisterTarget({
            projectId: optionalString(input, "projectId"),
            workspaceId: optionalString(input, "workspaceId"),
            targetId: optionalString(input, "targetId"),
          });

        case "plexus_gateway_status":
          return this.status({
            projectId: optionalString(input, "projectId"),
            workspaceId: optionalString(input, "workspaceId"),
            targetId: optionalString(input, "targetId"),
            refreshTools: optionalBoolean(input, "refreshTools"),
            refreshHealth: optionalBoolean(input, "refreshHealth"),
          });

        case "plexus_gateway_cleanup_stale_routes":
          return this.cleanupStaleRoutes();

        case "plexus_route_to_image":
          return this.routeToImage({
            projectId: optionalString(input, "projectId"),
            workspaceId: optionalString(input, "workspaceId"),
            targetId: optionalString(input, "targetId"),
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

  private findRegisteredRoute(
    input: GatewayRouteReferenceInput,
  ): GatewayProjectRoute | undefined {
    if (input.targetId) {
      return this.routingTable.getTarget(input.targetId);
    }

    if (input.projectId && input.workspaceId) {
      return this.routingTable.getProjectWorkspace(
        input.projectId,
        input.workspaceId,
      );
    }

    throw new GatewayInputError(
      "targetId or projectId with workspaceId is required",
    );
  }

  private async resolveProjectRoutes(
    input: GatewayRouteReferenceInput,
  ): Promise<GatewayProjectRoute[]> {
    if (input.targetId) {
      return [
        assertProjectRoute(
          this.routingTable.getTarget(input.targetId),
          input.targetId,
        ),
      ];
    }

    if (input.projectId && input.workspaceId) {
      return [
        assertProjectRoute(
          this.routingTable.getProjectWorkspace(
            input.projectId,
            input.workspaceId,
          ),
          `${input.projectId}/${input.workspaceId}`,
        ),
      ];
    }

    if (input.projectId) {
      return this.routingTable.listProjectTargets(input.projectId);
    }

    return this.routingTable.listTargets();
  }

  private async resolveSingleProjectRoute(
    input: GatewayRouteReferenceInput,
  ): Promise<GatewayProjectRoute> {
    const routes = await this.resolveProjectRoutes(input);

    if (routes.length === 0) {
      throw new GatewayInputError(
        "targetId or projectId with workspaceId is required",
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
    projectReference: GatewayRouteReferenceInput,
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
      ...(image.port !== undefined ? { port: image.port } : {}),
      ...(image.mcpEndpoint ? { mcpEndpoint: image.mcpEndpoint } : {}),
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

  private setPharoTools(tools: readonly Tool[]): void {
    this.pharoTools = buildPharoFacadeTools(tools);
    this.pharoToolNames = new Set(this.pharoTools.map((tool) => tool.name));
  }

  private routeWithPharoToolSchema(
    route: GatewayProjectRoute,
  ): GatewayProjectRouteWithSchema {
    return {
      ...route,
      pharoToolSchema: this.pharoToolSchemaStatus,
    };
  }

  private imageRouteReference(
    project: GatewayProjectRoute,
    image: GatewayImageRoute,
  ): RouteToImageRoute {
    return {
      projectId: project.projectId,
      workspaceId: project.workspaceId,
      targetId: project.targetId,
      imageId: image.id,
      imageName: image.imageName,
      ...(image.port !== undefined ? { port: image.port } : {}),
      ...(image.mcpEndpoint ? { mcpEndpoint: image.mcpEndpoint } : {}),
    };
  }

  private async refreshPharoToolsForScope(
    scope: GatewayRouteReferenceInput,
    options: { throwOnMismatch: boolean },
  ): Promise<Tool[] | undefined> {
    if (!this.imageRouter.listTools) {
      return undefined;
    }

    let routes: GatewayProjectRoute[];
    try {
      routes = await this.resolveProjectRoutes(scope);
    } catch {
      return undefined;
    }

    const errors: string[] = [];
    const successes: Array<{
      source: GatewayPharoToolSchemaSource;
      tools: Tool[];
    }> = [];
    let attempted = false;
    for (const project of routes) {
      for (const image of project.images) {
        if (!image.routable.ok) {
          continue;
        }

        attempted = true;
        const route = this.imageRouteReference(project, image);

        try {
          const tools = await this.imageRouter.listTools(route);
          const connectionInfo = this.imageRouter.connectionInfo?.(route);
          if (tools.length > 0) {
            successes.push({
              source: {
                targetId: project.targetId,
                imageId: image.id,
                fingerprint: toolSchemaFingerprint(tools),
                toolCount: tools.length,
                ...schemaSourceConnectionFields(connectionInfo),
              },
              tools,
            });
            continue;
          }
          const error = "MCP tools/list returned no tools";
          errors.push(`${project.targetId}/${image.id}: ${error}`);
          successes.push({
            source: {
              targetId: project.targetId,
              imageId: image.id,
              ...schemaSourceConnectionFields(connectionInfo),
              error,
            },
            tools: [],
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const connectionInfo = this.imageRouter.connectionInfo?.(route);
          errors.push(`${project.targetId}/${image.id}: ${message}`);
          successes.push({
            source: {
              targetId: project.targetId,
              imageId: image.id,
              ...schemaSourceConnectionFields(connectionInfo),
              error: message,
            },
            tools: [],
          });
        }
      }
    }

    const refreshedAt = new Date().toISOString();
    const sources = successes.map((success) => success.source);
    const validSources = successes.filter(
      (success) => success.source.fingerprint !== undefined,
    );

    if (validSources.length > 0) {
      if (errors.length > 0) {
        const error = `Unable to refresh Pharo tool schemas from all registered image routes: ${errors.join("; ")}`;
        this.pharoToolSchemaStatus = {
          state: "unavailable",
          refreshedAt,
          sourceCount: sources.length,
          sources,
          error,
        };

        if (options.throwOnMismatch) {
          throw new GatewayPharoSchemaMismatchError(error);
        }

        return undefined;
      }

      const fingerprints = [
        ...new Set(validSources.map((success) => success.source.fingerprint!)),
      ];
      if (fingerprints.length > 1) {
        const error =
          "Pharo gateway tool schemas differ across routable images";
        this.pharoToolSchemaStatus = {
          state: "mismatched",
          refreshedAt,
          sourceCount: sources.length,
          sources,
          error,
        };

        if (options.throwOnMismatch) {
          throw new GatewayPharoSchemaMismatchError(error);
        }

        return undefined;
      }

      this.pharoToolSchemaStatus = {
        state: "matching",
        refreshedAt,
        fingerprint: fingerprints[0],
        sourceCount: sources.length,
        sources,
        ...(errors.length > 0 ? { error: errors.join("; ") } : {}),
      };
      this.setPharoTools(validSources[0].tools);
      return this.listPharoTools();
    }

    if (attempted) {
      this.pharoToolSchemaStatus = {
        state: "unavailable",
        refreshedAt,
        sourceCount: sources.length,
        sources,
        error: errors.join("; "),
      };
      throw new GatewayInputError(
        `Unable to refresh Pharo tool schemas from registered image routes: ${errors.join("; ")}`,
      );
    }

    return undefined;
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

      if (image.port === undefined) {
        this.routingTable.updateImageHealth(
          route.targetId,
          image.id,
          image.routable.code === "unsupported" ? "unknown" : "unhealthy",
        );
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
