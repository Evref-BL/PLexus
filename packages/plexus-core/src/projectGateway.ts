import { spawn } from "node:child_process";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { loadPlexusGatewayConfig } from "./config.js";
import {
  claimPort,
  inspectPortClaim,
  releasePortClaim,
  type PortClaimChecks,
  type PortClaimRecord,
} from "./portClaims.js";
import {
  projectConfigId,
  resolveProjectRuntimePolicy,
  type ProjectConfig,
  type ProjectLocalGatewayPolicy,
  type ProjectRuntimePortRange,
  type ProjectSharedGatewayPolicy,
} from "./projectConfig.js";
import type {
  PharoMcpContractReference,
  ProjectGatewayState,
  ProjectState,
} from "./projectState.js";

export const defaultGatewayPortClaimsDirectoryName = "plexus-port-claims";
export const gatewayPortClaimPurpose = "gateway";

export interface ProjectGatewayProcessStartOptions {
  projectRoot: string;
  host: string;
  port: number;
  routePath: string;
  controlPath: string;
  state: ProjectState;
  pharoTools?: readonly Tool[];
  pharoMcpContract?: PharoMcpContractReference;
}

export interface ProjectGatewayProcessStartResult {
  pid?: number;
}

export interface ProjectGatewayProcessStopOptions {
  pid: number;
  gateway: ProjectGatewayState;
  state: ProjectState;
}

export interface ProjectGatewayProcessManager {
  start(
    options: ProjectGatewayProcessStartOptions,
  ): Promise<ProjectGatewayProcessStartResult> | ProjectGatewayProcessStartResult;
  stop?(options: ProjectGatewayProcessStopOptions): Promise<void> | void;
}

export interface ProjectGatewayRuntimeOptions {
  claimsRoot?: string;
  checks?: PortClaimChecks;
  processManager?: ProjectGatewayProcessManager;
  env?: NodeJS.ProcessEnv;
  pharoTools?: readonly Tool[];
  pharoMcpContract?: PharoMcpContractReference;
  now?: () => Date;
  fetch?: typeof fetch;
  healthTimeoutMs?: number;
  healthIntervalMs?: number;
  sleep?: (durationMs: number) => Promise<void>;
  skipHealthCheck?: boolean;
}

export interface EnsureProjectGatewayOptions extends ProjectGatewayRuntimeOptions {
  projectRoot: string;
  config: ProjectConfig;
  state: ProjectState;
}

export interface EnsureProjectGatewayResult {
  gateway: ProjectGatewayState;
  routeControlUrl: string;
  started: boolean;
}

export interface CloseProjectGatewayOptions extends ProjectGatewayRuntimeOptions {
  state: ProjectState;
}

export interface CloseProjectGatewayResult {
  closed: boolean;
  stoppedProcess: boolean;
  releasedClaim: boolean;
}

export class ProjectGatewayDeploymentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectGatewayDeploymentError";
  }
}

export interface ProjectGatewayChildEnvironmentOptions {
  env?: NodeJS.ProcessEnv;
  pharoTools?: readonly Tool[];
  pharoMcpContract?: PharoMcpContractReference;
}

export function projectGatewayChildEnvironment(
  options: ProjectGatewayChildEnvironmentOptions = {},
): NodeJS.ProcessEnv {
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ...options.env,
    PLEXUS_GATEWAY_SURFACE: "gateway",
  };

  if (options.pharoTools !== undefined) {
    childEnv.PLEXUS_PHARO_TOOLS_JSON = JSON.stringify(options.pharoTools);
  }

  if (options.pharoMcpContract !== undefined) {
    childEnv.PLEXUS_PHARO_MCP_CONTRACT_JSON = JSON.stringify(
      options.pharoMcpContract,
    );
  }

  return childEnv;
}

export class DetachedProjectGatewayProcessManager
  implements ProjectGatewayProcessManager
{
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  async start(
    options: ProjectGatewayProcessStartOptions,
  ): Promise<ProjectGatewayProcessStartResult> {
    const config = loadPlexusGatewayConfig(this.env);
    const child = spawn(
      config.command,
      [
        ...config.args,
        "serve",
        "--host",
        options.host,
        "--port",
        String(options.port),
        "--mcp-path",
        options.routePath,
        "--control-mcp-path",
        options.controlPath,
      ],
      {
        cwd: options.projectRoot,
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        env: projectGatewayChildEnvironment({
          env: this.env,
          pharoTools: options.pharoTools,
          pharoMcpContract: options.pharoMcpContract,
        }),
      },
    );

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        child.off("spawn", onSpawn);
        reject(error);
      };
      const onSpawn = (): void => {
        child.off("error", onError);
        resolve();
      };

      child.once("error", onError);
      child.once("spawn", onSpawn);
    });
    child.unref();

    return {
      ...(child.pid ? { pid: child.pid } : {}),
    };
  }

  stop(options: ProjectGatewayProcessStopOptions): void {
    try {
      process.kill(options.pid);
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ESRCH") {
        throw error;
      }
    }
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

