import path from "node:path";
import {
  defaultImagePortClaimChecks,
  imagePortClaimsRootForConfig,
} from "./imagePortClaims.js";
import {
  loadProjectConfig,
  resolveProjectRuntimePolicy,
  type ProjectConfig,
  type ProjectImagePortCoordinationMode,
} from "./projectConfig.js";
import { closeProject, type ProjectCloseResult } from "./projectClose.js";
import {
  rescueImage,
  type ImageRescueEntrySelection,
  type ImageRescueOperation,
  type ImageRescueOptions,
  type ImageRescueRepositoryAction,
  type ImageRescueResult,
} from "./imageRescue.js";
import {
  closeProjectGateway,
  ensureProjectGateway,
  projectGatewayStatus,
  type ProjectGatewayRuntimeOptions,
} from "./projectGateway.js";
import {
  inspectPortClaim,
  listPortClaims,
  type PortClaimChecks,
  type PortClaimInspection,
  type PortClaimRecord,
} from "./portClaims.js";
import { openProject, type ProjectOpenResult } from "./projectOpen.js";
import {
  defaultPlexusStateRoot,
  defaultTargetId,
  defaultWorkspaceId,
  loadProjectState,
  projectStateRootForConfig,
  projectStatePathForConfig,
  runtimeStatusForImages,
  sanitizeRuntimeId,
  saveProjectState,
  type ProjectImageState,
  type ProjectGatewayState,
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

const defaultGatewayRouteControlMcpPath = "/control-mcp";

export interface ProjectLifecycleOptions {
  routeRegistry?: ProjectLifecycleRouteRegistry;
  imageToolCaller?: ProjectLifecycleImageToolCaller;
  projectOpen?: typeof openProject;
  projectClose?: typeof closeProject;
  imageRescue?: typeof rescueImage;
  gateway?: ProjectGatewayRuntimeOptions & {
    routeRegistryTimeoutMs?: number;
  };
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
  stateRoot?: string;
  statePath?: string;
  projectId?: string;
  workspaceId?: string;
  targetId?: string;
  state?: ProjectState;
  gateway?: ProjectGatewayState;
  route?: unknown;
  diagnostics?: ProjectLifecycleDiagnostics;
}

export type ProjectLifecycleRuntimeDiagnosticStatus =
  | "operational"
  | "operational-but-idle"
  | "degraded"
  | "not-opened";

export interface ProjectLifecyclePortClaimDiagnostic {
  claimsRoot: string;
  port: number;
  status: "claimed" | "stale" | "unreadable";
  record?: PortClaimRecord;
  reason?: string;
  ownedByCurrentScope?: boolean;
}

export interface ProjectLifecyclePortClaimsDiagnostics {
  roots: string[];
  active: ProjectLifecyclePortClaimDiagnostic[];
  stale: ProjectLifecyclePortClaimDiagnostic[];
  conflicts: ProjectLifecyclePortClaimDiagnostic[];
}

export type ProjectLifecycleImagePortCoordinationBasis =
  | "host-local-claims"
  | "project-state-scanning";

export interface ProjectLifecycleImagePortCoordinationDiagnostics {
  mode: ProjectImagePortCoordinationMode;
  basis: ProjectLifecycleImagePortCoordinationBasis;
  message: string;
  claimsRoot?: string;
  stateRoot?: string;
}

export interface ProjectLifecyclePortListenerDiagnostic {
  port: number;
  purpose: "gateway" | "image-mcp";
  imageId?: string;
  expectedOwner: string;
  message: string;
}

export interface ProjectLifecycleRouteTableDiagnostics {
  targetId?: string;
  status: "registered" | "missing" | "unavailable" | "not-configured";
  routableImages: Array<{
    imageId: string;
    port: number;
    status?: string;
    routable?: unknown;
  }>;
  error?: string;
}

export interface ProjectLifecycleDiagnostics {
  runtime: {
    status: ProjectLifecycleRuntimeDiagnosticStatus;
    reason: string;
  };
  scope: {
    projectRoot: string;
    stateRoot: string;
    statePath: string;
    projectId: string;
    workspaceId: string;
    targetId: string;
  };
  gateway: {
    mode: ProjectGatewayState["mode"];
    endpoint?: string;
    controlEndpoint?: string;
    host?: string;
    port?: number;
    portRange?: ProjectGatewayState["portRange"];
    managedByProject: boolean;
    pid?: number;
  };
  imageMcpPorts: Array<{
    imageId: string;
    imageName: string;
    port: number;
    status: ProjectImageState["status"];
    pid?: number;
  }>;
  imagePortCoordination: ProjectLifecycleImagePortCoordinationDiagnostics;
  portClaims: ProjectLifecyclePortClaimsDiagnostics;
  conflictingListeners: ProjectLifecyclePortListenerDiagnostic[];
  staleClaims: ProjectLifecyclePortClaimDiagnostic[];
  routeTable: ProjectLifecycleRouteTableDiagnostics;
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
  const state = statePath ? loadProjectState(statePath) : undefined;
  return {
    projectRoot:
      typeof route.projectRoot === "string" ? route.projectRoot : undefined,
    statePath,
    state,
    ...(state?.gateway ? { gateway: state.gateway } : {}),
    route,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function mergePortClaimChecks(
  options: ProjectGatewayRuntimeOptions,
): PortClaimChecks {
  const defaults = defaultImagePortClaimChecks();
  return {
    isProcessAlive: options.checks?.isProcessAlive ?? defaults.isProcessAlive,
    isPortListening: options.checks?.isPortListening ?? defaults.isPortListening,
  };
}

function currentScopeMatchesClaim(
  claim: PortClaimRecord,
  scope: {
    projectId: string;
    workspaceId: string;
    targetId: string;
  },
): boolean {
  return (
    claim.projectId === scope.projectId &&
    claim.workspaceId === scope.workspaceId &&
    claim.targetId === scope.targetId
  );
}

function portClaimDiagnostic(
  claimsRoot: string,
  inspection: Extract<
    PortClaimInspection,
    { status: "claimed" | "stale" | "unreadable" }
  >,
  scope: {
    projectId: string;
    workspaceId: string;
    targetId: string;
  },
): ProjectLifecyclePortClaimDiagnostic {
  if (inspection.status === "unreadable") {
    return {
      claimsRoot,
      port: inspection.port,
      status: "unreadable",
      reason: inspection.reason,
    };
  }

  return {
    claimsRoot,
    port: inspection.port,
    status: inspection.status,
    record: inspection.record,
    ...(inspection.reason ? { reason: inspection.reason } : {}),
    ownedByCurrentScope: currentScopeMatchesClaim(inspection.record, scope),
  };
}

async function inspectClaimRoots(
  claimsRoots: string[],
  checks: PortClaimChecks,
  scope: {
    projectId: string;
    workspaceId: string;
    targetId: string;
  },
): Promise<ProjectLifecyclePortClaimsDiagnostics> {
  const active: ProjectLifecyclePortClaimDiagnostic[] = [];
  const stale: ProjectLifecyclePortClaimDiagnostic[] = [];
  const conflicts: ProjectLifecyclePortClaimDiagnostic[] = [];

  for (const claimsRoot of claimsRoots) {
    const claims = await listPortClaims({ claimsRoot });
    for (const claim of claims) {
      const inspection = await inspectPortClaim({
        claimsRoot,
        port: claim.assignedPort,
        checks,
      });
      if (inspection.status === "available") {
        continue;
      }

      const diagnostic = portClaimDiagnostic(claimsRoot, inspection, scope);
      if (diagnostic.status === "stale") {
        stale.push(diagnostic);
        continue;
      }

      if (!diagnostic.ownedByCurrentScope) {
        conflicts.push(diagnostic);
        continue;
      }

      active.push(diagnostic);
    }
  }

  return {
    roots: claimsRoots,
    active,
    stale,
    conflicts,
  };
}

function configuredClaimRoots(
  projectRoot: string,
  config: ProjectConfig,
  state: ProjectState | undefined,
): string[] {
  return [
    imagePortClaimsRootForConfig(projectRoot, config),
    state?.gateway?.claim?.claimsRoot,
  ].filter((value, index, values): value is string =>
    typeof value === "string" && values.indexOf(value) === index,
  );
}

function imagePortCoordinationDiagnostics(
  projectRoot: string,
  stateRoot: string,
  config: ProjectConfig,
): ProjectLifecycleImagePortCoordinationDiagnostics {
  const coordination = resolveProjectRuntimePolicy(config).imagePorts.coordination;
  if (coordination.mode === "host-local") {
    const claimsRoot = imagePortClaimsRootForConfig(projectRoot, config);
    return {
      mode: "host-local",
      basis: "host-local-claims",
      message:
        "Image MCP ports are coordinated by host-local port claims across PLexus projects on this host.",
      ...(claimsRoot ? { claimsRoot } : {}),
    };
  }

  return {
    mode: "project-state",
    basis: "project-state-scanning",
    stateRoot,
    message:
      "Image MCP ports are coordinated by scanning PLexus project state; this only protects workspaces sharing this state root.",
  };
}

function imageMcpPorts(
  state: ProjectState | undefined,
): ProjectLifecycleDiagnostics["imageMcpPorts"] {
  return (state?.images ?? []).map((image) => ({
    imageId: image.id,
    imageName: image.imageName,
    port: image.assignedPort,
    status: image.status,
    ...(image.pid !== undefined ? { pid: image.pid } : {}),
  }));
}

function routeTableDiagnostics(
  targetId: string | undefined,
  route: unknown,
  routeError: unknown,
): ProjectLifecycleRouteTableDiagnostics {
  if (!targetId) {
    return {
      status: "not-configured",
      routableImages: [],
    };
  }

  if (routeError) {
    const message = errorMessage(routeError);
    return {
      targetId,
      status: message.includes("No route is registered")
        ? "missing"
        : "unavailable",
      routableImages: [],
      error: message,
    };
  }

  if (!isObject(route)) {
    return {
      targetId,
      status: "not-configured",
      routableImages: [],
    };
  }

  const images = Array.isArray(route.images) ? route.images : [];
  return {
    targetId,
    status: "registered",
    routableImages: images
      .filter(isObject)
      .map((image) => ({
        imageId: typeof image.id === "string" ? image.id : "",
        port: typeof image.port === "number" ? image.port : 0,
        ...(typeof image.status === "string" ? { status: image.status } : {}),
        ...("routable" in image ? { routable: image.routable } : {}),
      })),
  };
}

function gatewayDiagnostic(
  gateway: ProjectGatewayState,
): ProjectLifecycleDiagnostics["gateway"] {
  return {
    mode: gateway.mode,
    endpoint: gateway.endpoint,
    controlEndpoint: gateway.controlEndpoint,
    host: gateway.host,
    port: gateway.port,
    portRange: gateway.portRange,
    managedByProject: gateway.managedByProject,
    pid: gateway.pid,
  };
}

function expectedPortClaims(
  portClaims: ProjectLifecyclePortClaimsDiagnostics,
): Set<number> {
  return new Set(portClaims.active.map((claim) => claim.port));
}

async function conflictingListenerDiagnostics(
  state: ProjectState | undefined,
  gateway: ProjectGatewayState,
  portClaims: ProjectLifecyclePortClaimsDiagnostics,
  checks: PortClaimChecks,
): Promise<ProjectLifecyclePortListenerDiagnostic[]> {
  const ownedClaimPorts = expectedPortClaims(portClaims);
  const diagnostics: ProjectLifecyclePortListenerDiagnostic[] = [];

  for (const image of state?.images ?? []) {
    const listening = Boolean(await checks.isPortListening?.(image.assignedPort));
    if (
      listening &&
      image.status !== "running" &&
      !ownedClaimPorts.has(image.assignedPort)
    ) {
      diagnostics.push({
        port: image.assignedPort,
        purpose: "image-mcp",
        imageId: image.id,
        expectedOwner: `image ${image.id}`,
        message:
          `Image MCP port ${image.assignedPort} has a listener but the ` +
          `project image ${image.id} is ${image.status} and has no active owned claim.`,
      });
    }
  }

  if (gateway.port !== undefined) {
    const listening = Boolean(await checks.isPortListening?.(gateway.port));
    if (
      listening &&
      gateway.managedByProject &&
      !ownedClaimPorts.has(gateway.port)
    ) {
      diagnostics.push({
        port: gateway.port,
        purpose: "gateway",
        expectedOwner: "project-local gateway",
        message:
          `Gateway port ${gateway.port} has a listener but no active owned claim.`,
      });
    }
  }

  return diagnostics;
}

function runtimeDiagnostics(
  state: ProjectState | undefined,
  gateway: ProjectGatewayState,
  portClaims: ProjectLifecyclePortClaimsDiagnostics,
  conflictingListeners: ProjectLifecyclePortListenerDiagnostic[],
  routeTable: ProjectLifecycleRouteTableDiagnostics,
): ProjectLifecycleDiagnostics["runtime"] {
  if (!state) {
    return {
      status: "not-opened",
      reason: "No project runtime state exists for this workspace yet.",
    };
  }

  if (
    portClaims.stale.length > 0 ||
    portClaims.conflicts.length > 0 ||
    conflictingListeners.length > 0 ||
    routeTable.status === "missing" ||
    routeTable.status === "unavailable" ||
    !gateway.endpoint ||
    !gateway.controlEndpoint
  ) {
    return {
      status: "degraded",
      reason:
        "Runtime state exists, but diagnostics found stale claims, conflicts, route-table gaps, or incomplete gateway endpoints.",
    };
  }

  if (state.images.length === 0 && runtimeStatusForImages(state.images) === "idle") {
    return {
      status: "operational-but-idle",
      reason:
        "Runtime scope, gateway endpoints, and route table are valid; no images are declared for this project.",
    };
  }

  return {
    status: "operational",
    reason: "Runtime scope has valid gateway and route diagnostics.",
  };
}

export class HttpGatewayRouteRegistry implements ProjectLifecycleRouteRegistry {
  private readonly url: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;

  constructor(options: HttpGatewayRouteRegistryOptions = {}) {
    const host = options.host ?? "127.0.0.1";
    const port = options.port ?? 7331;
    const mcpPath = options.path ?? defaultGatewayRouteControlMcpPath;
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
  private readonly gateway: NonNullable<ProjectLifecycleOptions["gateway"]>;

  constructor(options: ProjectLifecycleOptions = {}) {
    this.routeRegistry = options.routeRegistry;
    this.imageToolCaller = options.imageToolCaller;
    this.projectOpen = options.projectOpen ?? openProject;
    this.projectClose = options.projectClose ?? closeProject;
    this.imageRescue = options.imageRescue ?? rescueImage;
    this.gateway = options.gateway ?? {};
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
      let routeRegistry = this.routeRegistry;
      let startedProjectGateway = false;

      if (!routeRegistry) {
        const config = loadProjectConfig(openResult.projectRoot);
        const gatewayResult = await ensureProjectGateway({
          ...this.gateway,
          projectRoot: openResult.projectRoot,
          config,
          state: openResult.state,
        });
        startedProjectGateway = gatewayResult.started;
        saveProjectState(openResult.statePath, openResult.state);
        routeRegistry = this.routeRegistryFromControlUrl(
          gatewayResult.routeControlUrl,
        );
      }

      try {
        await this.registerRoute({
          projectRoot: openResult.projectRoot,
          statePath: openResult.statePath,
          state: openResult.state,
        }, routeRegistry);
      } catch (error) {
        if (startedProjectGateway) {
          await closeProjectGateway({
            ...this.gateway,
            state: openResult.state,
          });
          saveProjectState(openResult.statePath, openResult.state);
        }

        throw error;
      }

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
      const projectRoot = path.resolve(input.projectPath);
      const config =
        !this.routeRegistry || !closeResult.state
          ? loadProjectConfig(projectRoot)
          : undefined;
      const routeRegistry =
        this.routeRegistry ??
        (config ? this.routeRegistryForProject(config, closeResult.state) : undefined);
      let unregisterError: unknown;

      try {
        if (closeResult.state) {
          await this.unregisterRoute(
            { targetId: closeResult.state.targetId },
            routeRegistry,
          );
        } else {
          const workspaceId = input.workspaceId
            ? sanitizeRuntimeId(input.workspaceId)
            : defaultWorkspaceId(projectRoot);
          await this.unregisterRoute(
            {
              projectId: config?.kanban.projectId,
              workspaceId,
            },
            routeRegistry,
          );
        }
      } catch (error) {
        unregisterError = error;
      } finally {
        if (closeResult.state?.gateway?.managedByProject) {
          await closeProjectGateway({
            ...this.gateway,
            state: closeResult.state,
          });
          closeResult.state.updatedAt = (
            this.gateway.now ?? (() => new Date())
          )().toISOString();
          saveProjectState(closeResult.statePath, closeResult.state);
        }
      }

      if (unregisterError) {
        throw unregisterError;
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
        const config = loadProjectConfig(rescueResult.projectRoot);
        await this.registerRoute(
          {
            projectRoot: rescueResult.projectRoot,
            statePath: rescueResult.statePath,
            state: rescueResult.state,
          },
          this.routeRegistryForProject(config, rescueResult.state),
        );
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
    const stateRoot =
      projectStateRootForConfig(config, input.stateRoot) ??
      defaultPlexusStateRoot(projectRoot);
    const statePath = projectStatePathForConfig({
      projectRoot,
      config,
      workspaceId,
      stateRoot: input.stateRoot,
    });
    const state = loadProjectState(statePath);
    const gateway = projectGatewayStatus(config, state);
    const routeRegistry = this.routeRegistryForProject(config, state);
    let route: unknown;
    let routeError: unknown;
    if (state) {
      try {
        route = await this.getRouteStatus(
          {
            targetId: state.targetId,
            refreshHealth: input.refreshHealth,
          },
          routeRegistry,
        );
      } catch (error) {
        routeError = error;
      }
    }
    const targetId =
      state?.targetId ??
      input.targetId ??
      defaultTargetId(config.kanban.projectId, workspaceId);
    const scope = {
      projectId: state?.projectId ?? config.kanban.projectId,
      workspaceId: state?.workspaceId ?? workspaceId,
      targetId,
    };
    const checks = mergePortClaimChecks(this.gateway);
    const portClaims = await inspectClaimRoots(
      configuredClaimRoots(projectRoot, config, state),
      checks,
      scope,
    );
    const routeTable = routeTableDiagnostics(state?.targetId, route, routeError);
    const conflictingListeners = await conflictingListenerDiagnostics(
      state,
      gateway,
      portClaims,
      checks,
    );
    const diagnostics: ProjectLifecycleDiagnostics = {
      runtime: runtimeDiagnostics(
        state,
        gateway,
        portClaims,
        conflictingListeners,
        routeTable,
      ),
      scope: {
        projectRoot,
        stateRoot,
        statePath,
        projectId: scope.projectId,
        workspaceId: scope.workspaceId,
        targetId: scope.targetId,
      },
      gateway: gatewayDiagnostic(gateway),
      imageMcpPorts: imageMcpPorts(state),
      imagePortCoordination: imagePortCoordinationDiagnostics(
        projectRoot,
        stateRoot,
        config,
      ),
      portClaims,
      conflictingListeners,
      staleClaims: portClaims.stale,
      routeTable,
    };

    return {
      projectRoot,
      stateRoot,
      statePath,
      projectId: scope.projectId,
      workspaceId: scope.workspaceId,
      targetId: scope.targetId,
      state,
      gateway,
      ...(route ? { route } : {}),
      diagnostics,
    };
  }

  private async getRouteStatus(
    input: ProjectLifecycleRouteReference & { refreshHealth?: boolean },
    routeRegistry = this.routeRegistry,
  ): Promise<unknown> {
    if (!routeRegistry?.getRouteStatus) {
      return undefined;
    }

    return unwrapToolLikeResult(await routeRegistry.getRouteStatus(input));
  }

  private async registerRoute(
    input: ProjectLifecycleRouteRegistration,
    routeRegistry = this.routeRegistry,
  ): Promise<void> {
    if (!routeRegistry) {
      return;
    }

    unwrapToolLikeResult(await routeRegistry.registerProjectRoute(input));
  }

  private async unregisterRoute(
    input: ProjectLifecycleRouteReference,
    routeRegistry = this.routeRegistry,
  ): Promise<void> {
    if (!routeRegistry) {
      return;
    }

    unwrapToolLikeResult(await routeRegistry.unregisterProjectRoute(input));
  }

  private routeRegistryFromControlUrl(url: string): ProjectLifecycleRouteRegistry {
    return new HttpGatewayRouteRegistry({
      url,
      timeoutMs: this.gateway.routeRegistryTimeoutMs,
      fetch: this.gateway.fetch,
    });
  }

  private routeRegistryForProject(
    config: ReturnType<typeof loadProjectConfig>,
    state?: ProjectState,
  ): ProjectLifecycleRouteRegistry | undefined {
    if (this.routeRegistry) {
      return this.routeRegistry;
    }

    const gateway = state?.gateway ?? projectGatewayStatus(config, state);
    return gateway.controlEndpoint
      ? this.routeRegistryFromControlUrl(gateway.controlEndpoint)
      : undefined;
  }
}

export function createProjectLifecycleFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): PlexusProjectLifecycle {
  const routeControlUrl = env.PLEXUS_GATEWAY_CONTROL_MCP_URL;
  const routeControlPath = env.PLEXUS_GATEWAY_CONTROL_MCP_PATH;
  const routeRegistry =
    routeControlUrl ||
    routeControlPath ||
    env.PLEXUS_GATEWAY_HOST ||
    env.PLEXUS_GATEWAY_PORT
      ? new HttpGatewayRouteRegistry({
          url: routeControlUrl,
          host: env.PLEXUS_GATEWAY_HOST,
          port: env.PLEXUS_GATEWAY_PORT
            ? Number(env.PLEXUS_GATEWAY_PORT)
            : undefined,
          path: routeControlPath,
        })
      : undefined;

  return new PlexusProjectLifecycle({ routeRegistry, gateway: { env } });
}
