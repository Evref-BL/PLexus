import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export const portClaimSchemaVersion = 1;
export const portClaimsDirectoryName = "ports";
export const portClaimRecordFileName = "claim.json";

export interface PortRange {
  start: number;
  end: number;
}

export interface PortClaimChecks {
  isProcessAlive?: (
    pid: number,
    claim: PortClaimRecord,
  ) => boolean | Promise<boolean>;
  isPortListening?: (
    port: number,
    claim?: PortClaimRecord,
  ) => boolean | Promise<boolean>;
}

export interface PortClaimScope {
  projectId: string;
  projectName?: string;
  workspaceId: string;
  targetId: string;
  purpose: string;
  imageId?: string;
}

export interface PortClaimRecord extends PortClaimScope {
  schemaVersion: typeof portClaimSchemaVersion;
  claimId: string;
  requestedPort?: number;
  assignedPort: number;
  pid?: number;
  claimedAt: string;
  updatedAt?: string;
}

export interface ClaimPortOptions extends PortClaimScope {
  claimsRoot: string;
  requestedPort?: number;
  portRange?: PortRange;
  pid?: number;
  claimId?: string;
  now?: () => Date;
  checks?: PortClaimChecks;
  staleAfterMs?: number;
}

export interface PortClaimReference {
  assignedPort: number;
  claimId: string;
}

export interface ReleasePortClaimOptions {
  claimsRoot: string;
  claim: PortClaimReference;
}

export interface PortClaimReleaseResult {
  released: boolean;
  port: number;
  reason?: "not-found" | "claim-mismatch";
  currentClaim?: PortClaimRecord;
}

export interface UpdatePortClaimOptions {
  claimsRoot: string;
  claim: PortClaimReference;
  update: (claim: PortClaimRecord) => PortClaimRecord;
}

export type PortClaimInspection =
  | {
      status: "available";
      port: number;
    }
  | {
      status: "claimed" | "stale";
      port: number;
      record: PortClaimRecord;
      reason?: PortClaimKeepReason | PortClaimStaleReason;
    }
  | {
      status: "unreadable";
      port: number;
      reason: string;
    };

export interface InspectPortClaimOptions {
  claimsRoot: string;
  port: number;
  checks?: PortClaimChecks;
  now?: () => Date;
  staleAfterMs?: number;
}

export interface ListPortClaimsOptions {
  claimsRoot: string;
}

export type PortClaimStaleReason = "process-dead" | "expired";
export type PortClaimKeepReason =
  | "port-listening"
  | "process-alive"
  | "unchecked";

export interface PortClaimKeptRecord {
  claim: PortClaimRecord;
  reason: PortClaimKeepReason;
}

export interface ReapStalePortClaimsOptions {
  claimsRoot: string;
  checks?: PortClaimChecks;
  now?: () => Date;
  staleAfterMs?: number;
}

export interface ReapStalePortClaimsResult {
  reaped: PortClaimRecord[];
  kept: PortClaimKeptRecord[];
  removedOrphans: number[];
}

interface ClaimEntry {
  port: number;
  updatedAtMs: number;
  record?: PortClaimRecord;
}

interface StalenessEvaluation {
  stale: boolean;
  reason: PortClaimKeepReason | PortClaimStaleReason;
}

export class PortClaimError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PortClaimError";
  }
}

export class PortClaimConflictError extends PortClaimError {
  readonly port: number;
  readonly existingClaim?: PortClaimRecord;

  constructor(port: number, message: string, existingClaim?: PortClaimRecord) {
    super(message);
    this.name = "PortClaimConflictError";
    this.port = port;
    this.existingClaim = existingClaim;
  }
}

export class PortClaimAllocationError extends PortClaimError {
  constructor(message: string) {
    super(message);
    this.name = "PortClaimAllocationError";
  }
}

function claimsDirectoryPath(claimsRoot: string): string {
  return path.join(claimsRoot, portClaimsDirectoryName);
}

function claimDirectoryPath(claimsRoot: string, port: number): string {
  return path.join(claimsDirectoryPath(claimsRoot), String(port));
}

