import fs from "node:fs";
import {
  projectConfigId,
  projectMcpLoadPolicy,
  projectMcpStartupMode,
  type ProjectConfig,
  type ProjectHomeDependencyRepositoryNetworkPolicy,
  type ProjectImageConfig,
  type ProjectImageGitTransport,
  type ProjectImageSshConfig,
} from "./projectConfig.js";
import {
  homeDependencyRepositoryCachePath,
  homeDependencyRepositoryNetworkPolicy,
  resolvePlexusHomePath,
} from "./plexusHome.js";
import {
  dirnamePathLike,
  isAbsolutePathLike,
  joinPathLike,
  resolvePathLike,
  sanitizePathSegment,
} from "./pathStyle.js";
import {
  projectImageRepositoryWorkspaces,
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
  sourcePath?: string;
  imageConfig: ProjectImageConfig;
  imageState: ProjectImageState;
  endpointHandoffPath?: string;
  pharoMcpLoadStatusPath?: string;
  repositoryWorkspaceLoadStatusPath?: string;
  repositoryWorkspaceLoadStatusPaths?: Record<string, string>;
  dependencyRepositoryDetachStatusPath?: string;
  dependencyRepositoryCachePath?: string;
  dependencyRepositoryNetworkPolicy?: ProjectHomeDependencyRepositoryNetworkPolicy;
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
  sourcePath?: string;
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
  pharoMcpLoadStatusPath?: string;
  repositoryWorkspaceLoadStatusPath?: string;
  repositoryWorkspaceLoadStatusPaths?: Record<string, string>;
  dependencyRepositoryDetachStatusPath?: string;
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

export function imageRepositoryWorkspaceLoadStatusPath(
  options: ProjectImageStartupScriptPathOptions & { repositoryId?: string },
): string {
  const imageScriptName = imageStartupScriptFileName(options.imageId)
    .replace(/^start-/, "")
    .replace(/\.st$/, ".properties");
  const repositorySuffix = options.repositoryId
    ? `-${statusPathSegment(options.repositoryId)}`
    : "";
  return joinPathLike(
    projectScriptsDirectoryPath(options),
    `repository-workspace-load-${imageScriptName.replace(
      /\.properties$/,
      `${repositorySuffix}.properties`,
    )}`,
  );
}

function statusPathSegment(value: string): string {
  return sanitizePathSegment(value, "repo");
}

export function imagePharoMcpLoadStatusPath(
  options: ProjectImageStartupScriptPathOptions,
): string {
  const imageScriptName = imageStartupScriptFileName(options.imageId)
    .replace(/^start-/, "")
    .replace(/\.st$/, ".properties");
  return joinPathLike(
    projectScriptsDirectoryPath(options),
    `pharo-mcp-load-${imageScriptName}`,
  );
}

export function imageDependencyRepositoryDetachStatusPath(
  options: ProjectImageStartupScriptPathOptions,
): string {
  const imageScriptName = imageStartupScriptFileName(options.imageId)
    .replace(/^start-/, "")
    .replace(/\.st$/, ".properties");
  return joinPathLike(
    projectScriptsDirectoryPath(options),
    `dependency-repository-detach-${imageScriptName}`,
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
  sourcePath: string | undefined,
  imageConfig: ProjectImageConfig,
): string {
  return isAbsolutePathLike(imageConfig.mcp.loadScript)
    ? resolvePathLike(imageConfig.mcp.loadScript)
    : resolvePathLike(sourcePath ?? projectRoot, imageConfig.mcp.loadScript);
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

function generateRepositoryWorkspaceLoadScript(options: {
  imageState: ProjectImageState;
  loadStatusPath?: string;
  loadStatusPaths?: Record<string, string>;
}): string {
  const workspaces = projectImageRepositoryWorkspaces(options.imageState);
  if (workspaces.length === 0) {
    return "";
  }

  return workspaces
    .map((workspace) => {
      const loadStatusPath =
        options.loadStatusPaths?.[workspace.repository.id] ??
        (workspaces.length === 1 ? options.loadStatusPath : undefined);
      if (!loadStatusPath) {
        return "";
      }

  const sourcePath = joinPathLike(workspace.path, workspace.sourceDirectory);
  const loadCommand = workspace.loadGroup
    ? `        load: (Array with: ${smalltalkString(workspace.loadGroup)})`
    : `        load`;
  const currentCommitLine = workspace.currentCommit
    ? [
        `      stream`,
        `        nextPutAll: 'currentCommit=';`,
        `        nextPutAll: ${smalltalkString(workspace.currentCommit)};`,
        `        cr.`,
      ].join("\n")
    : "";

  return `
"Load the configured Pharo project from the image-local repository workspace."
repositoryLoadStatusFile := ${smalltalkPath(loadStatusPath)} asFileReference.
repositorySourcePath := ${smalltalkPath(sourcePath)}.
repositoryLoadStatusFile exists ifTrue: [ repositoryLoadStatusFile delete ].
repositoryLoadStatusWriter := [ :status :message |
  repositoryLoadStatusFile parent ensureCreateDirectory.
  repositoryLoadStatusFile writeStreamDo: [ :stream |
    stream
      nextPutAll: 'status=';
      nextPutAll: status;
      cr.
    stream
      nextPutAll: 'repositoryId=';
      nextPutAll: ${smalltalkString(workspace.repository.id)};
      cr.
    stream
      nextPutAll: 'sourcePath=';
      nextPutAll: repositorySourcePath;
      cr.
    stream
      nextPutAll: 'sourceDirectory=';
      nextPutAll: ${smalltalkString(workspace.sourceDirectory)};
      cr.
    stream
      nextPutAll: 'baseline=';
      nextPutAll: ${smalltalkString(workspace.baseline)};
      cr.
${workspace.loadGroup
    ? `    stream
      nextPutAll: 'loadGroup=';
      nextPutAll: ${smalltalkString(workspace.loadGroup)};
      cr.
`
    : ""}${currentCommitLine ? `${currentCommitLine}\n` : ""}    message ifNotNil: [
      stream
        nextPutAll: 'message=';
        nextPutAll: message asString;
        cr ] ] ].
[
  repositorySourceDirectory := repositorySourcePath asFileReference.
  repositorySourceDirectory exists
    ifFalse: [ Error signal: 'Configured Pharo project source directory does not exist: ', repositorySourcePath ].
  Metacello new
    repository: 'tonel://', repositorySourceDirectory fullName;
    baseline: ${smalltalkString(workspace.baseline)};
    onConflictUseIncoming;
    onUpgrade: [ :ex :loaded :incoming | ex useIncoming ];
${loadCommand}.
  repositoryLoadStatusWriter value: 'loaded' value: nil
] on: Error do: [ :error |
  repositoryLoadStatusWriter value: 'failed' value: error description.
  error pass ].
`;
    })
    .filter((script) => script.length > 0)
    .join("\n");
}

function generateDependencyRepositoryCacheSetupScript(options: {
  cachePath?: string;
  networkPolicy?: ProjectHomeDependencyRepositoryNetworkPolicy;
}): string {
  if (!options.cachePath) {
    return "";
  }

  const networkPolicy = options.networkPolicy ?? "online";
  return `
"Configure the PLexus-owned dependency repository cache for Metacello/Iceberg."
plexusDependencyRepositoryCachePath := ${smalltalkPath(options.cachePath)}.
plexusDependencyRepositoryNetworkPolicy := ${smalltalkString(networkPolicy)}.
plexusDependencyRepositoryCachePath asFileReference ensureCreateDirectory.
Smalltalk globals
  at: #PLexusDependencyRepositoryCachePath
  put: plexusDependencyRepositoryCachePath.
Smalltalk globals
  at: #PLexusDependencyRepositoryNetworkPolicy
  put: plexusDependencyRepositoryNetworkPolicy.
[
  Iceberg enableMetacelloIntegration: true.
  IceLibgitRepository
    shareRepositoriesBetweenImages: true;
    sharedRepositoriesLocationString: plexusDependencyRepositoryCachePath
]
  on: Error
  do: [ :error |
    Error signal:
      'PLexus dependency repository cache setup failed: ', error description ].
`;
}

function generateDependencyRepositoryDetachScript(options: {
  cachePath?: string;
  statusPath?: string;
  editableRepositoryPaths?: string[];
}): string {
  if (!options.cachePath || !options.statusPath) {
    return "";
  }

  const editableRepositoryPaths = options.editableRepositoryPaths ?? [];
  const editablePathsLiteral =
    editableRepositoryPaths.length === 0
      ? "#()"
      : `{ ${editableRepositoryPaths
          .map((repositoryPath) => smalltalkPath(repositoryPath))
          .join(". ")} }`;

  return `
"Detach shared dependency repositories that PLexus loaded from the home cache."
plexusDependencyRepositoryDetachStatusFile := ${smalltalkPath(options.statusPath)} asFileReference.
plexusDependencyRepositoryDetachStatusFile exists
  ifTrue: [ plexusDependencyRepositoryDetachStatusFile delete ].
plexusDependencyRepositoryCachePath := ${smalltalkPath(options.cachePath)}.
plexusEditableRepositoryPaths := ${editablePathsLiteral}.
plexusNormalizePath := [ :path |
  | normalized |
  normalized := path ifNil: [ '' ] ifNotNil: [
    path asString copyReplaceAll: '\\' with: '/' ].
  [ normalized notEmpty and: [ normalized last = $/ ] ]
    whileTrue: [ normalized := normalized allButLast ].
  normalized ].
plexusRepositoryLocationString := [ :repository |
  plexusNormalizePath value: ([
    repository location fullName ]
      on: Error
      do: [ :ignored |
        [ repository location asString ]
          on: Error
          do: [ :secondIgnored | '' ] ]) ].
plexusRepositoryNameString := [ :repository |
  [ repository name asString ]
    on: Error
    do: [ :ignored | '' ] ].
plexusDependencyRepositoryDetachStatusWriter := [ :status :message :detachedRepositories |
  plexusDependencyRepositoryDetachStatusFile parent ensureCreateDirectory.
  plexusDependencyRepositoryDetachStatusFile writeStreamDo: [ :stream |
    stream
      nextPutAll: 'status=';
      nextPutAll: status;
      cr.
    stream
      nextPutAll: 'cachePath=';
      nextPutAll: (plexusNormalizePath value: plexusDependencyRepositoryCachePath);
      cr.
    stream
      nextPutAll: 'detachedCount=';
      nextPutAll: detachedRepositories size asString;
      cr.
    message ifNotNil: [
      stream
        nextPutAll: 'message=';
        nextPutAll: message asString;
        cr ].
    detachedRepositories withIndexDo: [ :repository :index |
      stream
        nextPutAll: 'repository.';
        nextPutAll: index asString;
        nextPutAll: '.name=';
        nextPutAll: (plexusRepositoryNameString value: repository);
        cr.
      stream
        nextPutAll: 'repository.';
        nextPutAll: index asString;
        nextPutAll: '.location=';
        nextPutAll: (plexusRepositoryLocationString value: repository);
        cr ] ] ].
(Smalltalk globals includesKey: #IceRepository)
  ifTrue: [
    [
      | cachePath editablePaths repositoriesToDetach |
      cachePath := plexusNormalizePath value: plexusDependencyRepositoryCachePath.
      editablePaths := plexusEditableRepositoryPaths collect: [ :each |
        plexusNormalizePath value: each ].
      repositoriesToDetach := OrderedCollection new.
      (Smalltalk globals at: #IceRepository) registry do: [ :repository |
        | repositoryLocation isInCache isEditable |
        repositoryLocation := plexusRepositoryLocationString value: repository.
        isInCache := repositoryLocation = cachePath or: [
          repositoryLocation beginsWith: cachePath , '/' ].
        isEditable := editablePaths includes: repositoryLocation.
        (isInCache and: [ isEditable not ])
          ifTrue: [ repositoriesToDetach add: repository ] ].
      repositoriesToDetach do: [ :repository |
        (Smalltalk globals at: #IceRepository) registry
          remove: repository
          ifAbsent: [  ] ].
      plexusDependencyRepositoryDetachStatusWriter
        value: 'detached'
        value: nil
        value: repositoriesToDetach ]
      on: Error
      do: [ :error |
        plexusDependencyRepositoryDetachStatusWriter
          value: 'failed'
          value: error description
          value: #(  ).
        error pass ] ]
  ifFalse: [
    plexusDependencyRepositoryDetachStatusWriter
      value: 'skipped'
      value: 'IceRepository is not available.'
      value: #(  ) ].
`;
}

function generatePharoMcpLoadScript(options: {
  imageId: string;
  loadScriptPath?: string;
  repository: PharoMcpMetacelloRepository;
  statusPath?: string;
  failureBehavior?: "throw" | "record";
  loadPolicy?: "ifMissing" | "always" | "never";
}): string {
  const repositoryLabel = `github://${options.repository.githubUser}/${options.repository.project}:${options.repository.commitish}/${options.repository.path}`;
  const shouldThrowOnFailure = options.failureBehavior !== "record";
  const failureHandler = shouldThrowOnFailure
    ? `    error pass`
    : `    "Optional Pharo MCP startup records the failure and leaves the image process alive."`;
  const loadPolicy = options.loadPolicy ?? "ifMissing";
  const loadScriptPath = options.loadScriptPath;

  if (loadPolicy !== "never" && loadScriptPath === undefined) {
    throw new ProjectStartupScriptError(
      `Project image ${options.imageId} requires mcp.loadScript unless mcp.loadPolicy is never`,
    );
  }

  if (!options.statusPath) {
    const loadScript =
      loadPolicy === "never"
        ? `"Use the Pharo MCP project already present in the image."
(Smalltalk globals includesKey: #MCP)
  ifFalse: [ Error signal: 'MCP class is not available because mcp.loadPolicy is never.' ].`
        : `"Load the Pharo MCP project if configured policy requires it."
pharoMcpLoadPolicy := ${smalltalkString(loadPolicy)}.
(pharoMcpLoadPolicy = 'always' or: [
  (Smalltalk globals includesKey: #MCP) not ]) ifTrue: [
  loadScript := ${smalltalkPath(loadScriptPath!)} asFileReference.
  loadScript exists
    ifTrue: [ loadScript fileIn ]
    ifFalse: [
      Metacello new
        githubUser: ${smalltalkString(options.repository.githubUser)} project: ${smalltalkString(options.repository.project)} commitish: ${smalltalkString(options.repository.commitish)} path: ${smalltalkString(options.repository.path)};
        baseline: ${smalltalkString(options.repository.baseline)};
        load ] ].

(Smalltalk globals includesKey: #MCP)
  ifFalse: [ Error signal: 'MCP class is not available after loading.' ].`;
    return shouldThrowOnFailure
      ? loadScript
      : `[
${loadScript}
] on: Error do: [ :error |
  "Optional Pharo MCP startup has no status path, so the failure is only kept in-image."
].`;
  }

  const loadScriptStatusLines =
    loadScriptPath === undefined
      ? ""
      : `    stream
      nextPutAll: 'loadScript=';
      nextPutAll: ${smalltalkPath(loadScriptPath)};
      cr.`;
  const loadAction =
    loadPolicy === "never"
      ? `  pharoMcpLoadSource := 'provided'.
  (Smalltalk globals includesKey: #MCP)
    ifTrue: [ pharoMcpLoadStatusWriter value: 'provided' value: nil ]
    ifFalse: [ Error signal: 'MCP class is not available because mcp.loadPolicy is never.' ]`
      : `  (pharoMcpLoadPolicy = 'ifMissing' and: [ Smalltalk globals includesKey: #MCP ])
    ifTrue: [
      pharoMcpLoadSource := 'provided'.
      pharoMcpLoadStatusWriter value: 'provided' value: nil ]
    ifFalse: [
      loadScript := ${smalltalkPath(loadScriptPath!)} asFileReference.
      loadScript exists
        ifTrue: [
          pharoMcpLoadSource := 'loadScript'.
          loadScript fileIn ]
        ifFalse: [
          pharoMcpLoadSource := 'metacello'.
          Metacello new
            githubUser: ${smalltalkString(options.repository.githubUser)} project: ${smalltalkString(options.repository.project)} commitish: ${smalltalkString(options.repository.commitish)} path: ${smalltalkString(options.repository.path)};
            baseline: ${smalltalkString(options.repository.baseline)};
            load ].
      (Smalltalk globals includesKey: #MCP)
        ifFalse: [ Error signal: 'MCP class is not available after loading.' ].
      pharoMcpLoadStatusWriter value: 'loaded' value: nil ]`;

  return `"Load the Pharo MCP project according to mcp.loadPolicy."
pharoMcpLoadStatusFile := ${smalltalkPath(options.statusPath)} asFileReference.
pharoMcpLoadStatusFile exists ifTrue: [ pharoMcpLoadStatusFile delete ].
pharoMcpLoadPolicy := ${smalltalkString(loadPolicy)}.
pharoMcpLoadSource := 'pending'.
pharoMcpLoadStatusWriter := [ :status :message |
  pharoMcpLoadStatusFile parent ensureCreateDirectory.
  pharoMcpLoadStatusFile writeStreamDo: [ :stream |
    stream
      nextPutAll: 'status=';
      nextPutAll: status;
      cr.
    stream
      nextPutAll: 'imageId=';
      nextPutAll: ${smalltalkString(options.imageId)};
      cr.
    stream
      nextPutAll: 'source=';
      nextPutAll: (pharoMcpLoadSource ifNil: [ 'unknown' ]);
      cr.
${loadScriptStatusLines}
    stream
      nextPutAll: 'loadPolicy=';
      nextPutAll: pharoMcpLoadPolicy;
      cr.
    pharoMcpLoadSource = 'metacello'
      ifTrue: [
        stream
          nextPutAll: 'repository=';
          nextPutAll: ${smalltalkString(repositoryLabel)};
          cr ]
      ifFalse: [
        stream
          nextPutAll: 'configuredRepositoryHint=';
          nextPutAll: ${smalltalkString(repositoryLabel)};
          cr ].
    stream
      nextPutAll: 'baseline=';
      nextPutAll: ${smalltalkString(options.repository.baseline)};
      cr.
    message ifNotNil: [
      stream
        nextPutAll: 'message=';
        nextPutAll: message asString;
        cr ] ] ].
[
${loadAction}
]
  on: Error do: [ :error |
    pharoMcpLoadStatusWriter value: 'failed' value: error description.
${failureHandler} ].`;
}

export function generateImageStartupScript(
  options: GenerateImageStartupScriptOptions,
): string {
  const dependencyRepositoryCacheSetupScript =
    generateDependencyRepositoryCacheSetupScript({
      cachePath: options.dependencyRepositoryCachePath,
      networkPolicy: options.dependencyRepositoryNetworkPolicy,
    });
  const repositoryWorkspaceLoadScript = generateRepositoryWorkspaceLoadScript({
    imageState: options.imageState,
    loadStatusPath: options.repositoryWorkspaceLoadStatusPath,
    loadStatusPaths: options.repositoryWorkspaceLoadStatusPaths,
  });
  const dependencyRepositoryDetachScript =
    generateDependencyRepositoryDetachScript({
      cachePath: options.dependencyRepositoryCachePath,
      statusPath: options.dependencyRepositoryDetachStatusPath,
      editableRepositoryPaths: projectImageRepositoryWorkspaces(
        options.imageState,
      ).map((workspace) => workspace.path),
    });

  const startupMode = projectMcpStartupMode(options.imageConfig.mcp);
  if (
    startupMode === "disabled" ||
    options.imageState.pharoMcpContract?.status === "unsupported"
  ) {
    const reason =
      startupMode === "disabled"
        ? "Project image mcp.startupMode is disabled."
        : (options.imageState.pharoMcpContract?.reason ??
          "This image Pharo version is outside the supported Pharo MCP range.");

    return `"Generated by PLexus. Do not edit."

| plexusDependencyRepositoryCachePath plexusDependencyRepositoryNetworkPolicy plexusDependencyRepositoryDetachStatusFile plexusEditableRepositoryPaths plexusNormalizePath plexusRepositoryLocationString plexusRepositoryNameString plexusDependencyRepositoryDetachStatusWriter repositoryLoadStatusFile repositorySourcePath repositorySourceDirectory repositoryLoadStatusWriter |

${dependencyRepositoryCacheSetupScript}
${repositoryWorkspaceLoadScript}
${dependencyRepositoryDetachScript}

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
  const loadPolicy = projectMcpLoadPolicy(options.imageConfig.mcp);
  const loadScriptPath =
    loadPolicy === "never"
      ? undefined
      : resolveLoadScriptPath(
          options.projectRoot,
          options.sourcePath,
          options.imageConfig,
        );
  const gitConfiguration = generateGitConfigurationScript(options.imageConfig);
  const pharoMcpLoadScript = generatePharoMcpLoadScript({
    imageId: options.imageState.id,
    loadScriptPath,
    repository,
    statusPath: options.pharoMcpLoadStatusPath,
    failureBehavior: startupMode === "optional" ? "record" : "throw",
    loadPolicy,
  });

  const requiredMcpStartup = preferEndpointHandoff
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
  const mcpStartup =
    startupMode === "optional"
      ? [
          `"Configure and start the MCP server when optional loading succeeded."`,
          `(Smalltalk globals includesKey: #MCP)`,
          `  ifTrue: [`,
          requiredMcpStartup
            .split("\n")
            .map((line) => `    ${line}`)
            .join("\n"),
          `    Smalltalk globals at: #PLexusMCPServer put: mcp ]`,
          `  ifFalse: [`,
          `    ${smalltalkComment("Optional Pharo MCP startup did not provide MCP; keep the image process alive without a route.")} ].`,
        ].join("\n")
      : `${requiredMcpStartup}\n\nSmalltalk globals at: #PLexusMCPServer put: mcp.`;

  return `"Generated by PLexus. Do not edit."

| loadScript mcp endpointFile endpoint endpointValue endpointTransport endpointHost endpointPort endpointPath pharoMcpLoadStatusFile pharoMcpLoadStatusWriter pharoMcpLoadSource pharoMcpLoadPolicy plexusDependencyRepositoryCachePath plexusDependencyRepositoryNetworkPolicy plexusDependencyRepositoryDetachStatusFile plexusEditableRepositoryPaths plexusNormalizePath plexusRepositoryLocationString plexusRepositoryNameString plexusDependencyRepositoryDetachStatusWriter repositoryLoadStatusFile repositorySourcePath repositorySourceDirectory repositoryLoadStatusWriter |

${gitConfiguration}

${dependencyRepositoryCacheSetupScript}
${repositoryWorkspaceLoadScript}

${pharoMcpLoadScript}

${dependencyRepositoryDetachScript}

"Stop the previous server registered by PLexus before starting a new one."
(Smalltalk globals at: #PLexusMCPServer ifAbsent: [ nil ])
  ifNotNil: [ :existingServer |
    [ existingServer stop ] on: Error do: [ :error | nil ] ].

${mcpStartup}

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
  const repositoryWorkspaces = projectImageRepositoryWorkspaces(options.imageState);
  const repositoryWorkspaceLoadStatusPaths =
    repositoryWorkspaces.length > 0
      ? Object.fromEntries(
          repositoryWorkspaces.map((workspace) => {
            const pathOptions = {
              projectRoot: options.projectRoot,
              projectId: options.projectId,
              workspaceId: options.workspaceId,
              imageId: options.imageConfig.id,
              stateRoot: options.stateRoot,
            };
            return [
              workspace.repository.id,
              imageRepositoryWorkspaceLoadStatusPath(
                repositoryWorkspaces.length === 1
                  ? pathOptions
                  : {
                      ...pathOptions,
                      repositoryId: workspace.repository.id,
                    },
              ),
            ];
          }),
        )
      : undefined;
  const repositoryWorkspaceLoadStatusPath =
    repositoryWorkspaces.length === 1
      ? repositoryWorkspaceLoadStatusPaths?.[repositoryWorkspaces[0].repository.id]
      : undefined;
  const pharoMcpLoadStatusPath =
    projectMcpStartupMode(options.imageConfig.mcp) === "disabled" ||
    options.imageState.pharoMcpContract?.status === "unsupported"
      ? undefined
      : imagePharoMcpLoadStatusPath({
          projectRoot: options.projectRoot,
          projectId: options.projectId,
          workspaceId: options.workspaceId,
          imageId: options.imageConfig.id,
          stateRoot: options.stateRoot,
        });
  const dependencyRepositoryDetachStatusPath =
    options.dependencyRepositoryCachePath
      ? imageDependencyRepositoryDetachStatusPath({
          projectRoot: options.projectRoot,
          projectId: options.projectId,
          workspaceId: options.workspaceId,
          imageId: options.imageConfig.id,
          stateRoot: options.stateRoot,
        })
      : undefined;
  const source = generateImageStartupScript({
    ...options,
    ...(pharoMcpLoadStatusPath ? { pharoMcpLoadStatusPath } : {}),
    ...(repositoryWorkspaceLoadStatusPath
      ? { repositoryWorkspaceLoadStatusPath }
      : {}),
    ...(repositoryWorkspaceLoadStatusPaths
      ? { repositoryWorkspaceLoadStatusPaths }
      : {}),
    ...(dependencyRepositoryDetachStatusPath
      ? { dependencyRepositoryDetachStatusPath }
      : {}),
  });

  fs.mkdirSync(dirnamePathLike(filePath), { recursive: true });
  fs.writeFileSync(filePath, source, "utf8");

  return {
    filePath,
    source,
    ...(pharoMcpLoadStatusPath ? { pharoMcpLoadStatusPath } : {}),
    ...(repositoryWorkspaceLoadStatusPath
      ? { repositoryWorkspaceLoadStatusPath }
      : {}),
    ...(repositoryWorkspaceLoadStatusPaths
      ? { repositoryWorkspaceLoadStatusPaths }
      : {}),
    ...(dependencyRepositoryDetachStatusPath
      ? { dependencyRepositoryDetachStatusPath }
      : {}),
  };
}

export function writeProjectImageStartupScript(
  options: WriteProjectImageStartupScriptOptions,
): WrittenImageStartupScript {
  const imageConfig = findProjectImageConfig(options.config, options.imageId);
  const plexusHomePath = resolvePlexusHomePath({ config: options.config });

  return writeImageStartupScript({
    projectRoot: options.projectRoot,
    sourcePath: options.sourcePath,
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
    dependencyRepositoryCachePath:
      homeDependencyRepositoryCachePath(plexusHomePath),
    dependencyRepositoryNetworkPolicy:
      homeDependencyRepositoryNetworkPolicy(options.config),
    repository: options.repository,
  });
}
