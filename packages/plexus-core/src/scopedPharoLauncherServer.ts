import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  loadProjectConfig,
  projectConfigId,
  resolveProjectRuntimePolicy,
  type ProjectConfig,
  type ProjectImageConfig,
} from "./projectConfig.js";
import { closeProject } from "./projectClose.js";
import { openProject } from "./projectOpen.js";
import {
  createStdioPharoLauncherMcpClient,
  type PharoLauncherMcpToolClient,
} from "./pharoLauncherMcpClient.js";
import {
  describePharoLauncherMcpProfile,
  pharoLauncherMcpProfileEnvironment,
  type PharoLauncherMcpProfileDiagnostic,
} from "./pharoLauncherProfile.js";
import {
  collectReservedProjectPortOwners,
  createProjectState,
  defaultTargetId,
  defaultWorkspaceId,
  loadProjectState,
  projectStatePathForConfig,
  projectStateRootForConfig,
  renderProjectImageName,
  runtimeStatusForImages,
  saveProjectState,
  type ProjectImageState,
  type ProjectState,
} from "./projectState.js";

const stringSchema = { type: "string", minLength: 1 } as const;

function objectSchema(
  properties: Record<string, unknown>,
  required: string[] = [],
) {
  return {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  } as const;
}

export interface ScopedPharoLauncherOptions {
  projectRoot: string;
  workspaceId?: string;
  targetId?: string;
  stateRoot?: string;
  pharoLauncherMcpClient?: PharoLauncherMcpToolClient;
  projectOpen?: typeof openProject;
  projectClose?: typeof closeProject;
  now?: () => Date;
}

interface ResolvedScope {
  projectRoot: string;
  projectId: string;
  projectName: string;
  workspaceId: string;
  targetId: string;
  stateRoot?: string;
}

interface WorkspaceScopeSummary {
  projectId: string;
  projectName: string;
  workspaceId: string;
  targetId: string;
}

interface LauncherProfileSummary {
  ownership: PharoLauncherMcpProfileDiagnostic["ownership"];
  mode: PharoLauncherMcpProfileDiagnostic["mode"];
}

interface WorkspaceImageSummary {
  imageId: string;
  active: boolean;
  status: ProjectImageState["status"] | "declared";
  pharoMcpContract?: ProjectImageState["pharoMcpContract"];
}

interface LauncherCommandResult<T = unknown> {
  ok: boolean;
  data?: T;
}

export class ScopedPharoLauncherError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScopedPharoLauncherError";
  }
}

function textResult(value: unknown, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    ...(isError ? { isError } : {}),
  };
}

function objectInput(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return {};
  }

  return input as Record<string, unknown>;
}

function requireString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new ScopedPharoLauncherError(`${key} is required`);
  }

  return value;
}

function optionalString(
  input: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = input[key];
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string" || value.length === 0) {
    throw new ScopedPharoLauncherError(`${key} must be a non-empty string`);
  }

  return value;
}

function requireConfirm(input: Record<string, unknown>): void {
  if (input.confirm !== true) {
    throw new ScopedPharoLauncherError("confirm: true is required");
  }
}

function assertLauncherOk(
  result: LauncherCommandResult | undefined,
  toolName: string,
): void {
  if (result && result.ok === false) {
    throw new ScopedPharoLauncherError(`${toolName} returned ok: false`);
  }
}

function resolveScope(options: ScopedPharoLauncherOptions): ResolvedScope {
  const projectConfig = loadProjectConfig(options.projectRoot);
  const workspaceId = options.workspaceId ?? defaultWorkspaceId(options.projectRoot);
  const stateRoot = projectStateRootForConfig(projectConfig, options.stateRoot);
  return {
    projectRoot: options.projectRoot,
    projectId: projectConfigId(projectConfig),
    projectName: projectConfig.name,
    workspaceId,
    targetId:
      options.targetId ?? defaultTargetId(projectConfigId(projectConfig), workspaceId),
    ...(stateRoot ? { stateRoot } : {}),
  };
}

function scopeSummary(scope: ResolvedScope): WorkspaceScopeSummary {
  return {
    projectId: scope.projectId,
    projectName: scope.projectName,
    workspaceId: scope.workspaceId,
    targetId: scope.targetId,
  };
}

function launcherProfileSummary(
  profile: PharoLauncherMcpProfileDiagnostic,
): LauncherProfileSummary {
  return {
    ownership: profile.ownership,
    mode: profile.mode,
  };
}

function imageSummary(
  imageConfig: ProjectImageConfig,
  imageState: ProjectImageState | undefined,
): WorkspaceImageSummary {
  return {
    imageId: imageConfig.id,
    active: imageConfig.active,
    status: imageState?.status ?? "declared",
    ...(imageState?.pharoMcpContract
      ? { pharoMcpContract: imageState.pharoMcpContract }
      : {}),
  };
}

