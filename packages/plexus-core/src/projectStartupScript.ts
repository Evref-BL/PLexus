import fs from "node:fs";
import path from "node:path";
import type { ProjectConfig, ProjectImageConfig } from "./projectConfig.js";
import {
  projectStateDirectoryPath,
  type ProjectImageState,
  type ProjectStatePathOptions,
} from "./projectState.js";

export const projectScriptsDirectoryName = "scripts";

export const defaultPharoMcpMetacelloRepository = {
  githubUser: "Evref-BL",
  project: "MCP",
  commitish: "develop",
  path: "",
  baseline: "MCP",
} as const;

export interface PharoMcpMetacelloRepository {
  githubUser: string;
  project: string;
  commitish: string;
  path: string;
  baseline: string;
}

export interface ProjectScriptsDirectoryPathOptions
  extends ProjectStatePathOptions {}

export interface ProjectImageStartupScriptPathOptions
  extends ProjectStatePathOptions {
  imageId: string;
}

export interface GenerateImageStartupScriptOptions {
  projectRoot: string;
  imageConfig: ProjectImageConfig;
  imageState: ProjectImageState;
  repository?: PharoMcpMetacelloRepository;
}

export interface WriteImageStartupScriptOptions
  extends GenerateImageStartupScriptOptions {
  projectId: string;
  workspaceId?: string;
  stateRoot?: string;
}

export interface WriteProjectImageStartupScriptOptions {
  projectRoot: string;
  config: ProjectConfig;
  imageId: string;
  imageState: ProjectImageState;
  workspaceId?: string;
  stateRoot?: string;
  repository?: PharoMcpMetacelloRepository;
}

export interface WrittenImageStartupScript {
  filePath: string;
  source: string;
}

export class ProjectStartupScriptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectStartupScriptError";
  }
}

export function projectScriptsDirectoryPath(
  options: ProjectScriptsDirectoryPathOptions,
): string {
  return path.join(projectStateDirectoryPath(options), projectScriptsDirectoryName);
}

export function imageStartupScriptFileName(imageId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(imageId)) {
    throw new ProjectStartupScriptError(
      `Image id must be file-safe to generate a startup script: ${imageId}`,
    );
  }

  return `start-${imageId}.st`;
}

export function imageStartupScriptPath(
  options: ProjectImageStartupScriptPathOptions,
): string {
  return path.join(
    projectScriptsDirectoryPath(options),
    imageStartupScriptFileName(options.imageId),
  );
}

function smalltalkString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function smalltalkPath(value: string): string {
  return smalltalkString(value.replace(/\\/g, "/"));
}

function generateGitConfigurationScript(imageConfig: ProjectImageConfig): string {
  const git = imageConfig.git ?? { transport: "ssh" as const };
  const requiresCredentialsProvider = Boolean(
    imageConfig.git?.ssh || imageConfig.git?.plainCredentials,
  );
  const lines = [
    `"Configure image-local Git transport and credentials."`,
    `Smalltalk globals at: #PLexusGitTransport put: ${smalltalkString(git.transport)}.`,
    `(Smalltalk globals includesKey: #Iceberg) ifTrue: [`,
    `  (Smalltalk globals at: #Iceberg) enableMetacelloIntegration: true ].`,
    `(Smalltalk globals includesKey: #IceCredentialsProvider)`,
    `  ifTrue: [`,
    `  | credentialsProvider |`,
    `  credentialsProvider := Smalltalk globals at: #IceCredentialsProvider.`,
  ];

  if (git.transport === "ssh") {
    if (git.ssh) {
      lines.push(
        `  credentialsProvider useCustomSsh: true.`,
        `  credentialsProvider sshCredentials`,
        `    username: 'git';`,
        `    publicKey: ${smalltalkPath(git.ssh.publicKey)};`,
        `    privateKey: ${smalltalkPath(git.ssh.privateKey)}.`,
      );
    } else {
      lines.push(
        `  "Use the image or platform SSH agent/defaults unless explicit keys are configured."`,
        `  credentialsProvider useCustomSsh: false.`,
      );
    }
  } else {
    lines.push(`  credentialsProvider useCustomSsh: false.`);

    if (git.plainCredentials) {
      lines.push(
        `  (Smalltalk globals includesKey: #IcePlaintextCredentials)`,
        `    ifTrue: [`,
        `      credentialsProvider plaintextCredentials: ((Smalltalk globals at: #IcePlaintextCredentials) new`,
        `        username: ${smalltalkString(git.plainCredentials.username)};`,
        `        password: ${smalltalkString(git.plainCredentials.password)};`,
        `        yourself) ]`,
        `    ifFalse: [ Error signal: 'IcePlaintextCredentials class is not available.' ].`,
      );
    }
  }

  lines.push(`]`);
  if (requiresCredentialsProvider) {
    lines.push(`  ifFalse: [ Error signal: 'IceCredentialsProvider class is not available.' ].`);
  } else {
    lines.push(`  ifFalse: [ nil ].`);
  }

  return lines.join("\n");
}

