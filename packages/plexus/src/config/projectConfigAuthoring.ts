/**
 * Writing `plexus.json`.
 *
 * PLexus parsed, validated and read its own config, and never wrote it, so
 * every consumer that had to declare an image — `pharo-agent-plugin` is the
 * one that does — built the file itself: the name template, the policy
 * defaults, the `create` block. A schema whose only writer is a consumer
 * drifts from the parser that reads it, and nothing fails when it does.
 *
 * These edit the file rather than rewrite it. `parseProjectConfig` builds a
 * fresh object out of the fields it knows, so saving a parsed config would
 * delete every key PLexus does not read — exactly the keys a user added by
 * hand. Each operation loads the raw JSON, changes one thing, validates the
 * result, and writes the raw JSON back.
 */
import fs from "node:fs";
import {
  type ProjectConfig,
  type ProjectImageCreationCleanupPolicy,
  type ProjectPharoMcpLoadPolicy,
  ProjectConfigError,
  parseProjectConfig,
  projectConfigPath,
} from "./projectConfig.js";
import { sanitizePathSegment } from "../support/pathStyle.js";

/**
 * `{workspaceId}-<id>`: one image file per workspace, so two checkouts of a
 * project never share one. `renderProjectImageName` expands the placeholder at
 * launch.
 *
 * No `{projectName}` in front: a project is named after its workspace
 * directory unless someone renames it, and the workspace id is that
 * directory's name, so the two said the same word twice without telling any
 * more images apart.
 *
 * The image id is baked in rather than left as `{imageId}`, because
 * `parseProjectConfig` rejects two images whose `imageName` are equal as
 * written. A constant template would be the same string for every image, so
 * the second declaration in a project would not load.
 */
export function defaultProjectImageName(imageId: string): string {
  return `{workspaceId}-${imageId}`;
}

export interface ProjectImageDeclaration {
  id: string;
  /** Defaults to `defaultProjectImageNameTemplate`. */
  imageName?: string;
  templateName: string;
  templateCategory?: string;
  profileId?: string;
  loadScript: string;
  /** Omitted when it is PLexus's own default, which `projectMcpLoadPolicy` supplies. */
  loadPolicy?: ProjectPharoMcpLoadPolicy;
  cleanupPolicy?: ProjectImageCreationCleanupPolicy;
  port?: number;
}

/** The id a project directory gets when nobody chose one. */
export function projectConfigIdFromName(name: string): string {
  return sanitizePathSegment(name.trim().toLowerCase(), "pharo-project");
}

function readRawConfig(projectRoot: string): Record<string, unknown> {
  const filePath = projectConfigPath(projectRoot);
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new ProjectConfigError(`Cannot read ${filePath}`, [
      error instanceof Error ? error.message : String(error),
    ]);
  }

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ProjectConfigError(`Invalid Plexus project config in ${filePath}`, [
      "config must be an object",
    ]);
  }

  return raw as Record<string, unknown>;
}

/** Validate before writing, so a bad edit fails here and not at the next load. */
function writeRawConfig(
  projectRoot: string,
  raw: Record<string, unknown>,
): ProjectConfig {
  const config = parseProjectConfig(raw);
  fs.writeFileSync(
    projectConfigPath(projectRoot),
    `${JSON.stringify(raw, null, 2)}\n`,
  );
  return config;
}

function rawImages(raw: Record<string, unknown>): Record<string, unknown>[] {
  return Array.isArray(raw.images)
    ? (raw.images as Record<string, unknown>[])
    : [];
}

export interface CreateProjectConfigOptions {
  id?: string;
  name: string;
}

/** Write a project config declaring no images. */
export function createProjectConfigFile(
  projectRoot: string,
  options: CreateProjectConfigOptions,
): ProjectConfig {
  return writeRawConfig(projectRoot, {
    id: options.id ?? projectConfigIdFromName(options.name),
    name: options.name,
    images: [],
  });
}

/**
 * Add one image to the project's declarations.
 *
 * Only what the caller chose is written. `loadPolicy`, `cleanupPolicy` and the
 * display mode have defaults in `projectMcpLoadPolicy`,
 * `projectImageCreateCleanupPolicy` and `projectImageDisplayMode`; writing
 * them here would copy a default into every project's file and make changing
 * it a migration.
 */
export function declareProjectImage(
  projectRoot: string,
  declaration: ProjectImageDeclaration,
): ProjectConfig {
  const raw = readRawConfig(projectRoot);
  const images = rawImages(raw);
  const imageName =
    declaration.imageName ?? defaultProjectImageName(declaration.id);

  // The reason is the message. An authoring refusal has exactly one, and a
  // caller that printed only `error.message` would otherwise show "Cannot
  // declare image" and leave the why in a field it never looked at.
  if (images.some((image) => image.id === declaration.id)) {
    throw new ProjectConfigError(
      `Image ${declaration.id} is already declared in this project`,
      [`image ${declaration.id} is already declared`],
    );
  }
  if (images.some((image) => image.imageName === imageName)) {
    throw new ProjectConfigError(
      `Image name ${imageName} is already declared in this project`,
      [`image name ${imageName} is already declared`],
    );
  }

  return writeRawConfig(projectRoot, {
    ...raw,
    images: [
      ...images,
      {
        id: declaration.id,
        imageName,
        mcp: {
          loadScript: declaration.loadScript,
          ...(declaration.loadPolicy ? { loadPolicy: declaration.loadPolicy } : {}),
          ...(declaration.port === undefined ? {} : { port: declaration.port }),
        },
        create: {
          kind: "template",
          ...(declaration.profileId ? { profileId: declaration.profileId } : {}),
          templateName: declaration.templateName,
          ...(declaration.templateCategory
            ? { templateCategory: declaration.templateCategory }
            : {}),
          ...(declaration.cleanupPolicy
            ? { cleanupPolicy: declaration.cleanupPolicy }
            : {}),
        },
      },
    ],
  });
}

/** Record the category an image's template was found in. */
export function setProjectImageTemplateCategory(
  projectRoot: string,
  imageId: string,
  templateCategory: string,
): ProjectConfig {
  const raw = readRawConfig(projectRoot);
  const images = rawImages(raw);
  if (!images.some((image) => image.id === imageId)) {
    throw new ProjectConfigError(
      `Image ${imageId} is not declared in this project`,
      [`image ${imageId} is not declared`],
    );
  }

  return writeRawConfig(projectRoot, {
    ...raw,
    images: images.map((image) =>
      image.id === imageId
        ? {
            ...image,
            create: {
              ...(image.create as Record<string, unknown> | undefined),
              templateCategory,
            },
          }
        : image,
    ),
  });
}

/** Drop one image's declaration. The image file itself is not touched. */
export function removeProjectImage(
  projectRoot: string,
  imageId: string,
): ProjectConfig {
  const raw = readRawConfig(projectRoot);
  const images = rawImages(raw);
  if (!images.some((image) => image.id === imageId)) {
    throw new ProjectConfigError(
      `Image ${imageId} is not declared in this project`,
      [`image ${imageId} is not declared`],
    );
  }

  return writeRawConfig(projectRoot, {
    ...raw,
    images: images.filter((image) => image.id !== imageId),
  });
}
