import fs from "node:fs";
import type { PharoLauncherMcpToolClient } from "./pharoLauncherMcpClient.js";
import type {
  ProjectConfig,
  ProjectImageConfig,
  ProjectPharoMcpRepositoryConfig,
  ProjectPreparedImageConfig,
} from "./projectConfig.js";
import { projectConfigId } from "./projectConfig.js";
import {
  defaultPlexusStateRoot,
  projectStateRootForConfig,
  type ProjectImageState,
} from "./projectState.js";
import {
  defaultPharoMcpMetacelloRepository,
  type PharoMcpMetacelloRepository,
} from "./projectStartupScript.js";
import {
  dirnamePathLike,
  isAbsolutePathLike,
  joinPathLike,
  resolvePathLike,
} from "./pathStyle.js";

export const preparedImagesDirectoryName = "prepared-images";

export interface PreparedImageCacheNameContext {
  projectId: string;
  projectName: string;
  cacheId: string;
}

export interface PreparedImageCacheScriptOptions {
  projectRoot: string;
  preparedImage: ProjectPreparedImageConfig;
}

export interface WritePreparedImageCacheScriptOptions {
  projectRoot: string;
  config: ProjectConfig;
  cacheId: string;
  stateRoot?: string;
}

export interface PreparedImageCacheMutationApproval {
  approved: true;
  runnerId: string;
}

export interface PreparedImageLiveOperation {
  toolName: string;
  argumentsValue: Record<string, unknown>;
  requiresApproval: true;
  reason: string;
}

export interface PreparedImageCachePlan {
  cacheId: string;
  imageName: string;
  prepareScript: {
    filePath: string;
    source: string;
  };
  createCacheImage: PreparedImageLiveOperation;
  runtimeCopy?: PreparedImageLiveOperation;
}

export interface CopyProjectImageFromPreparedCacheOptions {
  client: PharoLauncherMcpToolClient;
  projectRoot: string;
  config: ProjectConfig;
  imageConfig: ProjectImageConfig;
  imageState: ProjectImageState;
  approval?: PreparedImageCacheMutationApproval;
}

interface LauncherCommandResult {
  ok: boolean;
}

export class PreparedImageCacheError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PreparedImageCacheError";
  }
}

function smalltalkString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function smalltalkPath(value: string): string {
  return smalltalkString(value.replace(/\\/g, "/"));
}

function assertLauncherOk(
  result: LauncherCommandResult | undefined,
  toolName: string,
): void {
  if (result && result.ok === false) {
    throw new PreparedImageCacheError(`${toolName} returned ok: false`);
  }
}

function toMetacelloRepository(
  repository: ProjectPharoMcpRepositoryConfig | undefined,
): PharoMcpMetacelloRepository {
  return repository ?? defaultPharoMcpMetacelloRepository;
}

function resolvePreparedLoadScriptPath(
  projectRoot: string,
  preparedImage: ProjectPreparedImageConfig,
): string {
  return isAbsolutePathLike(preparedImage.mcp.loadScript)
    ? resolvePathLike(preparedImage.mcp.loadScript)
    : resolvePathLike(projectRoot, preparedImage.mcp.loadScript);
}

export function renderPreparedImageCacheName(
  template: string,
  context: PreparedImageCacheNameContext,
): string {
  return template.replace(
    /\{(projectId|projectName|cacheId)\}/g,
    (_match, key: keyof PreparedImageCacheNameContext) => context[key],
  );
}

export function preparedImageCacheName(
  config: ProjectConfig,
  preparedImage: ProjectPreparedImageConfig,
): string {
  return renderPreparedImageCacheName(preparedImage.imageName, {
    projectId: projectConfigId(config),
    projectName: config.name,
    cacheId: preparedImage.id,
  });
}

export function projectPreparedImagesDirectoryPath(options: {
  projectRoot: string;
  projectId: string;
  stateRoot?: string;
}): string {
  return joinPathLike(
    options.stateRoot ?? defaultPlexusStateRoot(options.projectRoot),
    "projects",
    options.projectId,
    preparedImagesDirectoryName,
  );
}

export function preparedImageScriptFileName(cacheId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(cacheId)) {
    throw new PreparedImageCacheError(
      `Prepared image cache id must be file-safe: ${cacheId}`,
    );
  }

  return `prepare-${cacheId}.st`;
}

export function preparedImageScriptPath(options: {
  projectRoot: string;
  projectId: string;
  cacheId: string;
  stateRoot?: string;
}): string {
  return joinPathLike(
    projectPreparedImagesDirectoryPath(options),
    preparedImageScriptFileName(options.cacheId),
  );
}

export function findPreparedImageConfig(
  config: ProjectConfig,
  cacheId: string,
): ProjectPreparedImageConfig {
  const preparedImage = config.preparedImages?.find(
    (candidate) => candidate.id === cacheId,
  );
  if (!preparedImage) {
    throw new PreparedImageCacheError(
      `Project config does not define prepared image cache: ${cacheId}`,
    );
  }

  return preparedImage;
}

export function findPreparedImageForProjectImage(
  config: ProjectConfig,
  imageConfig: ProjectImageConfig,
): ProjectPreparedImageConfig | undefined {
  const cacheId = imageConfig.preparedImage?.cacheId;
  return cacheId ? findPreparedImageConfig(config, cacheId) : undefined;
}

