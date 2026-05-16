import path from "node:path";
import {
  rescueImage,
  type ImageRescueEntrySelection,
  type ImageRescueOperation,
  type ImageRescueOptions,
  type ImageRescueRepositoryAction,
  type ImageRescueResult,
} from "./imageRescue.js";
import { loadProjectConfig } from "./projectConfig.js";
import { closeProject, type ProjectCloseResult } from "./projectClose.js";
import { openProject, type ProjectOpenResult } from "./projectOpen.js";
import {
  defaultWorkspaceId,
  loadProjectState,
  projectStatePathForConfig,
  sanitizeRuntimeId,
  type ProjectState,
} from "./projectState.js";

export interface ProjectLifecycleRouteReference {
  projectId?: string;
  workspaceId?: string;
  targetId?: string;
}

export interface ProjectLifecycleRouteRegistration {
  projectRoot: string;
  statePath: string;
  state: ProjectState;
}

export interface ProjectLifecycleRouteRegistry {
  registerProjectRoute(
    input: ProjectLifecycleRouteRegistration,
  ): Promise<unknown> | unknown;
  unregisterProjectRoute(
    input: ProjectLifecycleRouteReference,
  ): Promise<unknown> | unknown;
  getRouteStatus?(
    input: ProjectLifecycleRouteReference & { refreshHealth?: boolean },
  ): Promise<unknown> | unknown;
}

export interface ProjectLifecycleImageToolCaller {
  callImageTool(
    reference: ProjectLifecycleRouteReference,
    imageId: string,
    toolName: string,
    argumentsValue: Record<string, unknown>,
  ): Promise<unknown>;
}

export interface HttpGatewayRouteRegistryOptions {
  url?: string;
  host?: string;
  port?: number;
  path?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export interface ProjectLifecycleOptions {
  routeRegistry?: ProjectLifecycleRouteRegistry;
  imageToolCaller?: ProjectLifecycleImageToolCaller;
  projectOpen?: typeof openProject;
  projectClose?: typeof closeProject;
  imageRescue?: typeof rescueImage;
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

export interface ProjectStatusToolInput extends ProjectLifecycleRouteReference {
  projectPath?: string;
  stateRoot?: string;
  refreshHealth?: boolean;
}

export interface RescueImageToolInput extends ProjectStatusToolInput {
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

export interface ProjectLifecycleStatus {
  projectRoot?: string;
  statePath?: string;
  state?: ProjectState;
  route?: unknown;
}

export interface ProjectLifecycleToolResult<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}

class ProjectLifecycleInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectLifecycleInputError";
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
    throw new ProjectLifecycleInputError(`${key} is required`);
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
    throw new ProjectLifecycleInputError(`${key} must be a non-empty string`);
  }

  return value;
}

function optionalBoolean(input: Record<string, unknown>, key: string): boolean {
  const value = input[key];
  if (value === undefined) {
    return false;
  }

  if (typeof value !== "boolean") {
    throw new ProjectLifecycleInputError(`${key} must be a boolean`);
  }

  return value;
}