export function defaultGatewayPortClaimsRoot(): string {
  return path.join(os.tmpdir(), defaultGatewayPortClaimsDirectoryName);
}

function hostForUrl(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function endpointUrl(host: string, port: number, mcpPath: string): string {
  return `http://${hostForUrl(host)}:${port}${mcpPath}`;
}

function defaultSleep(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}

function urlPort(url: URL): number | undefined {
  if (url.port) {
    return Number(url.port);
  }

  if (url.protocol === "http:") {
    return 80;
  }

  if (url.protocol === "https:") {
    return 443;
  }

  return undefined;
}

function sharedGatewayState(
  policy: ProjectSharedGatewayPolicy,
  owningProjectId: string,
): ProjectGatewayState {
  const agentUrl = new URL(policy.agentMcpUrl);
  const controlUrl = new URL(policy.routeControlMcpUrl);

  return {
    mode: "shared",
    endpoint: policy.agentMcpUrl,
    controlEndpoint: policy.routeControlMcpUrl,
    host: agentUrl.hostname,
    ...(urlPort(agentUrl) ? { port: urlPort(agentUrl) } : {}),
    routePath: agentUrl.pathname,
    controlPath: controlUrl.pathname,
    owningProjectId,
    managedByProject: false,
  };
}

function localGatewayState(
  policy: ProjectLocalGatewayPolicy,
  state: ProjectState,
  port: number | undefined,
  claim: PortClaimRecord | undefined,
  pid: number | undefined,
  claimsRoot: string | undefined,
): ProjectGatewayState {
  return {
    mode: "project-local",
    host: policy.host,
    ...(port !== undefined ? { port } : {}),
    ...(policy.portRange ? { portRange: { ...policy.portRange } } : {}),
    routePath: policy.agentMcpPath,
    controlPath: policy.routeControlMcpPath,
    ...(port !== undefined
      ? {
          endpoint: endpointUrl(policy.host, port, policy.agentMcpPath),
          controlEndpoint: endpointUrl(
            policy.host,
            port,
            policy.routeControlMcpPath,
          ),
        }
      : {}),
    owningProjectId: state.projectId,
    managedByProject: true,
    ...(pid !== undefined ? { pid } : {}),
    ...(claim && claimsRoot
      ? {
          claim: {
            claimsRoot,
            claimId: claim.claimId,
            assignedPort: claim.assignedPort,
          },
        }
      : {}),
  };
}

export function projectGatewayStatus(
  config: ProjectConfig,
  state?: ProjectState,
): ProjectGatewayState {
  const policy = resolveProjectRuntimePolicy(config).gateway;
  if (policy.mode === "shared") {
    return sharedGatewayState(policy, state?.projectId ?? projectConfigId(config));
  }

  const stateGateway =
    state?.gateway?.mode === "project-local" ? state.gateway : undefined;
  const statePort = stateGateway?.port;
  const policyPort = policy.port ?? statePort;

  return {
    ...localGatewayState(
      policy,
      state ?? {
        projectId: projectConfigId(config),
        projectName: config.name,
        workspaceId: "",
        targetId: "",
        updatedAt: "",
        images: [],
      },
      policyPort,
      undefined,
      undefined,
      undefined,
    ),
    ...(stateGateway?.pid ? { pid: stateGateway.pid } : {}),
    ...(stateGateway?.claim ? { claim: stateGateway.claim } : {}),
  };
}

function rangeContains(range: ProjectRuntimePortRange, port: number): boolean {
  return port >= range.start && port <= range.end;
}

function existingGatewayMatchesPolicy(
  gateway: ProjectGatewayState | undefined,
  policy: ProjectLocalGatewayPolicy,
  claimsRoot: string,
): gateway is ProjectGatewayState & {
  port: number;
  controlEndpoint: string;
  claim: NonNullable<ProjectGatewayState["claim"]>;
} {
  if (
    !gateway ||
    gateway.mode !== "project-local" ||
    !gateway.managedByProject ||
    !gateway.port ||
    !gateway.controlEndpoint ||
    !gateway.claim
  ) {
    return false;
  }

  if (
    gateway.host !== policy.host ||
    gateway.routePath !== policy.agentMcpPath ||
    gateway.controlPath !== policy.routeControlMcpPath ||
    gateway.claim.claimsRoot !== claimsRoot
  ) {
    return false;
  }

  if (policy.port !== undefined) {
    return gateway.port === policy.port;
  }

  return policy.portRange ? rangeContains(policy.portRange, gateway.port) : false;
}

async function isPortUnavailable(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    const finish = (unavailable: boolean): void => {
      server.removeAllListeners();
      resolve(unavailable);
    };

    server.once("error", () => finish(true));
    server.listen(port, host, () => {
      server.close(() => finish(false));
    });
  });
}