function claimRecordPath(claimsRoot: string, port: number): string {
  return path.join(claimDirectoryPath(claimsRoot, port), portClaimRecordFileName);
}

function validatePort(port: number, fieldName = "port"): void {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new PortClaimAllocationError(
      `${fieldName} must be an integer between 1 and 65535`,
    );
  }
}

function validatePortRange(range: PortRange): void {
  validatePort(range.start, "portRange.start");
  validatePort(range.end, "portRange.end");
  if (range.start > range.end) {
    throw new PortClaimAllocationError(
      "portRange.start must be less than or equal to portRange.end",
    );
  }
}

function candidatePorts(options: ClaimPortOptions): number[] {
  if (options.requestedPort !== undefined) {
    validatePort(options.requestedPort, "requestedPort");
    return [options.requestedPort];
  }

  const range = options.portRange;
  if (!range) {
    throw new PortClaimAllocationError(
      "Either requestedPort or portRange must be provided",
    );
  }

  validatePortRange(range);
  const ports: number[] = [];
  for (let port = range.start; port <= range.end; port += 1) {
    ports.push(port);
  }

  return ports;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return false;
    }

    throw error;
  }
}

async function readClaimRecord(
  claimsRoot: string,
  port: number,
): Promise<PortClaimRecord | undefined> {
  try {
    const source = await fs.readFile(claimRecordPath(claimsRoot, port), "utf8");
    return JSON.parse(source) as PortClaimRecord;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return undefined;
    }

    throw error;
  }
}

function makeClaimRecord(
  options: ClaimPortOptions,
  assignedPort: number,
): PortClaimRecord {
  const claimedAt = (options.now ?? (() => new Date()))().toISOString();
  const claimId = options.claimId ?? randomUUID();

  return {
    schemaVersion: portClaimSchemaVersion,
    claimId,
    projectId: options.projectId,
    ...(options.projectName ? { projectName: options.projectName } : {}),
    workspaceId: options.workspaceId,
    targetId: options.targetId,
    purpose: options.purpose,
    ...(options.imageId ? { imageId: options.imageId } : {}),
    ...(options.requestedPort !== undefined
      ? { requestedPort: options.requestedPort }
      : {}),
    assignedPort,
    ...(options.pid !== undefined ? { pid: options.pid } : {}),
    claimedAt,
  };
}

async function writeClaimRecord(
  claimsRoot: string,
  record: PortClaimRecord,
): Promise<void> {
  const directoryPath = claimDirectoryPath(claimsRoot, record.assignedPort);
  const tempPath = path.join(directoryPath, `.claim-${randomUUID()}.tmp`);
  await fs.writeFile(tempPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  await fs.rename(tempPath, claimRecordPath(claimsRoot, record.assignedPort));
}

async function removeClaimDirectory(
  claimsRoot: string,
  port: number,
): Promise<void> {
  await fs.rm(claimDirectoryPath(claimsRoot, port), {
    recursive: true,
    force: true,
  });
}

async function evaluateStaleness(
  claim: PortClaimRecord,
  options: {
    checks?: PortClaimChecks;
    now?: () => Date;
    staleAfterMs?: number;
  },
): Promise<StalenessEvaluation> {
  const portListening = await options.checks?.isPortListening?.(
    claim.assignedPort,
    claim,
  );
  if (portListening) {
    return {
      stale: false,
      reason: "port-listening",
    };
  }

  if (claim.pid !== undefined && options.checks?.isProcessAlive) {
    const processAlive = await options.checks.isProcessAlive(claim.pid, claim);
    if (!processAlive) {
      return {
        stale: true,
        reason: "process-dead",
      };
    }

    return {
      stale: false,
      reason: "process-alive",
    };
  }

  if (options.staleAfterMs !== undefined) {
    const ageMs =
      (options.now ?? (() => new Date()))().getTime() -
      new Date(claim.claimedAt).getTime();
    if (ageMs >= options.staleAfterMs) {
      return {
        stale: true,
        reason: "expired",
      };
    }
  }

  return {
    stale: false,
    reason: "unchecked",
  };
}

async function listClaimEntries(claimsRoot: string): Promise<ClaimEntry[]> {
  const directoryPath = claimsDirectoryPath(claimsRoot);
  if (!(await pathExists(directoryPath))) {
    return [];
  }

  const entries = await fs.readdir(directoryPath, { withFileTypes: true });
  const claimEntries = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
      .map(async (entry): Promise<ClaimEntry> => {
        const port = Number(entry.name);
        const directoryPath = claimDirectoryPath(claimsRoot, port);
        const stat = await fs.stat(directoryPath);
        try {
          return {
            port,
            updatedAtMs: stat.mtimeMs,
            record: await readClaimRecord(claimsRoot, port),
          };
        } catch {
          return {
            port,
            updatedAtMs: stat.mtimeMs,
          };
        }
      }),
  );

  return claimEntries.sort((left, right) => left.port - right.port);
}

