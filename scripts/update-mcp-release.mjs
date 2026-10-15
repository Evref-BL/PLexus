#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ignoredDirectories = new Set([".git", "coverage", "dist", "node_modules"]);
const manifestPaths = [
  "package.json",
  "packages/plexus-core/package.json",
  "packages/plexus-gateway/package.json",
];

function filesBelow(root, directory = root) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return ignoredDirectories.has(entry.name) ? [] : filesBelow(root, entryPath);
    }
    return entry.isFile() ? [entryPath] : [];
  });
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function nextPatch(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) throw new Error(`Expected a release version, got ${version}`);
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
}

function pinnedRelease(root) {
  const source = fs.readFileSync(
    path.join(root, "packages/plexus-core/src/workspace/projectStartupScript.ts"),
    "utf8",
  );
  const match = /commitish: "(v\d+\.\d+\.\d+)"/.exec(source);
  if (!match) throw new Error("Could not find the pinned MCP release tag.");
  return match[1];
}

function replaceReleaseTag(root, from, to) {
  let replacements = 0;
  for (const filePath of filesBelow(root)) {
    const source = fs.readFileSync(filePath, "utf8");
    if (!source.includes(from)) continue;
    const updated = source.replaceAll(from, to);
    replacements += source.split(from).length - 1;
    fs.writeFileSync(filePath, updated);
  }
  if (replacements === 0) throw new Error(`No references to ${from} were found.`);
}

function bumpPackageVersions(root) {
  const manifests = manifestPaths.map((relativePath) => ({
    filePath: path.join(root, relativePath),
    value: readJson(path.join(root, relativePath)),
  }));
  const current = manifests[0].value.version;
  if (!manifests.every(({ value }) => value.version === current)) {
    throw new Error("PLexus workspace package versions must match before updating MCP.");
  }
  const next = nextPatch(current);
  for (const { filePath, value } of manifests) {
    value.version = next;
    writeJson(filePath, value);
  }

  const lockPath = path.join(root, "package-lock.json");
  const lock = readJson(lockPath);
  lock.version = next;
  for (const packagePath of ["", "packages/plexus-core", "packages/plexus-gateway"]) {
    lock.packages[packagePath].version = next;
  }
  writeJson(lockPath, lock);
  return next;
}

export function updateMcpRelease(root, tag) {
  if (!/^v\d+\.\d+\.\d+$/.test(tag)) {
    throw new Error(`Expected an MCP release tag, got ${tag}`);
  }
  const current = pinnedRelease(root);
  if (current === tag) return { changed: false, current };
  replaceReleaseTag(root, current, tag);
  return { changed: true, previous: current, tag, version: bumpPackageVersions(root) };
}

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  const tag = process.argv[2];
  if (!tag) throw new Error("Usage: update-mcp-release.mjs <vX.Y.Z>");
  console.log(JSON.stringify(updateMcpRelease(process.cwd(), tag)));
}