function gatewayChecks(
  host: string,
  checks: PortClaimChecks | undefined,
): PortClaimChecks {
  return {
    ...checks,
    isPortListening:
      checks?.isPortListening ?? ((port) => isPortUnavailable(host, port)),
  };
}

function gatewayClaimsRoot(
  env: NodeJS.ProcessEnv,
  optionsRoot: string | undefined,
): string {
  return (
    optionsRoot ??
    env.PLEXUS_PORT_CLAIMS_ROOT ??
    env.PLEXUS_GATEWAY_PORT_CLAIMS_ROOT ??
    defaultGatewayPortClaimsRoot()
  );
}

function gatewayHealthUrl(gateway: ProjectGatewayState): string | undefined {
  if (!gateway.controlEndpoint) {
    return undefined;
  }

  const url = new URL(gateway.controlEndpoint);
  url.pathname = "/health";
  url.search = "";
  url.hash = "";
  return url.toString();
}

async function waitForGatewayHealth(
  gateway: ProjectGatewayState,
  options: ProjectGatewayRuntimeOptions,
): Promise<void> {
  if (options.skipHealthCheck) {
    return;
  }

  const healthUrl = gatewayHealthUrl(gateway);
  if (!healthUrl) {
    return;
  }

  const fetchFn = options.fetch ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const timeoutMs = options.healthTimeoutMs ?? 10_000;
  const intervalMs = options.healthIntervalMs ?? 100;
  const startedAt = Date.now();
  let lastError: unknown;

  while (Date.now() - startedAt <= timeoutMs) {
    try {
      const response = await fetchFn(healthUrl, { method: "GET" });
      if (response.ok) {
        return;
      }

      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }

    await sleep(intervalMs);
  }

  throw new ProjectGatewayDeploymentError(
    `Timed out waiting for project-local gateway health at ${healthUrl}: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}

async function existingGatewayIsListening(
  gateway: ProjectGatewayState & {
    port: number;
    controlEndpoint: string;
    claim: NonNullable<ProjectGatewayState["claim"]>;
  },
  checks: PortClaimChecks,
): Promise<boolean> {
  const inspection = await inspectPortClaim({
    claimsRoot: gateway.claim.claimsRoot,
    port: gateway.port,
    checks,
  });
  if (
    inspection.status !== "claimed" ||
    inspection.record.claimId !== gateway.claim.claimId
  ) {
    return false;
  }

  return Boolean(await checks.isPortListening?.(gateway.port, inspection.record));
}

function gatewayClaimErrorMessage(
  policy: ProjectLocalGatewayPolicy,
  error: unknown,
): string {
  const portDescription =
    policy.port !== undefined
      ? String(policy.port)
      : `${policy.portRange?.start}-${policy.portRange?.end}`;
  const base = `Project-local gateway port ${portDescription} is already claimed or unavailable`;
  if (!isObjectWithExistingClaim(error)) {
    return `${base}: ${error instanceof Error ? error.message : String(error)}`;
  }

  const owner = error.existingClaim
    ? ` by project ${error.existingClaim.projectId} workspace ${error.existingClaim.workspaceId}`
    : "";
  return `${base}${owner}: ${error.message}`;
}

function isObjectWithExistingClaim(
  error: unknown,
): error is Error & { existingClaim?: PortClaimRecord } {
  return error instanceof Error && "existingClaim" in error;
}

async function ensureProjectLocalGateway(
  options: EnsureProjectGatewayOptions,
  policy: ProjectLocalGatewayPolicy,
): Promise<EnsureProjectGatewayResult> {
  const env = options.env ?? process.env;
  const claimsRoot = gatewayClaimsRoot(env, options.claimsRoot);
  const checks = gatewayChecks(policy.host, options.checks);
  const processManager =
    options.processManager ?? new DetachedProjectGatewayProcessManager(env);

  if (
    existingGatewayMatchesPolicy(options.state.gateway, policy, claimsRoot) &&
    (await existingGatewayIsListening(options.state.gateway, checks))
  ) {
    return {
      gateway: options.state.gateway,
      routeControlUrl: options.state.gateway.controlEndpoint,
      started: false,
    };
  }

  if (options.state.gateway?.managedByProject) {
    await closeProjectGateway({
      ...options,
      state: options.state,
      processManager,
      checks,
    });
  }

  let claim: PortClaimRecord;
  try {
    claim = await claimPort({
      claimsRoot,
      projectId: options.state.projectId,
      projectName: options.state.projectName,
      workspaceId: options.state.workspaceId,
      targetId: options.state.targetId,
      purpose: gatewayPortClaimPurpose,
      requestedPort: policy.port,
      portRange: policy.portRange,
      now: options.now,
      checks,
    });
  } catch (error) {
    throw new ProjectGatewayDeploymentError(
      gatewayClaimErrorMessage(policy, error),
    );
  }

  let started: ProjectGatewayProcessStartResult;
  const pharoMcpContract =
    options.pharoMcpContract ?? options.state.pharoMcpContract;
  try {
    started = await processManager.start({
      projectRoot: options.projectRoot,
      host: policy.host,
      port: claim.assignedPort,
      routePath: policy.agentMcpPath,
      controlPath: policy.routeControlMcpPath,
      state: options.state,
      ...(options.pharoTools !== undefined
        ? { pharoTools: options.pharoTools }
        : {}),
      ...(pharoMcpContract !== undefined ? { pharoMcpContract } : {}),
    });
  } catch (error) {
    await releasePortClaim({ claimsRoot, claim });
    throw error;
  }

  const gateway = localGatewayState(
    policy,
    options.state,
    claim.assignedPort,
    claim,
    started.pid,
    claimsRoot,
  );
  options.state.gateway = gateway;

  if (!gateway.controlEndpoint) {
    throw new ProjectGatewayDeploymentError(
      "Project-local gateway did not produce a route-control endpoint",
    );
  }

  try {
    await waitForGatewayHealth(gateway, options);
  } catch (error) {
    await closeProjectGateway({
      ...options,
      state: options.state,
      processManager,
      checks,
    });
    throw error;
  }

  return {
    gateway,
    routeControlUrl: gateway.controlEndpoint,
    started: true,
  };
}

export async function ensureProjectGateway(
  options: EnsureProjectGatewayOptions,
): Promise<EnsureProjectGatewayResult> {
  const policy = resolveProjectRuntimePolicy(options.config).gateway;
  if (policy.mode === "shared") {
    const gateway = sharedGatewayState(policy, options.state.projectId);
    options.state.gateway = gateway;
    return {
      gateway,
      routeControlUrl: policy.routeControlMcpUrl,
      started: false,
    };
  }

  return ensureProjectLocalGateway(options, policy);
}

export async function closeProjectGateway(
  options: CloseProjectGatewayOptions,
): Promise<CloseProjectGatewayResult> {
  const gateway = options.state.gateway;
  if (!gateway) {
    return {
      closed: false,
      stoppedProcess: false,
      releasedClaim: false,
    };
  }

  const processManager =
    options.processManager ??
    new DetachedProjectGatewayProcessManager(options.env ?? process.env);
  let stoppedProcess = false;
  let stopError: unknown;

  if (gateway.managedByProject && gateway.pid && processManager.stop) {
    try {
      await processManager.stop({
        pid: gateway.pid,
        gateway,
        state: options.state,
      });
      stoppedProcess = true;
    } catch (error) {
      stopError = error;
    }
  }

  let releasedClaim = false;
  if (gateway.managedByProject && gateway.claim) {
    const release = await releasePortClaim({
      claimsRoot: gateway.claim.claimsRoot,
      claim: {
        claimId: gateway.claim.claimId,
        assignedPort: gateway.claim.assignedPort,
      },
    });
    releasedClaim = release.released;
  }

  delete options.state.gateway;

  if (stopError) {
    throw stopError;
  }

  return {
    closed: true,
    stoppedProcess,
    releasedClaim,
  };
}