function resolveLoadScriptPath(
  projectRoot: string,
  imageConfig: ProjectImageConfig,
): string {
  return path.isAbsolute(imageConfig.mcp.loadScript)
    ? imageConfig.mcp.loadScript
    : path.resolve(projectRoot, imageConfig.mcp.loadScript);
}

function findProjectImageConfig(
  config: ProjectConfig,
  imageId: string,
): ProjectImageConfig {
  const imageConfig = config.images.find((image) => image.id === imageId);
  if (!imageConfig) {
    throw new ProjectStartupScriptError(
      `Project config does not define image id: ${imageId}`,
    );
  }

  return imageConfig;
}

export function generateImageStartupScript(
  options: GenerateImageStartupScriptOptions,
): string {
  const repository = options.repository ?? defaultPharoMcpMetacelloRepository;
  const loadScriptPath = resolveLoadScriptPath(
    options.projectRoot,
    options.imageConfig,
  );
  const gitConfiguration = generateGitConfigurationScript(options.imageConfig);

  return `"Generated by PLexus. Do not edit."

| loadScript mcp |

${gitConfiguration}

"Load the Pharo MCP project if the image does not already provide it."
(Smalltalk globals includesKey: #MCP) ifFalse: [
  loadScript := ${smalltalkPath(loadScriptPath)} asFileReference.
  loadScript exists
    ifTrue: [ loadScript fileIn ]
    ifFalse: [
      Metacello new
        githubUser: ${smalltalkString(repository.githubUser)} project: ${smalltalkString(repository.project)} commitish: ${smalltalkString(repository.commitish)} path: ${smalltalkString(repository.path)};
        baseline: ${smalltalkString(repository.baseline)};
        load ] ].

(Smalltalk globals includesKey: #MCP)
  ifFalse: [ Error signal: 'MCP class is not available after loading.' ].

"Stop the previous server registered by PLexus before starting a new one."
(Smalltalk globals at: #PLexusMCPServer ifAbsent: [ nil ])
  ifNotNil: [ :existingServer |
    [ existingServer stop ] on: Error do: [ :error | nil ] ].

"Configure and start the MCP server."
mcp := (Smalltalk globals at: #MCP) new.
mcp port: ${options.imageState.assignedPort}.
mcp start.

Smalltalk globals at: #PLexusMCPServer put: mcp.
`;
}

export function writeImageStartupScript(
  options: WriteImageStartupScriptOptions,
): WrittenImageStartupScript {
  const filePath = imageStartupScriptPath({
    projectRoot: options.projectRoot,
    projectId: options.projectId,
    workspaceId: options.workspaceId,
    imageId: options.imageConfig.id,
    stateRoot: options.stateRoot,
  });
  const source = generateImageStartupScript(options);

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, source, "utf8");

  return { filePath, source };
}

export function writeProjectImageStartupScript(
  options: WriteProjectImageStartupScriptOptions,
): WrittenImageStartupScript {
  const imageConfig = findProjectImageConfig(options.config, options.imageId);

  return writeImageStartupScript({
    projectRoot: options.projectRoot,
    projectId: options.config.kanban.projectId,
    imageConfig,
    imageState: options.imageState,
    workspaceId: options.workspaceId,
    stateRoot: options.stateRoot,
    repository: options.repository,
  });
}
