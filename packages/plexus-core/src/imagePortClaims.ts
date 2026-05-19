import net from "node:net";
import os from "node:os";
import path from "node:path";
import {
  resolveProjectRuntimePolicy,
  type ProjectConfig,
  type ProjectImageConfig,
} from "./projectConfig.js";
import {
  claimPort,
  inspectPortClaim,
  PortClaimConflictError,
  releasePortClaim,
  updatePortClaim,
  type PortClaimChecks,
  type PortClaimRecord,
  type PortClaimScope,
} from "./portClaims.js";
import type {
  ProjectImageState,
  ProjectPortRange,
  ProjectState,
  ReservedProjectPortOwner,
} from "./projectState.js";
import { isAbsolutePathLike, resolvePathLike } from "./pathStyle.js";

export const imageMcpPortClaimPurpose = "image-mcp";
export const defaultPortClaimsRootName = "plexus-port-claims";

export interface PreparedImagePortClaim {
  imageId: string;
  claim: PortClaimRecord;
  created: boolean;
}

export interface PrepareImagePortClaimsOptions {
  config: ProjectConfig;
  state: ProjectState;
  previousState?: ProjectState;
  images: ProjectImageState[];
  projectReservedOwners: ReservedProjectPortOwner[];
  claimsRoot: string;
  portRange: ProjectPortRange;
  checks: PortClaimChecks;
  now?: () => Date;
}

export interface ReleaseImagePortClaimOptions {
  state: ProjectState;
  image: ProjectImageState;
  claimsRoot: string;
  checks: PortClaimChecks;
}

export interface RecordImagePortClaimProcessOptions {
  claimsRoot: string;
  preparedClaim: PreparedImagePortClaim;
  pid: number;
  now?: () => Date;
}

interface ClaimImagePortOptions {
  claimsRoot: string;
  scope: PortClaimScope & { imageId: string };
  port: number;
  checks: PortClaimChecks;
  now?: () => Date;
  conflictingOwner?: ReservedProjectPortOwner;
}

interface ClaimDynamicImagePortOptions {
  claimsRoot: string;
  scope: PortClaimScope & { imageId: string };
  portRange: ProjectPortRange;
  checks: PortClaimChecks;
  now?: () => Date;
}

function defaultPortClaimsRoot(): string {
  return path.join(os.tmpdir(), defaultPortClaimsRootName);
}

export function imagePortClaimsRootForConfig(
  projectRoot: string,
  config: ProjectConfig,
): string | undefined {
  const coordination = resolveProjectRuntimePolicy(config).imagePorts.coordination;
  if (coordination.mode !== "host-local") {
    return undefined;
  }

  if (!coordination.root) {
    return defaultPortClaimsRoot();
  }

  return isAbsolutePathLike(coordination.root)
    ? resolvePathLike(coordination.root)
    : resolvePathLike(projectRoot, coordination.root);
}

export async function isTcpPortListening(
  port: number,
  host = "127.0.0.1",
): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    let settled = false;
    const finish = (value: boolean): void => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };

    server.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE" || error.code === "EACCES") {
        finish(true);
        return;
      }

      reject(error);
    });
    server.listen({ port, host, exclusive: true }, () => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        finish(false);
      });
    });
  });
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "EPERM"
    );
  }
}

export function defaultImagePortClaimChecks(): PortClaimChecks {
  return {
    isPortListening: (port) => isTcpPortListening(port),
    isProcessAlive: (pid) => isProcessAlive(pid),
  };
}

function imageConfigForState(
  config: ProjectConfig,
  image: ProjectImageState,
): ProjectImageConfig {
  const imageConfig = config.images.find((candidate) => candidate.id === image.id);
  if (!imageConfig) {
    throw new Error(`Project image config not found for image ${image.id}`);
  }

  return imageConfig;
}

function previousImagePort(
  previousState: ProjectState | undefined,
  imageId: string,
): number | undefined {
  return previousState?.images.find((image) => image.id === imageId)
    ?.assignedPort;
}

function imageCanUsePharoMcpPort(image: ProjectImageState): boolean {
  return image.pharoMcpContract?.status !== "unsupported";
}

function portInRange(port: number, range: ProjectPortRange): boolean {
  return port >= range.start && port <= range.end;
}

function claimScopeForImage(
  state: ProjectState,
  image: ProjectImageState,
): PortClaimScope & { imageId: string } {
  return {
    projectId: state.projectId,
    projectName: state.projectName,
    workspaceId: state.workspaceId,
    targetId: state.targetId,
    purpose: imageMcpPortClaimPurpose,
    imageId: image.id,
  };
}

