export type TargetStatus =
  | "created"
  | "starting"
  | "running"
  | "stopped"
  | "stale"
  | "failed";

export interface PlexusTarget {
  targetId: string;
  imageName: string;
  imagePath?: string;
  changesPath?: string;
  vmPath?: string;
  worktreePath: string;
  branch: string;
  commit?: string;
  pid?: number;
  port?: number;
  token?: string;
  status: TargetStatus;
  lastHealthCheck?: string;
  createdAt: string;
  updatedAt: string;
}

