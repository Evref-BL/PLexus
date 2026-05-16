import fs from "node:fs";
import type { ProjectConfig } from "./projectConfig.js";
import {
  basenamePathLike,
  dirnamePathLike,
  joinPathLike,
} from "./pathStyle.js";

export const plexusStateDirectoryName = ".plexus";
export const plexusProjectsStateDirectoryName = "projects";
export const plexusWorkspacesStateDirectoryName = "workspaces";
export const projectStateFileName = "state.json";
export const defaultWorkspaceIdValue = "default";
export const defaultProjectPortRange = {
  start: 7_100,
  end: 7_199,
} as const;

export type ProjectImageStatus = "starting" | "running" | "stopped" | "failed";
export type PharoMcpContractStatus = "unknown" | "matching" | "mismatched";

export interface PharoMcpContractReference {
  id?: string;
  hash?: string;
}

export interface ProjectImagePharoMcpContractState
  extends PharoMcpContractReference {
  status?: PharoMcpContractStatus;
  expectedId?: string;
  expectedHash?: string;
}

export interface ProjectImageState {
  id: string;
  imageName: string;
  assignedPort: number;
  pid?: number;
  status: ProjectImageStatus;
  pharoMcpContract?: ProjectImagePharoMcpContractState;
  imagePath?: string;
  imageDirectoryPath?: string;
  changesPath?: string;
  localDirectoryPath?: string;
  ombuDirectoryPath?: string;
  vmId?: string;
  pharoVersion?: string;
  originTemplate?: {
    name?: string;
    url?: string;
  };
  rescueSnapshot?: {
    capturedAt: string;
    launcherImage?: {
      name?: string;
      pharoVersion?: string;
      imagePath?: string;
      originTemplate?: {
        name?: string;
        url?: string;
      };
      vmId?: string;
    };
    paths: {
      imagePath?: string;
      imageDirectoryPath?: string;
      changesPath?: string;
      localDirectoryPath?: string;
      ombuDirectoryPath?: string;
    };
    repositories?: {
      capturedAt: string;
      status: "captured" | "unavailable";
      repositories: Record<string, unknown>[];
      error?: string;
    };
  };
}

export interface ProjectState {
  projectId: string;
  projectName: string;
  workspaceId: string;
  targetId: string;
  pharoMcpContract?: PharoMcpContractReference;
  images: ProjectImageState[];
  updatedAt: string;
}

export interface ProjectPortRange {
  start: number;
  end: number;
}

export interface CreateProjectStateOptions {
  updatedAt?: string;
  previousState?: ProjectState;
  portRange?: ProjectPortRange;
  reservedPorts?: Iterable<number>;
  workspaceId?: string;
  targetId?: string;
}

interface NormalizedCreateProjectStateOptions {
  updatedAt: string;
  previousState?: ProjectState;
  portRange: ProjectPortRange;
  reservedPorts: Set<number>;
  workspaceId: string;
  targetId?: string;
}

export interface ProjectStatePathOptions {
  projectRoot: string;
  projectId: string;
  workspaceId?: string;
  stateRoot?: string;
}

export interface ProjectStatePathForConfigOptions {
  projectRoot: string;
  config: ProjectConfig;
  workspaceId?: string;
  stateRoot?: string;
}

export class PortAllocationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PortAllocationError";
  }
}

export class ProjectStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectStateError";
  }
}

export function defaultPlexusStateRoot(projectRoot: string): string {
  return joinPathLike(projectRoot, plexusStateDirectoryName);
}

export function sanitizeRuntimeId(value: string): string {
  const sanitized = value.trim().replace(/[^A-Za-z0-9._-]+/g, "-");
  return sanitized.replace(/^-+|-+$/g, "") || defaultWorkspaceIdValue;
}

export function defaultWorkspaceId(projectRoot: string): string {
  return sanitizeRuntimeId(basenamePathLike(projectRoot));
}

export function defaultTargetId(projectId: string, workspaceId: string): string {
  return `${projectId}--${workspaceId}`;
}

export function projectWorkspacesStateDirectoryPath(
  options: Omit<ProjectStatePathOptions, "workspaceId">,
): string {
  const stateRoot =
    options.stateRoot ?? defaultPlexusStateRoot(options.projectRoot);

  return joinPathLike(
    stateRoot,
    plexusProjectsStateDirectoryName,
    options.projectId,
    plexusWorkspacesStateDirectoryName,
  );
}

export function projectStateDirectoryPath(
  options: ProjectStatePathOptions,
): string {
  return joinPathLike(
    projectWorkspacesStateDirectoryPath(options),
    options.workspaceId
      ? sanitizeRuntimeId(options.workspaceId)
      : defaultWorkspaceId(options.projectRoot),
  );
}

export function projectStatePath(options: ProjectStatePathOptions): string {
  return joinPathLike(projectStateDirectoryPath(options), projectStateFileName);
}

export function projectStatePathForConfig(
  options: ProjectStatePathForConfigOptions,
): string {
  return projectStatePath({
    projectRoot: options.projectRoot,
    projectId: options.config.kanban.projectId,
    workspaceId: options.workspaceId,
    stateRoot: options.stateRoot,
  });
}

function validatePortRange(range: ProjectPortRange): void {
  if (
    !Number.isInteger(range.start) ||
    !Number.isInteger(range.end) ||
    range.start < 1 ||
    range.end > 65_535 ||
    range.start > range.end
  ) {
    throw new PortAllocationError(
      "Port range must use integer ports between 1 and 65535 with start <= end",
    );
  }
}