function statePathForScope(
  scope: ResolvedScope,
  projectConfig = loadProjectConfig(scope.projectRoot),
): string {
  return projectStatePathForConfig({
    projectRoot: scope.projectRoot,
    config: projectConfig,
    workspaceId: scope.workspaceId,
    stateRoot: scope.stateRoot,
  });
}

function findImageConfig(
  projectConfig: ProjectConfig,
  imageId: string,
): ProjectImageConfig {
  const imageConfig = projectConfig.images.find((image) => image.id === imageId);
  if (!imageConfig) {
    throw new ScopedPharoLauncherError(
      `Image ${imageId} is not declared in this PLexus workspace`,
    );
  }

  return imageConfig;
}

function renderedImageName(
  scope: ResolvedScope,
  imageConfig: ProjectImageConfig,
): string {
  return renderProjectImageName(imageConfig.imageName, {
    projectId: scope.projectId,
    projectName: scope.projectName,
    workspaceId: scope.workspaceId,
    targetId: scope.targetId,
    imageId: imageConfig.id,
  });
}

function stateWithCreatedImage(
  projectConfig: ProjectConfig,
  scope: ResolvedScope,
  previousState: ProjectState | undefined,
  imageId: string,
  now: Date,
): ProjectState {
  const runtime = resolveProjectRuntimePolicy(projectConfig);
  const reservedPorts = collectReservedProjectPortOwners({
    projectRoot: scope.projectRoot,
    projectId: projectConfigId(projectConfig),
    stateRoot: scope.stateRoot,
    excludeWorkspaceId: scope.workspaceId,
  }).map((owner) => owner.port);
  const state = createProjectState(projectConfig, {
    previousState,
    workspaceId: scope.workspaceId,
    targetId: scope.targetId,
    reservedPorts,
    portRange: runtime.imagePorts.range,
    updatedAt: now.toISOString(),
  });

  for (const image of state.images) {
    const previousImage = previousState?.images.find(
      (candidate) => candidate.id === image.id,
    );
    if (image.id === imageId) {
      image.status = "stopped";
      delete image.pid;
    } else if (previousImage) {
      Object.assign(image, previousImage);
    } else {
      image.status = "stopped";
    }
  }
  state.runtimeStatus = runtimeStatusForImages(state.images);

  return state;
}

export class ScopedPharoLauncher {
  constructor(private readonly options: ScopedPharoLauncherOptions) {}

  listImages(): {
    scope: WorkspaceScopeSummary;
    launcherProfile: LauncherProfileSummary;
    images: WorkspaceImageSummary[];
  } {
    const scope = resolveScope(this.options);
    const projectConfig = loadProjectConfig(scope.projectRoot);
    const state = loadProjectState(statePathForScope(scope, projectConfig));
    const launcherProfile = describePharoLauncherMcpProfile({
      projectRoot: scope.projectRoot,
      config: projectConfig,
      workspaceId: scope.workspaceId,
      targetId: scope.targetId,
      stateRoot: scope.stateRoot,
    });

    return {
      scope: scopeSummary(scope),
      launcherProfile: launcherProfileSummary(launcherProfile),
      images: projectConfig.images.map((imageConfig) =>
        imageSummary(
          imageConfig,
          state?.images.find((image) => image.id === imageConfig.id),
        ),
      ),
    };
  }

  imageInfo(imageId: string): {
    scope: WorkspaceScopeSummary;
    launcherProfile: LauncherProfileSummary;
    image: WorkspaceImageSummary;
  } {
    const listed = this.listImages();
    const image = listed.images.find((candidate) => candidate.imageId === imageId);
    if (!image) {
      throw new ScopedPharoLauncherError(
        `Image ${imageId} is not declared in this PLexus workspace`,
      );
    }

    return {
      scope: listed.scope,
      launcherProfile: listed.launcherProfile,
      image,
    };
  }

  async createImage(
    imageId: string,
    profileId?: string,
  ): Promise<{
    scope: WorkspaceScopeSummary;
    launcherProfile: LauncherProfileSummary;
    image: WorkspaceImageSummary;
  }> {
    const scope = resolveScope(this.options);
    const projectConfig = loadProjectConfig(scope.projectRoot);
    const imageConfig = findImageConfig(projectConfig, imageId);
    if (!imageConfig.create) {
      throw new ScopedPharoLauncherError(
        `Image ${imageId} has no approved create policy in project config`,
      );
    }
    if (profileId && profileId !== imageConfig.create.profileId) {
      throw new ScopedPharoLauncherError(
        `Profile ${profileId} is not approved for image ${imageId}`,
      );
    }

    const statePath = statePathForScope(scope, projectConfig);
    const previousState = loadProjectState(statePath);
    if (previousState?.images.some((image) => image.id === imageId)) {
      throw new ScopedPharoLauncherError(
        `Image ${imageId} already has runtime state`,
      );
    }

    const client =
      this.options.pharoLauncherMcpClient ??
      (await createStdioPharoLauncherMcpClient(undefined, {
        profileEnvironment: pharoLauncherMcpProfileEnvironment({
          projectRoot: scope.projectRoot,
          config: projectConfig,
          workspaceId: scope.workspaceId,
          targetId: scope.targetId,
          stateRoot: scope.stateRoot,
        }),
      }));
    const ownsClient = !this.options.pharoLauncherMcpClient;

    try {
      const result = await client.callTool<LauncherCommandResult>(
        "pharo_launcher_image_create",
        {
          newImageName: renderedImageName(scope, imageConfig),
          templateName: imageConfig.create.templateName,
          ...(imageConfig.create.templateCategory
            ? { templateCategory: imageConfig.create.templateCategory }
            : {}),
          noLaunch: true,
        },
      );
      assertLauncherOk(result, "pharo_launcher_image_create");
    } finally {
      if (ownsClient) {
        await client.close?.();
      }
    }

    const state = stateWithCreatedImage(
      projectConfig,
      scope,
      previousState,
      imageId,
      this.options.now?.() ?? new Date(),
    );
    saveProjectState(statePath, state);

    return this.imageInfo(imageId);
  }

