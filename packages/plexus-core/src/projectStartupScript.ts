import fs from "node:fs";
import {
  projectConfigId,
  type ProjectConfig,
  type ProjectImageConfig,
  type ProjectImageGitTransport,
  type ProjectImageSshConfig,
} from "./projectConfig.js";
import {
  dirnamePathLike,
  isAbsolutePathLike,
  joinPathLike,
  resolvePathLike,
} from "./pathStyle.js";
import {
  projectStateDirectoryPath,
  projectStateRootForConfig,
  type ProjectImageState,
  type ProjectStatePathOptions,
} from "./projectState.js";
import { imageMcpEndpointHandoffPath } from "./projectImageMcpEndpoint.js";

export const projectScriptsDirectoryName = "scripts";

export const defaultPharoMcpMetacelloRepository = {
  githubUser: "Evref-BL",
  project: "MCP",
  commitish: "main",
  path: "src",
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
  endpointHandoffPath?: string;
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
  return joinPathLike(
    projectStateDirectoryPath(options),
    projectScriptsDirectoryName,
  );
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
  return joinPathLike(
    projectScriptsDirectoryPath(options),
    imageStartupScriptFileName(options.imageId),
  );
}

function smalltalkString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function smalltalkComment(value: string): string {
  return `"${value.replaceAll("\"", "\"\"")}"`;
}

function smalltalkPath(value: string): string {
  return smalltalkString(value.replace(/\\/g, "/"));
}

function icebergRemoteTypeSelector(
  transport: ProjectImageGitTransport,
): string {
  switch (transport) {
    case "http":
      return "#httpUrl";
    case "https":
      return "#httpsUrl";
    case "ssh":
      return "#scpUrl";
  }
}

function sshUsername(ssh: ProjectImageSshConfig | undefined): string {
  return ssh?.username ?? "git";
}

function sshHasCustomKeys(ssh: ProjectImageSshConfig | undefined): boolean {
  return Boolean(ssh?.publicKey && ssh.privateKey);
}

function sshRemoteUrlPrefix(
  ssh: ProjectImageSshConfig | undefined,
): string | undefined {
  if (!ssh?.host) {
    return undefined;
  }

  return `ssh://${sshUsername(ssh)}@${ssh.host}${ssh.port ? `:${ssh.port}` : ""}/`;
}

function generateGitHubSshRemoteScript(
  ssh: ProjectImageSshConfig | undefined,
): string[] {
  const remoteUrlPrefix = sshRemoteUrlPrefix(ssh);
  if (!remoteUrlPrefix) {
    return [];
  }

  const remoteTemplate = `${remoteUrlPrefix}{projectPath}.git`;
  const methodSource = [
    "scpUrl",
    `\t^ ${smalltalkString(remoteUrlPrefix)}, projectPath, '.git'`,
  ].join("\n");

  return [
    `Smalltalk globals at: #PLexusGitSshRemoteTemplate put: ${smalltalkString(remoteTemplate)}.`,
    `(Smalltalk globals includesKey: #MCGitHubRepository)`,
    `  ifTrue: [`,
    `    (Smalltalk globals at: #MCGitHubRepository)`,
    `      compile: ${smalltalkString(methodSource)}`,
    `      classified: 'accessing' ]`,
    `  ifFalse: [ Error signal: 'MCGitHubRepository class is not available for explicit SSH GitHub remote configuration.' ].`,
  ];
}