function nextAvailablePort(
  range: ProjectPortRange,
  unavailablePorts: Set<number>,
): number {
  for (let port = range.start; port <= range.end; port += 1) {
    if (!unavailablePorts.has(port)) {
      return port;
    }
  }

  throw new PortAllocationError(
    `No available port in range ${range.start}-${range.end}`,
  );
}

function previousImagePort(
  previousState: ProjectState | undefined,
  imageId: string,
): number | undefined {
  return previousState?.images.find((image) => image.id === imageId)
    ?.assignedPort;
}

function normalizeCreateProjectStateOptions(
  optionsOrUpdatedAt: string | CreateProjectStateOptions | undefined,
): NormalizedCreateProjectStateOptions {
  if (typeof optionsOrUpdatedAt === "string") {
    const workspaceId = defaultWorkspaceIdValue;
    return {
      updatedAt: optionsOrUpdatedAt,
      previousState: undefined,
      portRange: defaultProjectPortRange,
      reservedPorts: new Set(),
      workspaceId,
      targetId: undefined,
    };
  }

  const workspaceId = sanitizeRuntimeId(
    optionsOrUpdatedAt?.workspaceId ??
      optionsOrUpdatedAt?.previousState?.workspaceId ??
      defaultWorkspaceIdValue,
  );

  return {
    updatedAt: optionsOrUpdatedAt?.updatedAt ?? new Date().toISOString(),
    previousState: optionsOrUpdatedAt?.previousState,
    portRange: optionsOrUpdatedAt?.portRange ?? defaultProjectPortRange,
    reservedPorts: new Set(optionsOrUpdatedAt?.reservedPorts ?? []),
    workspaceId,
    targetId:
      optionsOrUpdatedAt?.targetId ?? optionsOrUpdatedAt?.previousState?.targetId,
  };
}

export function loadProjectState(filePath: string): ProjectState | undefined {
  if (!fs.existsSync(filePath)) {
    return undefined;
  }

  return JSON.parse(fs.readFileSync(filePath, "utf8")) as ProjectState;
}

export function saveProjectState(filePath: string, state: ProjectState): void {
  fs.mkdirSync(dirnamePathLike(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

export function collectReservedProjectPorts(
  options: Omit<ProjectStatePathOptions, "workspaceId"> & {
    excludeWorkspaceId?: string;
  },
): number[] {
  const workspacesDir = projectWorkspacesStateDirectoryPath(options);
  if (!fs.existsSync(workspacesDir)) {
    return [];
  }

  const excludedWorkspaceId = options.excludeWorkspaceId
    ? sanitizeRuntimeId(options.excludeWorkspaceId)
    : undefined;
  const ports = new Set<number>();

  for (const entry of fs.readdirSync(workspacesDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === excludedWorkspaceId) {
      continue;
    }

    const state = loadProjectState(
      joinPathLike(workspacesDir, entry.name, projectStateFileName),
    );
    for (const image of state?.images ?? []) {
      if (image.status !== "stopped") {
        ports.add(image.assignedPort);
      }
    }
  }

  return [...ports];
}

export interface ProjectImageNameTemplateContext {
  projectId: string;
  projectName: string;
  workspaceId: string;
  targetId: string;
  imageId: string;
}

export function renderProjectImageName(
  template: string,
  context: ProjectImageNameTemplateContext,
): string {
  return template.replace(
    /\{(projectId|projectName|workspaceId|targetId|imageId)\}/g,
    (_match, key: keyof ProjectImageNameTemplateContext) => context[key],
  );
}

export function createProjectState(
  config: ProjectConfig,
  optionsOrUpdatedAt?: string | CreateProjectStateOptions,
): ProjectState {
  const options = normalizeCreateProjectStateOptions(optionsOrUpdatedAt);
  validatePortRange(options.portRange);

  const targetId =
    options.targetId ??
    defaultTargetId(config.kanban.projectId, options.workspaceId);
  const configuredPorts = new Set(
    config.images
      .map((image) => image.mcp.port)
      .filter((port): port is number => port !== undefined),
  );
  const unavailablePorts = new Set([...options.reservedPorts, ...configuredPorts]);
  const images: ProjectImageState[] = config.images.map((image) => {
    const previousPort = previousImagePort(options.previousState, image.id);
    let assignedPort = image.mcp.port;

    if (assignedPort !== undefined && options.reservedPorts.has(assignedPort)) {
      throw new PortAllocationError(
        `Configured port ${assignedPort} is already reserved by another workspace`,
      );
    }

    if (assignedPort === undefined) {
      if (
        previousPort !== undefined &&
        !configuredPorts.has(previousPort) &&
        !unavailablePorts.has(previousPort)
      ) {
        assignedPort = previousPort;
      } else {
        assignedPort = nextAvailablePort(options.portRange, unavailablePorts);
      }
    }

    unavailablePorts.add(assignedPort);

    return {
      id: image.id,
      imageName: renderProjectImageName(image.imageName, {
        projectId: config.kanban.projectId,
        projectName: config.name,
        workspaceId: options.workspaceId,
        targetId,
        imageId: image.id,
      }),
      assignedPort,
      status: image.active ? "starting" : "stopped",
    };
  });

  const imageNames = new Set<string>();
  for (const image of images) {
    if (imageNames.has(image.imageName)) {
      throw new ProjectStateError(
        `Rendered image names must be unique: ${image.imageName}`,
      );
    }

    imageNames.add(image.imageName);
  }

  return {
    projectId: config.kanban.projectId,
    projectName: config.name,
    workspaceId: options.workspaceId,
    targetId,
    updatedAt: options.updatedAt,
    images,
  };
}