function isCompatibleImageClaim(
  claim: PortClaimRecord,
  scope: PortClaimScope & { imageId: string },
): boolean {
  return (
    claim.projectId === scope.projectId &&
    claim.workspaceId === scope.workspaceId &&
    claim.targetId === scope.targetId &&
    claim.purpose === scope.purpose &&
    (claim.imageId === undefined || claim.imageId === scope.imageId)
  );
}

function claimOwnerLabel(claim: PortClaimRecord): string {
  return [
    `project ${claim.projectId}`,
    `workspace ${claim.workspaceId}`,
    `target ${claim.targetId}`,
    claim.imageId ? `image ${claim.imageId}` : undefined,
  ]
    .filter((part): part is string => part !== undefined)
    .join(", ");
}

function projectStateOwnerLabel(owner: ReservedProjectPortOwner): string {
  return [
    `project ${owner.projectId}`,
    `workspace ${owner.workspaceId}`,
    `target ${owner.targetId}`,
    `image ${owner.imageId}`,
  ].join(", ");
}

function imagePortConflictMessage(
  scope: PortClaimScope & { imageId: string },
  port: number,
  reason: string,
  owner?: string,
): string {
  return [
    `Project ${scope.projectId} image ${scope.imageId} cannot use image MCP port ${port}: ${reason}`,
    owner ? `conflicting owner ${owner}` : undefined,
  ]
    .filter((part): part is string => part !== undefined)
    .join("; ");
}

async function claimRequestedImagePort(
  options: ClaimImagePortOptions,
): Promise<PreparedImagePortClaim> {
  if (options.conflictingOwner) {
    throw new PortClaimConflictError(
      options.port,
      imagePortConflictMessage(
        options.scope,
        options.port,
        "reserved by project workspace state",
        projectStateOwnerLabel(options.conflictingOwner),
      ),
    );
  }

  const inspection = await inspectPortClaim({
    claimsRoot: options.claimsRoot,
    port: options.port,
    checks: options.checks,
    now: options.now,
  });
  if (
    inspection.status === "claimed" &&
    isCompatibleImageClaim(inspection.record, options.scope)
  ) {
    return {
      imageId: options.scope.imageId,
      claim: inspection.record,
      created: false,
    };
  }

  if (inspection.status === "claimed") {
    throw new PortClaimConflictError(
      options.port,
      imagePortConflictMessage(
        options.scope,
        options.port,
        "already claimed",
        claimOwnerLabel(inspection.record),
      ),
      inspection.record,
    );
  }

  if (inspection.status === "unreadable") {
    throw new PortClaimConflictError(
      options.port,
      imagePortConflictMessage(
        options.scope,
        options.port,
        `claim record is unreadable: ${inspection.reason}`,
      ),
    );
  }

  if (await options.checks.isPortListening?.(options.port)) {
    throw new PortClaimConflictError(
      options.port,
      imagePortConflictMessage(
        options.scope,
        options.port,
        "occupied by a host listener",
      ),
    );
  }

  try {
    const claim = await claimPort({
      claimsRoot: options.claimsRoot,
      requestedPort: options.port,
      now: options.now,
      checks: options.checks,
      ...options.scope,
    });
    return {
      imageId: options.scope.imageId,
      claim,
      created: true,
    };
  } catch (error) {
    if (error instanceof PortClaimConflictError) {
      throw new PortClaimConflictError(
        options.port,
        imagePortConflictMessage(
          options.scope,
          options.port,
          "already claimed or unavailable",
          error.existingClaim ? claimOwnerLabel(error.existingClaim) : undefined,
        ),
        error.existingClaim,
      );
    }

    throw error;
  }
}

async function tryClaimPreferredDynamicPort(
  options: ClaimImagePortOptions,
): Promise<PreparedImagePortClaim | undefined> {
  try {
    return await claimRequestedImagePort(options);
  } catch (error) {
    if (error instanceof PortClaimConflictError) {
      return undefined;
    }

    throw error;
  }
}

async function claimDynamicImagePort(
  options: ClaimDynamicImagePortOptions,
): Promise<PreparedImagePortClaim> {
  const claim = await claimPort({
    claimsRoot: options.claimsRoot,
    portRange: options.portRange,
    now: options.now,
    checks: options.checks,
    ...options.scope,
  });

  return {
    imageId: options.scope.imageId,
    claim,
    created: true,
  };
}

function mergePortClaimChecks(
  base: PortClaimChecks,
  isPortUnavailable: (port: number) => boolean,
): PortClaimChecks {
  return {
    isProcessAlive: base.isProcessAlive,
    isPortListening: async (port, claim) =>
      isPortUnavailable(port) ||
      Boolean(await base.isPortListening?.(port, claim)),
  };
}

