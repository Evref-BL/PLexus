import fs from "node:fs";
import path from "node:path";

export const plexusProjectConfigFileName = "plexus.project.json";

export interface ProjectKanbanConfig {
  provider: "vibe-kanban";
  projectId: string;
}

export interface ProjectImageMcpConfig {
  port?: number;
  loadScript: string;
}

export type ProjectImageGitTransport = "ssh" | "https" | "http";

export interface ProjectImageSshConfig {
  publicKey: string;
  privateKey: string;
}

export interface ProjectImagePlainCredentialsConfig {
  username: string;
  password: string;
}

export interface ProjectImageGitConfig {
  transport: ProjectImageGitTransport;
  ssh?: ProjectImageSshConfig;
  plainCredentials?: ProjectImagePlainCredentialsConfig;
}

export interface ProjectImageConfig {
  id: string;
  imageName: string;
  active: boolean;
  mcp: ProjectImageMcpConfig;
  git?: ProjectImageGitConfig;
}

export interface ProjectConfig {
  name: string;
  kanban: ProjectKanbanConfig;
  images: ProjectImageConfig[];
}

export type PlexusProjectConfig = ProjectConfig;

export class ProjectConfigError extends Error {
  constructor(
    message: string,
    public readonly issues: string[],
  ) {
    super(message);
    this.name = "ProjectConfigError";
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringField(
  object: Record<string, unknown>,
  key: string,
  issues: string[],
  pathPrefix: string,
): string {
  const value = object[key];
  if (typeof value === "string" && value.trim().length > 0) {
    return value;
  }

  issues.push(`${pathPrefix}.${key} must be a non-empty string`);
  return "";
}

function booleanField(
  object: Record<string, unknown>,
  key: string,
  issues: string[],
  pathPrefix: string,
): boolean {
  const value = object[key];
  if (typeof value === "boolean") {
    return value;
  }

  issues.push(`${pathPrefix}.${key} must be a boolean`);
  return false;
}

function optionalPortField(
  object: Record<string, unknown>,
  key: string,
  issues: string[],
  pathPrefix: string,
): number | undefined {
  const value = object[key];
  if (value === undefined) {
    return undefined;
  }

  if (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= 65_535
  ) {
    return value;
  }

  issues.push(`${pathPrefix}.${key} must be an integer between 1 and 65535`);
  return undefined;
}

function parseKanban(
  value: unknown,
  issues: string[],
): ProjectKanbanConfig {
  if (!isObject(value)) {
    issues.push("kanban must be an object");
    return { provider: "vibe-kanban", projectId: "" };
  }

  const provider = value.provider;
  if (provider !== "vibe-kanban") {
    issues.push("kanban.provider must be \"vibe-kanban\"");
  }

  return {
    provider: "vibe-kanban",
    projectId: stringField(value, "projectId", issues, "kanban"),
  };
}

function parseImageMcp(
  value: unknown,
  issues: string[],
  pathPrefix: string,
): ProjectImageMcpConfig {
  if (!isObject(value)) {
    issues.push(`${pathPrefix}.mcp must be an object`);
    return { loadScript: "" };
  }

  return {
    port: optionalPortField(value, "port", issues, `${pathPrefix}.mcp`),
    loadScript: stringField(value, "loadScript", issues, `${pathPrefix}.mcp`),
  };
}

function parseImageSshConfig(
  value: unknown,
  issues: string[],
  pathPrefix: string,
): ProjectImageSshConfig | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isObject(value)) {
    issues.push(`${pathPrefix}.ssh must be an object`);
    return undefined;
  }

  return {
    publicKey: stringField(value, "publicKey", issues, `${pathPrefix}.ssh`),
    privateKey: stringField(value, "privateKey", issues, `${pathPrefix}.ssh`),
  };
}

function parseImagePlainCredentialsConfig(
  value: unknown,
  issues: string[],
  pathPrefix: string,
): ProjectImagePlainCredentialsConfig | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isObject(value)) {
    issues.push(`${pathPrefix}.plainCredentials must be an object`);
    return undefined;
  }

  return {
    username: stringField(
      value,
      "username",
      issues,
      `${pathPrefix}.plainCredentials`,
    ),
    password: stringField(
      value,
      "password",
      issues,
      `${pathPrefix}.plainCredentials`,
    ),
  };
}