export function generatePreparedImageCacheScript(
  options: PreparedImageCacheScriptOptions,
): string {
  const repository = toMetacelloRepository(options.preparedImage.mcp.repository);
  const loadScriptPath = resolvePreparedLoadScriptPath(
    options.projectRoot,
    options.preparedImage,
  );

  return `"Generated by PLexus. Do not edit."

| loadScript |

Smalltalk globals at: #PLexusPreparedImageCacheId put: ${smalltalkString(options.preparedImage.id)}.

"Load the Pharo MCP project into this prepared image cache."
loadScript := ${smalltalkPath(loadScriptPath)} asFileReference.
loadScript exists
  ifTrue: [ loadScript fileIn ]
  ifFalse: [
    Metacello new
      githubUser: ${smalltalkString(repository.githubUser)} project: ${smalltalkString(repository.project)} commitish: ${smalltalkString(repository.commitish)} path: ${smalltalkString(repository.path)};
      baseline: ${smalltalkString(repository.baseline)};
      load ].

(Smalltalk globals includesKey: #MCP)
  ifFalse: [ Error signal: 'MCP class is not available after prepared image load.' ].

Smalltalk globals at: #PLexusPreparedImageLoadedAt put: DateAndTime now asString.
Smalltalk snapshot: true andQuit: true.
`;
}

export function writePreparedImageCacheScript(
  options: WritePreparedImageCacheScriptOptions,
): { filePath: string; source: string } {
  const preparedImage = findPreparedImageConfig(options.config, options.cacheId);
  const filePath = preparedImageScriptPath({
    projectRoot: options.projectRoot,
    projectId: projectConfigId(options.config),
    cacheId: preparedImage.id,
    stateRoot: projectStateRootForConfig(options.config, options.stateRoot),
  });
  const source = generatePreparedImageCacheScript({
    projectRoot: options.projectRoot,
    preparedImage,
  });

  fs.mkdirSync(dirnamePathLike(filePath), { recursive: true });
  fs.writeFileSync(filePath, source, "utf8");

  return { filePath, source };
}

export function buildPreparedImageCachePlan(options: {
  projectRoot: string;
  config: ProjectConfig;
  cacheId: string;
  stateRoot?: string;
  imageConfig?: ProjectImageConfig;
  imageState?: ProjectImageState;
}): PreparedImageCachePlan {
  const preparedImage = findPreparedImageConfig(options.config, options.cacheId);
  const imageName = preparedImageCacheName(options.config, preparedImage);
  const prepareScript = {
    filePath: preparedImageScriptPath({
      projectRoot: options.projectRoot,
      projectId: projectConfigId(options.config),
      cacheId: preparedImage.id,
      stateRoot: projectStateRootForConfig(options.config, options.stateRoot),
    }),
    source: generatePreparedImageCacheScript({
      projectRoot: options.projectRoot,
      preparedImage,
    }),
  };
  const createArguments = {
    newImageName: imageName,
    templateName: preparedImage.source.templateName,
    ...(preparedImage.source.templateCategory
      ? { templateCategory: preparedImage.source.templateCategory }
      : {}),
    noLaunch: true,
  };
  const runtimeCopy =
    options.imageConfig?.preparedImage?.copyMode === "copy-on-open" &&
    options.imageState
      ? {
          toolName: "pharo_launcher_image_copy",
          argumentsValue: {
            imageName,
            newImageName: options.imageState.imageName,
          },
          requiresApproval: true as const,
          reason:
            "Copying a prepared image cache into a runtime image mutates PharoLauncher state.",
        }
      : undefined;

  return {
    cacheId: preparedImage.id,
    imageName,
    prepareScript,
    createCacheImage: {
      toolName: "pharo_launcher_image_create",
      argumentsValue: createArguments,
      requiresApproval: true,
      reason:
        "Creating a prepared image cache mutates PharoLauncher state and must run inside an approved runner.",
    },
    ...(runtimeCopy ? { runtimeCopy } : {}),
  };
}

function requireMutationApproval(
  approval: PreparedImageCacheMutationApproval | undefined,
  operation: string,
): void {
  if (!approval?.approved || approval.runnerId.length === 0) {
    throw new PreparedImageCacheError(
      `${operation} requires an approved prepared-image runner`,
    );
  }
}

export async function copyProjectImageFromPreparedCache(
  options: CopyProjectImageFromPreparedCacheOptions,
): Promise<PreparedImageLiveOperation | undefined> {
  const cacheId = options.imageConfig.preparedImage?.cacheId;
  if (!cacheId) {
    return undefined;
  }

  const plan = buildPreparedImageCachePlan({
    projectRoot: options.projectRoot,
    config: options.config,
    cacheId,
    imageConfig: options.imageConfig,
    imageState: options.imageState,
  });
  if (!plan.runtimeCopy) {
    return undefined;
  }

  requireMutationApproval(
    options.approval,
    `Runtime copy for prepared image cache ${cacheId}`,
  );
  const result = await options.client.callTool<LauncherCommandResult>(
    plan.runtimeCopy.toolName,
    plan.runtimeCopy.argumentsValue,
  );
  assertLauncherOk(result, plan.runtimeCopy.toolName);

  return plan.runtimeCopy;
}