function generateGitConfigurationScript(imageConfig: ProjectImageConfig): string {
  if (!imageConfig.git) {
    return "";
  }

  const git = imageConfig.git;
  const hasCustomSshKeys = sshHasCustomKeys(git.ssh);
  const requiresCredentialsProvider = Boolean(
    hasCustomSshKeys || git.plainCredentials,
  );
  const lines = [
    `"Configure image-local Git transport and credentials."`,
    `Smalltalk globals at: #PLexusGitTransport put: ${smalltalkString(git.transport)}.`,
    `(Smalltalk globals includesKey: #Iceberg)`,
    `  ifTrue: [ (Smalltalk globals at: #Iceberg) remoteTypeSelector: ${icebergRemoteTypeSelector(git.transport)}. ]`,
    `  ifFalse: [ nil ].`,
    ...generateGitHubSshRemoteScript(git.transport === "ssh" ? git.ssh : undefined),
    `(Smalltalk globals includesKey: #IceCredentialsProvider)`,
    `  ifTrue: [`,
    `  | credentialsProvider |`,
    `  credentialsProvider := Smalltalk globals at: #IceCredentialsProvider.`,
  ];

  if (git.transport === "ssh") {
    if (hasCustomSshKeys) {
      lines.push(
        `  credentialsProvider useCustomSsh: true.`,
        `  credentialsProvider sshCredentials`,
        `    username: ${smalltalkString(sshUsername(git.ssh))};`,
        `    publicKey: ${smalltalkPath(git.ssh!.publicKey!)};`,
        `    privateKey: ${smalltalkPath(git.ssh!.privateKey!)}.`,
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
  return isAbsolutePathLike(imageConfig.mcp.loadScript)
    ? resolvePathLike(imageConfig.mcp.loadScript)
    : resolvePathLike(projectRoot, imageConfig.mcp.loadScript);
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

function generateEndpointHandoffStartupScript(options: {
  assignedPort?: number;
  endpointHandoffPath: string;
}): string {
  const fallbackScript =
    options.assignedPort === undefined
      ? [
          `    Error signal: 'MCP endpoint handoff is required, but this image-side MCP does not support bindToLoopback/endpoint.'`,
        ]
      : [
          `    mcp port: ${options.assignedPort}.`,
          `    mcp start.`,
        ];

  return [
    `"Configure and start the MCP server. Prefer endpoint auto-bind when the image-side MCP supports it."`,
    `mcp := (Smalltalk globals at: #MCP) new.`,
    `endpointFile := ${smalltalkPath(options.endpointHandoffPath)} asFileReference.`,
    `endpointFile exists ifTrue: [ endpointFile delete ].`,
    ``,
    `((mcp respondsTo: #bindToLoopback) and: [ mcp respondsTo: #endpoint ])`,
    `  ifTrue: [`,
    `    mcp bindToLoopback.`,
    `    mcp port: 0.`,
    `    mcp start.`,
    `    endpoint := mcp endpoint.`,
    `    endpointValue := [ :key :fallback |`,
    `      endpoint`,
    `        at: key`,
    `        ifAbsent: [ endpoint at: key asString ifAbsent: [ fallback ] ] ].`,
    `    endpointTransport := (endpointValue value: #transport value: 'http') asString.`,
    `    endpointHost := (endpointValue value: #host value: '127.0.0.1') asString.`,
    `    endpointPort := endpointValue value: #port value: nil.`,
    `    endpointPath := (endpointValue value: #path value: '/') asString.`,
    `    endpointFile parent ensureCreateDirectory.`,
    `    endpointFile writeStreamDo: [ :stream |`,
    `      stream nextPutAll: 'transport='; nextPutAll: endpointTransport; cr.`,
    `      stream nextPutAll: 'host='; nextPutAll: endpointHost; cr.`,
    `      stream nextPutAll: 'port='; nextPutAll: endpointPort asString; cr.`,
    `      stream nextPutAll: 'path='; nextPutAll: endpointPath; cr ] ]`,
    `  ifFalse: [`,
    ...fallbackScript,
    `  ].`,
  ].join("\n");
}

export function generateImageStartupScript(
  options: GenerateImageStartupScriptOptions,
): string {
  if (options.imageState.pharoMcpContract?.status === "unsupported") {
    const reason =
      options.imageState.pharoMcpContract.reason ??
      "This image Pharo version is outside the supported Pharo MCP range.";

    return `"Generated by PLexus. Do not edit."

${smalltalkComment(`Pharo MCP startup is disabled: ${reason}`)}
${smalltalkComment("Keep the headless eval process alive for project lifecycle management only.")}
Semaphore new wait.
`;
  }

  const preferEndpointHandoff =
    options.endpointHandoffPath !== undefined &&
    options.imageConfig.mcp.port === undefined;

  if (
    options.imageState.assignedPort === undefined &&
    !preferEndpointHandoff
  ) {
    throw new ProjectStartupScriptError(
      `Project image ${options.imageState.id} requires Pharo MCP startup but has no assigned MCP port`,
    );
  }

  const repository = options.repository ?? defaultPharoMcpMetacelloRepository;
  const loadScriptPath = resolveLoadScriptPath(
    options.projectRoot,
    options.imageConfig,
  );
  const gitConfiguration = generateGitConfigurationScript(options.imageConfig);

  const mcpStartup = preferEndpointHandoff
    ? generateEndpointHandoffStartupScript({
        assignedPort: options.imageState.assignedPort,
        endpointHandoffPath: options.endpointHandoffPath!,
      })
    : [
        `"Configure and start the MCP server."`,
        `mcp := (Smalltalk globals at: #MCP) new.`,
        `mcp port: ${options.imageState.assignedPort}.`,
        `mcp start.`,
      ].join("\n");

  return `"Generated by PLexus. Do not edit."

| loadScript mcp endpointFile endpoint endpointValue endpointTransport endpointHost endpointPort endpointPath |

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

${mcpStartup}

Smalltalk globals at: #PLexusMCPServer put: mcp.

"Keep the headless eval process alive while the MCP server accepts requests."
Semaphore new wait.
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

  fs.mkdirSync(dirnamePathLike(filePath), { recursive: true });
  fs.writeFileSync(filePath, source, "utf8");

  return { filePath, source };
}

export function writeProjectImageStartupScript(
  options: WriteProjectImageStartupScriptOptions,
): WrittenImageStartupScript {
  const imageConfig = findProjectImageConfig(options.config, options.imageId);

  return writeImageStartupScript({
    projectRoot: options.projectRoot,
    projectId: projectConfigId(options.config),
    imageConfig,
    imageState: options.imageState,
    endpointHandoffPath: imageMcpEndpointHandoffPath({
      projectRoot: options.projectRoot,
      projectId: projectConfigId(options.config),
      workspaceId: options.workspaceId,
      imageId: options.imageId,
      stateRoot: projectStateRootForConfig(options.config, options.stateRoot),
    }),
    workspaceId: options.workspaceId,
    stateRoot: projectStateRootForConfig(options.config, options.stateRoot),
    repository: options.repository,
  });
}