async function handleExistingClaim(
  options: ClaimPortOptions,
  port: number,
): Promise<"retry" | "unavailable"> {
  let existingClaim: PortClaimRecord | undefined;
  try {
    existingClaim = await readClaimRecord(options.claimsRoot, port);
  } catch {
    return "unavailable";
  }

  if (!existingClaim) {
    return "unavailable";
  }

  const evaluation = await evaluateStaleness(existingClaim, options);
  if (!evaluation.stale) {
    return "unavailable";
  }

  const reaped = await releasePortClaim({
    claimsRoot: options.claimsRoot,
    claim: existingClaim,
  });

  return reaped.released ? "retry" : "unavailable";
}

async function tryClaimPort(
  options: ClaimPortOptions,
  port: number,
): Promise<PortClaimRecord | undefined> {
  const portListening = await options.checks?.isPortListening?.(port);
  if (portListening) {
    return undefined;
  }

  await fs.mkdir(claimsDirectoryPath(options.claimsRoot), { recursive: true });

  try {
    await fs.mkdir(claimDirectoryPath(options.claimsRoot, port));
  } catch (error) {
    if (isNodeError(error) && error.code === "EEXIST") {
      const action = await handleExistingClaim(options, port);
      if (action === "retry") {
        return tryClaimPort(options, port);
      }

      return undefined;
    }

    throw error;
  }

  const record = makeClaimRecord(options, port);
  try {
    await writeClaimRecord(options.claimsRoot, record);
  } catch (error) {
    await removeClaimDirectory(options.claimsRoot, port);
    throw error;
  }

  return record;
}

export async function claimPort(
  options: ClaimPortOptions,
): Promise<PortClaimRecord> {
  const candidates = candidatePorts(options);

  for (const port of candidates) {
    const record = await tryClaimPort(options, port);
    if (record) {
      return record;
    }
  }

  if (options.requestedPort !== undefined) {
    let existingClaim: PortClaimRecord | undefined;
    try {
      existingClaim = await readClaimRecord(
        options.claimsRoot,
        options.requestedPort,
      );
    } catch {
      existingClaim = undefined;
    }

    throw new PortClaimConflictError(
      options.requestedPort,
      `Port ${options.requestedPort} is already claimed or unavailable`,
      existingClaim,
    );
  }

  const range = options.portRange;
  throw new PortClaimAllocationError(
    range
      ? `No available port in range ${range.start}-${range.end}`
      : "No available port",
  );
}

export async function releasePortClaim(
  options: ReleasePortClaimOptions,
): Promise<PortClaimReleaseResult> {
  validatePort(options.claim.assignedPort, "claim.assignedPort");
  const currentClaim = await readClaimRecord(
    options.claimsRoot,
    options.claim.assignedPort,
  );
  if (!currentClaim) {
    return {
      released: false,
      port: options.claim.assignedPort,
      reason: "not-found",
    };
  }

  if (currentClaim.claimId !== options.claim.claimId) {
    return {
      released: false,
      port: options.claim.assignedPort,
      reason: "claim-mismatch",
      currentClaim,
    };
  }

  await removeClaimDirectory(options.claimsRoot, options.claim.assignedPort);
  return {
    released: true,
    port: options.claim.assignedPort,
  };
}

