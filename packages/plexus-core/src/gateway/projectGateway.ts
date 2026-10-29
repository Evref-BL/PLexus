import { spawn } from "node:child_process";
import net from "node:net";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { loadPlexusGatewayConfig } from "../config/config.js";
import {
  projectConfigId,
  resolveProjectRuntimePolicy,
  type ProjectConfig,
  type ProjectLocalGatewayPolicy,
  type ProjectSharedGatewayPolicy,
} from "../config/projectConfig.js";
import type {
  PharoMcpContractReference,
  ProjectGatewayState,
  ProjectState,
} from "../workspace/projectState.js";

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
  processManager?: ProjectGatewayProcessManager;
  isPortListening?: (port: number) => Promise<boolean>;
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
  const gatewayUrl = new URL(policy.mcpUrl);
  const controlUrl = new URL(policy.routeControlMcpUrl);

  return {
    mode: "shared",
    endpoint: policy.mcpUrl,
    controlEndpoint: policy.routeControlMcpUrl,
    host: gatewayUrl.hostname,
    ...(urlPort(gatewayUrl) ? { port: urlPort(gatewayUrl) } : {}),
    routePath: gatewayUrl.pathname,
    controlPath: controlUrl.pathname,
    owningProjectId,
    managedByProject: false,
  };
}

function localGatewayState(
  policy: ProjectLocalGatewayPolicy,
  state: ProjectState,
  port: number | undefined,
  pid: number | undefined,
): ProjectGatewayState {
  return {
    mode: "project-local",
    host: policy.host,
    ...(port !== undefined ? { port } : {}),
    routePath: policy.mcpPath,
    controlPath: policy.routeControlMcpPath,
    ...(port !== undefined
      ? {
          endpoint: endpointUrl(policy.host, port, policy.mcpPath),
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

  return {
    ...localGatewayState(
      policy,
      state ?? {
        projectId: projectConfigId(config),
        projectName: config.name,
        workspaceId: "",
        updatedAt: "",
        images: [],
      },
      policy.port,
      undefined,
    ),
    ...(stateGateway?.pid ? { pid: stateGateway.pid } : {}),
  };
}

function existingGatewayMatchesPolicy(
  gateway: ProjectGatewayState | undefined,
  policy: ProjectLocalGatewayPolicy,
): gateway is ProjectGatewayState & {
  port: number;
  controlEndpoint: string;
} {
  return Boolean(
    gateway &&
      gateway.mode === "project-local" &&
      gateway.managedByProject &&
      gateway.port === policy.port &&
      gateway.controlEndpoint &&
      gateway.host === policy.host &&
      gateway.routePath === policy.mcpPath &&
      gateway.controlPath === policy.routeControlMcpPath,
  );
}

export async function isPortInUse(host: string, port: number): Promise<boolean> {
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

async function gatewayIsHealthy(
  gateway: ProjectGatewayState,
  options: ProjectGatewayRuntimeOptions,
): Promise<boolean> {
  const healthUrl = gatewayHealthUrl(gateway);
  if (!healthUrl) {
    return false;
  }

  try {
    const response = await (options.fetch ?? fetch)(healthUrl, { method: "GET" });
    return response.ok;
  } catch {
    return false;
  }
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

async function ensureProjectLocalGateway(
  options: EnsureProjectGatewayOptions,
  policy: ProjectLocalGatewayPolicy,
): Promise<EnsureProjectGatewayResult> {
  const env = options.env ?? process.env;
  const processManager =
    options.processManager ?? new DetachedProjectGatewayProcessManager(env);

  if (
    existingGatewayMatchesPolicy(options.state.gateway, policy) &&
    (await gatewayIsHealthy(options.state.gateway, options))
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
    });
  }

  const portInUse =
    options.isPortListening ?? ((port) => isPortInUse(policy.host, port));
  if (await portInUse(policy.port)) {
    throw new ProjectGatewayDeploymentError(
      `Project-local gateway port ${policy.port} is already in use. ` +
        "Set runtime.gateway.port to a free port, or stop whatever holds it.",
    );
  }

  const pharoMcpContract =
    options.pharoMcpContract ?? options.state.pharoMcpContract;
  const started = await processManager.start({
      projectRoot: options.projectRoot,
      host: policy.host,
      port: policy.port,
      routePath: policy.mcpPath,
      controlPath: policy.routeControlMcpPath,
      state: options.state,
      ...(options.pharoTools !== undefined
        ? { pharoTools: options.pharoTools }
        : {}),
    ...(pharoMcpContract !== undefined ? { pharoMcpContract } : {}),
  });

  const gateway = localGatewayState(policy, options.state, policy.port, started.pid);
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

  delete options.state.gateway;

  if (stopError) {
    throw stopError;
  }

  return {
    closed: true,
    stoppedProcess,
  };
}
