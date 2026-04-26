import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { loadProjectConfig, type ProjectImageConfig } from "./projectConfig.js";
import { openProject } from "./projectOpen.js";
import {
  defaultTargetId,
  defaultWorkspaceId,
  loadProjectState,
  projectStatePathForConfig,
  type ProjectImageState,
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
}

interface ResolvedScope {
  projectRoot: string;
  workspaceId: string;
  targetId: string;
  stateRoot?: string;
}

interface WorkspaceImageSummary {
  imageId: string;
  imageName: string;
  active: boolean;
  assignedPort?: number;
  pid?: number;
  status: ProjectImageState["status"] | "declared";
  pharoMcpContract?: ProjectImageState["pharoMcpContract"];
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

function requireConfirm(input: Record<string, unknown>): void {
  if (input.confirm !== true) {
    throw new ScopedPharoLauncherError("confirm: true is required");
  }
}

function resolveScope(options: ScopedPharoLauncherOptions): ResolvedScope {
  const projectConfig = loadProjectConfig(options.projectRoot);
  const workspaceId = options.workspaceId ?? defaultWorkspaceId(options.projectRoot);
  return {
    projectRoot: options.projectRoot,
    workspaceId,
    targetId:
      options.targetId ?? defaultTargetId(projectConfig.kanban.projectId, workspaceId),
    ...(options.stateRoot ? { stateRoot: options.stateRoot } : {}),
  };
}

function imageSummary(
  imageConfig: ProjectImageConfig,
  imageState: ProjectImageState | undefined,
): WorkspaceImageSummary {
  return {
    imageId: imageConfig.id,
    imageName: imageState?.imageName ?? imageConfig.imageName,
    active: imageConfig.active,
    ...(imageState?.assignedPort ? { assignedPort: imageState.assignedPort } : {}),
    ...(imageState?.pid ? { pid: imageState.pid } : {}),
    status: imageState?.status ?? "declared",
    ...(imageState?.pharoMcpContract
      ? { pharoMcpContract: imageState.pharoMcpContract }
      : {}),
  };
}

export class ScopedPharoLauncher {
  constructor(private readonly options: ScopedPharoLauncherOptions) {}

  listImages(): {
    scope: ResolvedScope;
    images: WorkspaceImageSummary[];
  } {
    const scope = resolveScope(this.options);
    const projectConfig = loadProjectConfig(scope.projectRoot);
    const state = loadProjectState(
      projectStatePathForConfig({
        projectRoot: scope.projectRoot,
        config: projectConfig,
        workspaceId: scope.workspaceId,
        stateRoot: scope.stateRoot,
      }),
    );

    return {
      scope,
      images: projectConfig.images.map((imageConfig) =>
        imageSummary(
          imageConfig,
          state?.images.find((image) => image.id === imageConfig.id),
        ),
      ),
    };
  }

  imageInfo(imageId: string): {
    scope: ResolvedScope;
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
      image,
    };
  }

  async startImage(imageId: string): Promise<{
    scope: ResolvedScope;
    image: WorkspaceImageSummary;
  }> {
    const before = this.imageInfo(imageId);
    if (!before.image.active) {
      throw new ScopedPharoLauncherError(
        `Image ${imageId} is not active in project config; scoped start is rejected`,
      );
    }

    await openProject({
      projectRoot: before.scope.projectRoot,
      workspaceId: before.scope.workspaceId,
      targetId: before.scope.targetId,
      stateRoot: before.scope.stateRoot,
    });

    return this.imageInfo(imageId);
  }

  async stopImage(imageId: string): Promise<{
    scope: ResolvedScope;
    image: WorkspaceImageSummary;
  }> {
    const before = this.imageInfo(imageId);
    throw new ScopedPharoLauncherError(
      `Scoped per-image stop is not implemented for ${before.image.imageId}; use PLexus project close policy`,
    );
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
    name: "pharo_launcher_image_start",
    description:
      "Start a workspace-scoped active image through PLexus project open policy.",
    inputSchema: objectSchema({ imageId: stringSchema }, ["imageId"]),
  },
  {
    name: "pharo_launcher_image_stop",
    description:
      "Reserved scoped stop entry point. Does not accept arbitrary host pids or image names.",
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