export async function releasePreparedImagePortClaims(
  claimsRoot: string,
  claims: Iterable<PreparedImagePortClaim>,
): Promise<void> {
  await Promise.all(
    [...claims]
      .filter((claim) => claim.created)
      .map((claim) => releasePortClaim({ claimsRoot, claim: claim.claim })),
  );
}

export async function prepareImagePortClaims(
  options: PrepareImagePortClaimsOptions,
): Promise<PreparedImagePortClaim[]> {
  const claims: PreparedImagePortClaim[] = [];
  const projectOwnersByPort = new Map(
    options.projectReservedOwners.map((owner) => [owner.port, owner]),
  );
  const projectReservedPorts = new Set(projectOwnersByPort.keys());
  const imageIdsThatCanUsePharoMcpPort = new Set(
    options.images
      .filter((image) => imageCanUsePharoMcpPort(image))
      .map((image) => image.id),
  );
  const configuredPorts = new Set(
    options.config.images
      .filter((image) => imageIdsThatCanUsePharoMcpPort.has(image.id))
      .map((image) => image.mcp.port)
      .filter((port): port is number => port !== undefined),
  );
  const assignedThisOpen = new Set<number>();

  try {
    for (const image of options.images) {
      if (!imageCanUsePharoMcpPort(image)) {
        delete image.assignedPort;
        continue;
      }

      const imageConfig = imageConfigForState(options.config, image);
      const scope = claimScopeForImage(options.state, image);
      const configuredPort = imageConfig.mcp.port;

      if (configuredPort !== undefined) {
        const prepared = await claimRequestedImagePort({
          claimsRoot: options.claimsRoot,
          scope,
          port: configuredPort,
          checks: options.checks,
          now: options.now,
          conflictingOwner:
            projectOwnersByPort.get(configuredPort) ??
            (assignedThisOpen.has(configuredPort)
              ? {
                  port: configuredPort,
                  projectId: options.state.projectId,
                  projectName: options.state.projectName,
                  workspaceId: options.state.workspaceId,
                  targetId: options.state.targetId,
                  imageId: "current-open",
                  imageName: "current open",
                  status: "starting",
                }
              : undefined),
        });
        image.assignedPort = configuredPort;
        assignedThisOpen.add(configuredPort);
        claims.push(prepared);
        continue;
      }

      const previousPort = previousImagePort(options.previousState, image.id);
      if (
        previousPort !== undefined &&
        portInRange(previousPort, options.portRange) &&
        !configuredPorts.has(previousPort) &&
        !projectReservedPorts.has(previousPort) &&
        !assignedThisOpen.has(previousPort)
      ) {
        const preferredClaim = await tryClaimPreferredDynamicPort({
          claimsRoot: options.claimsRoot,
          scope,
          port: previousPort,
          checks: options.checks,
          now: options.now,
        });
        if (preferredClaim) {
          image.assignedPort = previousPort;
          assignedThisOpen.add(previousPort);
          claims.push(preferredClaim);
          continue;
        }
      }

      const checks = mergePortClaimChecks(options.checks, (port) => {
        return (
          assignedThisOpen.has(port) ||
          projectReservedPorts.has(port) ||
          configuredPorts.has(port)
        );
      });
      const dynamicClaim = await claimDynamicImagePort({
        claimsRoot: options.claimsRoot,
        scope,
        portRange: options.portRange,
        checks,
        now: options.now,
      });
      image.assignedPort = dynamicClaim.claim.assignedPort;
      assignedThisOpen.add(image.assignedPort);
      claims.push(dynamicClaim);
    }
  } catch (error) {
    await releasePreparedImagePortClaims(options.claimsRoot, claims);
    throw error;
  }

  return claims;
}

export async function releaseImagePortClaimIfOwned(
  options: ReleaseImagePortClaimOptions,
): Promise<void> {
  if (options.image.assignedPort === undefined) {
    return;
  }

  const scope = claimScopeForImage(options.state, options.image);
  const inspection = await inspectPortClaim({
    claimsRoot: options.claimsRoot,
    port: options.image.assignedPort,
    checks: options.checks,
  });

  if (
    (inspection.status === "claimed" || inspection.status === "stale") &&
    isCompatibleImageClaim(inspection.record, scope)
  ) {
    await releasePortClaim({
      claimsRoot: options.claimsRoot,
      claim: inspection.record,
    });
  }
}

export async function recordImagePortClaimProcess(
  options: RecordImagePortClaimProcessOptions,
): Promise<void> {
  const updatedClaim = await updatePortClaim({
    claimsRoot: options.claimsRoot,
    claim: options.preparedClaim.claim,
    update: (claim) => ({
      ...claim,
      pid: options.pid,
      updatedAt: (options.now ?? (() => new Date()))().toISOString(),
    }),
  });

  if (updatedClaim) {
    options.preparedClaim.claim = updatedClaim;
  }
}
