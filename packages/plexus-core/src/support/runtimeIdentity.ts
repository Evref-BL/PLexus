import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface PlexusProjectConfigSchemaDiagnostic {
  identityField: "id";
  legacyIdentityField: "kanban.projectId";
  legacyCompatibility: string;
}

export interface PlexusRuntimeIdentityDiagnostic {
  packageName: string;
  packageVersion: string;
  packageJsonPath: string;
  modulePath: string;
  entrypointPath: string;
  projectConfigSchema: PlexusProjectConfigSchemaDiagnostic;
}

interface PackageJson {
  name?: unknown;
  version?: unknown;
}

function readPackageJson(filePath: string): PackageJson {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as PackageJson;
}

function findPackageJson(startDirectory: string): string {
  let directory = startDirectory;
  while (true) {
    const candidate = path.join(directory, "package.json");
    if (fs.existsSync(candidate)) {
      return candidate;
    }

    const parent = path.dirname(directory);
    if (parent === directory) {
      throw new Error(`Unable to locate package.json from ${startDirectory}`);
    }
    directory = parent;
  }
}

export function plexusRuntimeIdentity(): PlexusRuntimeIdentityDiagnostic {
  const modulePath = fileURLToPath(import.meta.url);
  const packageJsonPath = findPackageJson(path.dirname(modulePath));
  const packageJson = readPackageJson(packageJsonPath);

  return {
    packageName:
      typeof packageJson.name === "string"
        ? packageJson.name
        : "@evref-bl/plexus-core",
    packageVersion:
      typeof packageJson.version === "string" ? packageJson.version : "unknown",
    packageJsonPath,
    modulePath,
    entrypointPath: process.argv[1] ?? process.execPath,
    projectConfigSchema: {
      identityField: "id",
      legacyIdentityField: "kanban.projectId",
      legacyCompatibility:
        "kanban.projectId is accepted only as compatibility input when config.id is absent",
    },
  };
}
