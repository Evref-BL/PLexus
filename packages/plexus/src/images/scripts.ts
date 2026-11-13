/**
 * The two Smalltalk scripts PLexus runs in an image. Both must run on Pharo
 * 10 to 15.
 */

/** Where the pinned MCP comes from: the release's tag of Evref-BL/MCP. */
export function pharoMcpRepository(version: string) {
  return {
    githubUser: "Evref-BL",
    project: "MCP",
    commitish: `v${version}`,
    path: "src",
    baseline: "MCP",
  } as const;
}

export type PrepareSource =
  | { kind: "pin"; version: string }
  | { kind: "script"; script: string };

function smalltalkString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function smalltalkPath(value: string): string {
  return smalltalkString(value.replace(/\\/g, "/"));
}

// A properties value is one line.
const errorText =
  "((error description copyReplaceAll: String cr with: ' ') copyReplaceAll: String lf with: ' ')";

function failureWriter(file: string, indent: string): string {
  return [
    `${indent}${file} ensureDelete.`,
    `${indent}${file} writeStreamDo: [ :stream |`,
    `${indent}  stream nextPutAll: 'status=failed'; cr;`,
    `${indent}    nextPutAll: 'message='; nextPutAll: ${errorText}; cr ].`,
  ].join("\n");
}

/**
 * Get MCP into a fresh image, save it and quit. The pinned release is loaded
 * with the Metacello expression PLexus has always used; a script is filed in
 * instead.
 *
 * A pinned load forgets the Iceberg repositories it registered: their
 * locations name the build directory, which a base is renamed away from. A
 * script's are kept, since its image is built where it stays.
 */
export function prepareScript(source: PrepareSource): string {
  const load =
    source.kind === "pin"
      ? (() => {
          const repository = pharoMcpRepository(source.version);
          return [
            `  Metacello new`,
            `    githubUser: ${smalltalkString(repository.githubUser)} project: ${smalltalkString(repository.project)} commitish: ${smalltalkString(repository.commitish)} path: ${smalltalkString(repository.path)};`,
            `    baseline: ${smalltalkString(repository.baseline)};`,
            `    load.`,
          ].join("\n");
        })()
      : `  ${smalltalkPath(source.script)} asFileReference fileIn.`;
  const forget =
    source.kind === "pin"
      ? [
          `  (Smalltalk globals at: #IceRepository ifAbsent: [ nil ]) ifNotNil: [ :class |`,
          `    (class registry reject: [ :each | repositoriesBefore includes: each ])`,
          `      do: [ :each | class registry remove: each ifAbsent: [ ] ] ].`,
        ].join("\n")
      : "";

  return `"Written by PLexus to prepare this image. Do not edit."
| dir status repositoriesBefore |
dir := FileLocator imageDirectory asFileReference / 'plexus'.
dir ensureCreateDirectory.
status := dir / 'prepare-status.properties'.
[
  repositoriesBefore := (Smalltalk globals at: #IceRepository ifAbsent: [ nil ])
    ifNil: [ #() ] ifNotNil: [ :class | class registry copy ].
${load}
  (Smalltalk globals includesKey: #MCP)
    ifFalse: [ Error signal: 'MCP is not in the image after loading.' ].
${forget}
  status ensureDelete.
  status writeStreamDo: [ :stream | stream nextPutAll: 'status=ok'; cr ].
  Smalltalk snapshot: true andQuit: true ]
    on: Error
    do: [ :error |
${failureWriter("status", "      ")}
      Smalltalk exitFailure ]
`;
}

/**
 * Start this image's MCP server and say where it listens. The same text for
 * every image: everything it needs it finds from the image's own directory.
 *
 * Port 0 asks the system for a free port; the file names the port bound and
 * the pid that bound it, written under another name and renamed so that a
 * reader never sees half of it. It never saves the image.
 */
export const startScript = `"Written by PLexus to start this image's MCP server. Do not edit."
| dir status mcp port pid endpoint temporary |
dir := FileLocator imageDirectory asFileReference / 'plexus'.
status := dir / 'start-status.properties'.
[
  (dir / 'on-start') exists ifTrue: [
    (dir / 'on-start') contents lines
      detect: [ :line | line trimBoth notEmpty ]
      ifFound: [ :line | line trimBoth asFileReference fileIn ] ].
  (Smalltalk globals includesKey: #MCP)
    ifFalse: [ Error signal: 'MCP is not in the image.' ].
  (Smalltalk globals at: #PLexusMCPServer ifAbsent: [ nil ])
    ifNotNil: [ :previous | [ previous stop ] on: Error do: [ :error | nil ] ].
  pid := [ (Smalltalk globals at: #LibC) uniqueInstance getpid ]
    on: Error do: [ :error | nil ].
  mcp := (Smalltalk globals at: #MCP) new.
  mcp port: 0.
  mcp start.
  port := mcp port.
  (port isInteger and: [ port > 0 ])
    ifFalse: [ Error signal: 'MCP did not report a bound port after starting.' ].
  Smalltalk globals at: #PLexusMCPServer put: mcp.
  endpoint := dir / 'endpoint.properties'.
  temporary := dir / 'endpoint.properties.tmp'.
  temporary ensureDelete.
  temporary writeStreamDo: [ :stream |
    stream nextPutAll: 'transport=http'; cr.
    stream nextPutAll: 'host=127.0.0.1'; cr.
    stream nextPutAll: 'port='; nextPutAll: port asString; cr.
    stream nextPutAll: 'path=/'; cr.
    pid ifNotNil: [ :value | stream nextPutAll: 'pid='; nextPutAll: value asString; cr ] ].
  endpoint ensureDelete.
  temporary renameTo: endpoint basename ]
    on: Error
    do: [ :error |
${failureWriter("status", "      ")}
      Smalltalk exitFailure ].
Semaphore new wait.
`;