  async startImage(imageId: string): Promise<{
    scope: WorkspaceScopeSummary;
    launcherProfile: LauncherProfileSummary;
    image: WorkspaceImageSummary;
  }> {
    const before = this.imageInfo(imageId);
    if (!before.image.active) {
      throw new ScopedPharoLauncherError(
        `Image ${imageId} is not active in project config; scoped start is rejected`,
      );
    }

    const scope = resolveScope(this.options);
    await (this.options.projectOpen ?? openProject)({
      projectRoot: scope.projectRoot,
      workspaceId: scope.workspaceId,
      targetId: scope.targetId,
      stateRoot: scope.stateRoot,
      imageIds: [imageId],
    });

    return this.imageInfo(imageId);
  }

  async stopImage(imageId: string): Promise<{
    scope: WorkspaceScopeSummary;
    launcherProfile: LauncherProfileSummary;
    image: WorkspaceImageSummary;
  }> {
    this.imageInfo(imageId);
    const scope = resolveScope(this.options);
    await (this.options.projectClose ?? closeProject)({
      projectRoot: scope.projectRoot,
      workspaceId: scope.workspaceId,
      stateRoot: scope.stateRoot,
      imageIds: [imageId],
    });

    return this.imageInfo(imageId);
  }
}

export const scopedPharoLauncherTools = [
  {
    name: "pharo_launcher_image_list",
    description:
      "List Pharo images declared in the current PLexus project/workspace scope.",
    inputSchema: objectSchema({}),
  },
  {
    name: "pharo_launcher_image_info",
    description:
      "Return scoped state for one Pharo image handle in the current PLexus workspace.",
    inputSchema: objectSchema({ imageId: stringSchema }, ["imageId"]),
  },
  {
    name: "pharo_launcher_image_create",
    description:
      "Create a declared workspace-scoped image from an approved PLexus project create policy.",
    inputSchema: objectSchema(
      {
        imageId: stringSchema,
        profileId: stringSchema,
      },
      ["imageId"],
    ),
  },
  {
    name: "pharo_launcher_image_start",
    description:
      "Start a workspace-scoped active image through PLexus project open policy.",
    inputSchema: objectSchema({ imageId: stringSchema }, ["imageId"]),
  },
  {
    name: "pharo_launcher_image_stop",
    description:
      "Stop one workspace-scoped image through PLexus project close policy.",
    inputSchema: objectSchema(
      {
        imageId: stringSchema,
        confirm: { type: "boolean" },
      },
      ["imageId", "confirm"],
    ),
  },
] as const;

export function createScopedPharoLauncherServer(
  options: ScopedPharoLauncherOptions,
): Server {
  const facade = new ScopedPharoLauncher(options);
  const server = new Server(
    {
      name: "pharo-launcher",
      version: "0.1.0",
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [...scopedPharoLauncherTools],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      const input = objectInput(request.params.arguments ?? {});
      switch (request.params.name) {
        case "pharo_launcher_image_list":
          return textResult(facade.listImages());

        case "pharo_launcher_image_info":
          return textResult(facade.imageInfo(requireString(input, "imageId")));

        case "pharo_launcher_image_create":
          return textResult(
            await facade.createImage(
              requireString(input, "imageId"),
              optionalString(input, "profileId"),
            ),
          );

        case "pharo_launcher_image_start":
          return textResult(
            await facade.startImage(requireString(input, "imageId")),
          );

        case "pharo_launcher_image_stop":
          requireConfirm(input);
          return textResult(await facade.stopImage(requireString(input, "imageId")));

        default:
          return textResult(
            { ok: false, error: `Unknown tool: ${request.params.name}` },
            true,
          );
      }
    } catch (error) {
      return textResult(
        {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        },
        true,
      );
    }
  });

  return server;
}

export async function startScopedPharoLauncherServer(
  options: ScopedPharoLauncherOptions,
): Promise<void> {
  const server = createScopedPharoLauncherServer(options);
  await server.connect(new StdioServerTransport());
}