export async function updatePortClaim(
  options: UpdatePortClaimOptions,
): Promise<PortClaimRecord | undefined> {
  validatePort(options.claim.assignedPort, "claim.assignedPort");
  const currentClaim = await readClaimRecord(
    options.claimsRoot,
    options.claim.assignedPort,
  );
  if (!currentClaim || currentClaim.claimId !== options.claim.claimId) {
    return undefined;
  }

  const updatedClaim = options.update(currentClaim);
  if (
    updatedClaim.claimId !== currentClaim.claimId ||
    updatedClaim.assignedPort !== currentClaim.assignedPort
  ) {
    throw new PortClaimAllocationError(
      "Updated port claims must keep the same claimId and assignedPort",
    );
  }

  await writeClaimRecord(options.claimsRoot, updatedClaim);
  return updatedClaim;
}

export async function inspectPortClaim(
  options: InspectPortClaimOptions,
): Promise<PortClaimInspection> {
  validatePort(options.port);
  const directoryPath = claimDirectoryPath(options.claimsRoot, options.port);
  if (!(await pathExists(directoryPath))) {
    return {
      status: "available",
      port: options.port,
    };
  }

  let record: PortClaimRecord | undefined;
  try {
    record = await readClaimRecord(options.claimsRoot, options.port);
  } catch (error) {
    return {
      status: "unreadable",
      port: options.port,
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  if (!record) {
    return {
      status: "unreadable",
      port: options.port,
      reason: "missing claim record",
    };
  }

  const evaluation = await evaluateStaleness(record, options);
  return {
    status: evaluation.stale ? "stale" : "claimed",
    port: options.port,
    record,
    ...(evaluation.reason !== "unchecked" ? { reason: evaluation.reason } : {}),
  };
}

export async function listPortClaims(
  options: ListPortClaimsOptions,
): Promise<PortClaimRecord[]> {
  const entries = await listClaimEntries(options.claimsRoot);
  return entries
    .map((entry) => entry.record)
    .filter((record): record is PortClaimRecord => record !== undefined)
    .sort((left, right) => left.assignedPort - right.assignedPort);
}

export async function reapStalePortClaims(
  options: ReapStalePortClaimsOptions,
): Promise<ReapStalePortClaimsResult> {
  const entries = await listClaimEntries(options.claimsRoot);
  const reaped: PortClaimRecord[] = [];
  const kept: PortClaimKeptRecord[] = [];
  const removedOrphans: number[] = [];

  for (const entry of entries) {
    if (!entry.record) {
      const portListening = await options.checks?.isPortListening?.(entry.port);
      const ageMs =
        (options.now ?? (() => new Date()))().getTime() - entry.updatedAtMs;
      if (
        !portListening &&
        options.staleAfterMs !== undefined &&
        ageMs >= options.staleAfterMs
      ) {
        await removeClaimDirectory(options.claimsRoot, entry.port);
        removedOrphans.push(entry.port);
      }
      continue;
    }

    const evaluation = await evaluateStaleness(entry.record, options);
    if (!evaluation.stale) {
      kept.push({
        claim: entry.record,
        reason: evaluation.reason as PortClaimKeepReason,
      });
      continue;
    }

    const release = await releasePortClaim({
      claimsRoot: options.claimsRoot,
      claim: entry.record,
    });
    if (release.released) {
      reaped.push(entry.record);
    }
  }

  return {
    reaped,
    kept,
    removedOrphans,
  };
}

export async function withPortClaim<T>(
  options: ClaimPortOptions,
  operation: (claim: PortClaimRecord) => T | Promise<T>,
): Promise<T> {
  const claim = await claimPort(options);
  try {
    return await operation(claim);
  } finally {
    await releasePortClaim({
      claimsRoot: options.claimsRoot,
      claim,
    });
  }
}