function parseImageGit(
  value: unknown,
  issues: string[],
  pathPrefix: string,
): ProjectImageGitConfig {
  if (value === undefined) {
    return { transport: "ssh" };
  }

  if (!isObject(value)) {
    issues.push(`${pathPrefix}.git must be an object`);
    return { transport: "ssh" };
  }

  const transportValue = value.transport ?? "ssh";
  const transport =
    transportValue === "ssh" ||
    transportValue === "https" ||
    transportValue === "http"
      ? transportValue
      : "ssh";

  if (transport !== transportValue) {
    issues.push(`${pathPrefix}.git.transport must be one of ssh, https, http`);
  }

  const ssh = parseImageSshConfig(value.ssh, issues, `${pathPrefix}.git`);
  const plainCredentials = parseImagePlainCredentialsConfig(
    value.plainCredentials,
    issues,
    `${pathPrefix}.git`,
  );
  if (transport === "ssh" && plainCredentials) {
    issues.push(`${pathPrefix}.git.plainCredentials can only be used with https or http`);
  }
  if (transport !== "ssh" && ssh) {
    issues.push(`${pathPrefix}.git.ssh can only be used with ssh`);
  }

  return {
    transport,
    ...(ssh ? { ssh } : {}),
    ...(plainCredentials ? { plainCredentials } : {}),
  };
}

function parseImages(
  value: unknown,
  issues: string[],
): ProjectImageConfig[] {
  if (!Array.isArray(value)) {
    issues.push("images must be an array");
    return [];
  }

  return value.map((image, index) => {
    const pathPrefix = `images[${index}]`;
    if (!isObject(image)) {
      issues.push(`${pathPrefix} must be an object`);
      return {
        id: "",
        imageName: "",
        active: false,
        mcp: { loadScript: "" },
        git: { transport: "ssh" },
      };
    }

    return {
      id: stringField(image, "id", issues, pathPrefix),
      imageName: stringField(image, "imageName", issues, pathPrefix),
      active: booleanField(image, "active", issues, pathPrefix),
      mcp: parseImageMcp(image.mcp, issues, pathPrefix),
      git: parseImageGit(image.git, issues, pathPrefix),
    };
  });
}

function collectDuplicates(
  values: string[],
  label: string,
  issues: string[],
): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (!value) {
      continue;
    }

    if (seen.has(value)) {
      issues.push(`${label} must be unique: ${value}`);
    } else {
      seen.add(value);
    }
  }
}

function collectDuplicatePorts(images: ProjectImageConfig[], issues: string[]): void {
  const seen = new Set<number>();
  for (const image of images) {
    const port = image.mcp.port;
    if (!port) {
      continue;
    }

    if (seen.has(port)) {
      issues.push(`image MCP ports must be unique: ${port}`);
    } else {
      seen.add(port);
    }
  }
}

export function parseProjectConfig(value: unknown): ProjectConfig {
  const issues: string[] = [];

  if (!isObject(value)) {
    throw new ProjectConfigError("Invalid Plexus project config", [
      "config must be an object",
    ]);
  }

  const config: ProjectConfig = {
    name: stringField(value, "name", issues, "config"),
    kanban: parseKanban(value.kanban, issues),
    images: parseImages(value.images, issues),
  };

  collectDuplicates(
    config.images.map((image) => image.id),
    "image ids",
    issues,
  );
  collectDuplicates(
    config.images.map((image) => image.imageName),
    "image names",
    issues,
  );
  collectDuplicatePorts(config.images, issues);

  if (issues.length > 0) {
    throw new ProjectConfigError("Invalid Plexus project config", issues);
  }

  return config;
}

export function projectConfigPath(projectRoot: string): string {
  return path.join(projectRoot, plexusProjectConfigFileName);
}

export function loadProjectConfig(projectRoot: string): ProjectConfig {
  const filePath = projectConfigPath(projectRoot);
  const raw = fs.readFileSync(filePath, "utf8");

  return parseProjectConfig(JSON.parse(raw));
}
