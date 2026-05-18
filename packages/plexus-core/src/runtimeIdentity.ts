import fs from "node:fs";
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

export function plexusRuntimeIdentity(): PlexusRuntimeIdentityDiagnostic {
  const modulePath = fileURLToPath(import.meta.url);
  const packageJsonPath = fileURLToPath(new URL("../package.json", import.meta.url));
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