function optionalBooleanValue(
  input: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const value = input[key];
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "boolean") {
    throw new ProjectLifecycleInputError(`${key} must be a boolean`);
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
    throw new ProjectLifecycleInputError(`${key} must be an integer`);
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
    throw new ProjectLifecycleInputError(`${key} must be an object`);
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
    throw new ProjectLifecycleInputError(`${key} must be an array of integers`);
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
    throw new ProjectLifecycleInputError(
      `${key} must be an array of non-empty strings`,
    );
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

  if (!isObject(value)) {
    throw new ProjectLifecycleInputError(`${key} must be an object`);
  }

  return {
    indexes: numberArray(value.indexes, `${key}.indexes`),
    entryReferences: stringArray(
      value.entryReferences,
      `${key}.entryReferences`,
    ),
    startIndex: optionalNumber(value, "startIndex"),
    endIndex: optionalNumber(value, "endIndex"),
    latestCount: optionalNumber(value, "latestCount"),
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
    throw new ProjectLifecycleInputError(`${key} must be an array`);
  }

  return value.map((item, index) => {
    if (!isObject(item)) {
      throw new ProjectLifecycleInputError(`${key}[${index}] must be an object`);
    }

    const toolName = item.toolName;
    if (
      toolName !== undefined &&
      toolName !== "load_repository" &&
      toolName !== "edit_repository"
    ) {
      throw new ProjectLifecycleInputError(
        `${key}[${index}].toolName must be load_repository or edit_repository`,
      );
    }

    return {
      label: optionalString(item, "label"),
      toolName: toolName as ImageRescueRepositoryAction["toolName"],
      arguments: optionalObject(item, "arguments"),
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

  throw new ProjectLifecycleInputError(
    "operation must be snapshotSource, plan, prepareTarget, or applyPlan",
  );
}

function objectInput(input: unknown): Record<string, unknown> {
  if (!isObject(input)) {
    return {};
  }

  return input;
}

function result<T>(data: T): ProjectLifecycleToolResult<T> {
  return { ok: true, data };
}

function failure<T = unknown>(error: unknown): ProjectLifecycleToolResult<T> {
  return {
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  };
}

function unwrapToolLikeResult(value: unknown): unknown {
  if (isObject(value) && typeof value.ok === "boolean") {
    if (value.ok === false) {
      throw new Error(
        typeof value.error === "string" ? value.error : "Tool call failed",
      );
    }

    return value.data;
  }

  return value;
}

function textContent(value: unknown): string | undefined {
  if (!isObject(value) || !Array.isArray(value.content)) {
    return undefined;
  }

  const item = value.content.find(
    (candidate): candidate is { type: "text"; text: string } =>
      isObject(candidate) &&
      candidate.type === "text" &&
      typeof candidate.text === "string",
  );
  return item?.text;
}

function decodeMcpToolResult(value: unknown): unknown {
  const text = textContent(value);
  if (text === undefined) {
    return value;
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return value;
  }
}

function lifecycleReferenceFromInput(
  input: ProjectStatusToolInput,
): ProjectLifecycleRouteReference {
  return {
    projectId: input.projectId,
    workspaceId: input.workspaceId,
    targetId: input.targetId,
  };
}

function lifecycleStatusFromRoute(route: unknown): ProjectLifecycleStatus {
  if (!isObject(route)) {
    return { route };
  }

  const statePath =
    typeof route.statePath === "string" ? route.statePath : undefined;
  return {
    projectRoot:
      typeof route.projectRoot === "string" ? route.projectRoot : undefined,
    statePath,
    state: statePath ? loadProjectState(statePath) : undefined,
    route,
  };
}

export class HttpGatewayRouteRegistry implements ProjectLifecycleRouteRegistry {
  private readonly url: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;

  constructor(options: HttpGatewayRouteRegistryOptions = {}) {
    const host = options.host ?? "127.0.0.1";
    const port = options.port ?? 7331;
    const mcpPath = options.path ?? "/mcp";
    this.url = options.url ?? `http://${host}:${port}${mcpPath}`;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.fetchFn = options.fetch ?? fetch;
  }

  registerProjectRoute(
    input: ProjectLifecycleRouteRegistration,
  ): Promise<unknown> {
    return this.callTool("plexus_gateway_register_target", input);
  }

  unregisterProjectRoute(input: ProjectLifecycleRouteReference): Promise<unknown> {
    return this.callTool("plexus_gateway_unregister_target", input);
  }

  getRouteStatus(
    input: ProjectLifecycleRouteReference & { refreshHealth?: boolean },
  ): Promise<unknown> {
    return this.callTool("plexus_gateway_status", input);
  }

  private async callTool(
    name: string,
    argumentsValue: unknown,
  ): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchFn(this.url, {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: `plexus-core-${Date.now()}`,
          method: "tools/call",
          params: {
            name,
            arguments: argumentsValue,
          },
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`Gateway MCP request failed with HTTP ${response.status}`);
      }

      const payload = (await response.json()) as unknown;
      if (!isObject(payload)) {
        throw new Error("Gateway MCP response was not a JSON object");
      }
      if ("error" in payload) {
        throw new Error(JSON.stringify(payload.error));
      }

      return unwrapToolLikeResult(
        decodeMcpToolResult((payload as { result?: unknown }).result),
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}

export class PlexusProjectLifecycle {
  private readonly routeRegistry?: ProjectLifecycleRouteRegistry;
  private readonly imageToolCaller?: ProjectLifecycleImageToolCaller;
  private readonly projectOpen: typeof openProject;
  private readonly projectClose: typeof closeProject;
  private readonly imageRescue: typeof rescueImage;

  constructor(options: ProjectLifecycleOptions = {}) {
    this.routeRegistry = options.routeRegistry;
    this.imageToolCaller = options.imageToolCaller;
    this.projectOpen = options.projectOpen ?? openProject;
    this.projectClose = options.projectClose ?? closeProject;
    this.imageRescue = options.imageRescue ?? rescueImage;
  }

  async open(
    input: ProjectOpenToolInput,
  ): Promise<ProjectLifecycleToolResult<ProjectOpenResult>> {
    try {
      const openResult = await this.projectOpen({
        projectRoot: input.projectPath,
        stateRoot: input.stateRoot,
        workspaceId: input.workspaceId,
        targetId: input.targetId,
      });

      await this.registerRoute({
        projectRoot: openResult.projectRoot,
        statePath: openResult.statePath,
        state: openResult.state,
      });

      return result(openResult);
    } catch (error) {
      return failure(error);
    }
  }

  async close(
    input: ProjectCloseToolInput,
  ): Promise<ProjectLifecycleToolResult<ProjectCloseResult>> {
    try {
      const closeResult = await this.projectClose({
        projectRoot: input.projectPath,
        stateRoot: input.stateRoot,
        workspaceId: input.workspaceId,
      });

      if (closeResult.state) {
        await this.unregisterRoute({ targetId: closeResult.state.targetId });
      } else {
        const projectRoot = path.resolve(input.projectPath);
        const config = loadProjectConfig(projectRoot);
        const workspaceId = input.workspaceId
          ? sanitizeRuntimeId(input.workspaceId)
          : defaultWorkspaceId(projectRoot);
        await this.unregisterRoute({
          projectId: config.kanban.projectId,
          workspaceId,
        });
      }

      return result(closeResult);
    } catch (error) {
      return failure(error);
    }
  }

  async status(
    input: ProjectStatusToolInput,
  ): Promise<
    ProjectLifecycleToolResult<ProjectLifecycleStatus | ProjectLifecycleStatus[]>
  > {
    try {
      if (input.projectPath) {
        return result(
          await this.statusFromProjectPath({
            ...input,
            projectPath: input.projectPath,
          }),
        );
      }

      if (!this.routeRegistry?.getRouteStatus) {
        throw new ProjectLifecycleInputError(
          "projectPath is required when no gateway route registry is configured",
        );
      }

      const routeStatus = unwrapToolLikeResult(
        await this.routeRegistry.getRouteStatus({
          ...lifecycleReferenceFromInput(input),
          refreshHealth: input.refreshHealth,
        }),
      );
      const routes = Array.isArray(routeStatus) ? routeStatus : [routeStatus];
      const statuses = routes.map(lifecycleStatusFromRoute);

      return result(Array.isArray(routeStatus) ? statuses : statuses[0]);
    } catch (error) {
      return failure(error);
    }
  }

  async rescueImage(
    input: RescueImageToolInput,
  ): Promise<ProjectLifecycleToolResult<ImageRescueResult>> {
    try {
      const imageToolCaller = this.imageToolCaller;
      const options: ImageRescueOptions = {
        ...input,
        projectRoot: input.projectPath ?? "",
        imageMcpClient: imageToolCaller
          ? {
              callTool: async (image, toolName, argumentsValue) =>
                imageToolCaller.callImageTool(
                  lifecycleReferenceFromInput(input),
                  image.id,
                  toolName,
                  argumentsValue,
                ),
            }
          : undefined,
      };
      if (!options.projectRoot) {
        throw new ProjectLifecycleInputError(
          "projectPath is required for image rescue",
        );
      }

      const rescueResult = await this.imageRescue(options);
      if (rescueResult.state) {
        await this.registerRoute({
          projectRoot: rescueResult.projectRoot,
          statePath: rescueResult.statePath,
          state: rescueResult.state,
        });
      }

      return result(rescueResult);
    } catch (error) {
      return failure(error);
    }
  }

  async handleTool(
    name: string,
    inputValue: unknown,
  ): Promise<ProjectLifecycleToolResult> {
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
            codeChangesOnly: optionalBooleanValue(input, "codeChangesOnly"),
            includeEntryCounts: optionalBooleanValue(
              input,
              "includeEntryCounts",
            ),
            loadRepositories: optionalBooleanValue(input, "loadRepositories"),
            repositoryActions: optionalRepositoryActions(
              input,
              "repositoryActions",
            ),
            confirm: optionalBooleanValue(input, "confirm"),
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

  private async statusFromProjectPath(
    input: ProjectStatusToolInput & { projectPath: string },
  ): Promise<ProjectLifecycleStatus> {
    const projectRoot = path.resolve(input.projectPath);
    const config = loadProjectConfig(projectRoot);
    const workspaceId = input.workspaceId
      ? sanitizeRuntimeId(input.workspaceId)
      : defaultWorkspaceId(projectRoot);
    const statePath = projectStatePathForConfig({
      projectRoot,
      config,
      workspaceId,
      stateRoot: input.stateRoot,
    });
    const state = loadProjectState(statePath);
    const route = state
      ? await this.getRouteStatus({
          targetId: state.targetId,
          refreshHealth: input.refreshHealth,
        })
      : undefined;

    return {
      projectRoot,
      statePath,
      state,
      ...(route ? { route } : {}),
    };
  }

  private async getRouteStatus(
    input: ProjectLifecycleRouteReference & { refreshHealth?: boolean },
  ): Promise<unknown> {
    if (!this.routeRegistry?.getRouteStatus) {
      return undefined;
    }

    return unwrapToolLikeResult(await this.routeRegistry.getRouteStatus(input));
  }

  private async registerRoute(
    input: ProjectLifecycleRouteRegistration,
  ): Promise<void> {
    if (!this.routeRegistry) {
      return;
    }

    unwrapToolLikeResult(await this.routeRegistry.registerProjectRoute(input));
  }

  private async unregisterRoute(
    input: ProjectLifecycleRouteReference,
  ): Promise<void> {
    if (!this.routeRegistry) {
      return;
    }

    unwrapToolLikeResult(await this.routeRegistry.unregisterProjectRoute(input));
  }
}

export function createProjectLifecycleFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): PlexusProjectLifecycle {
  const routeRegistry =
    env.PLEXUS_GATEWAY_MCP_URL || env.PLEXUS_GATEWAY_PORT
      ? new HttpGatewayRouteRegistry({
          url: env.PLEXUS_GATEWAY_MCP_URL,
          host: env.PLEXUS_GATEWAY_HOST,
          port: env.PLEXUS_GATEWAY_PORT
            ? Number(env.PLEXUS_GATEWAY_PORT)
            : undefined,
        })
      : undefined;

  return new PlexusProjectLifecycle({ routeRegistry });
}
