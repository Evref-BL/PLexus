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
  | { kind: "pin"; version: string; telemetry?: boolean }
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

/** The longest error a start script writes as why the server records nothing. */
const detailLength = 300;

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
 * with the Metacello expression PLexus has always used, with its `Telemetry`
 * group beside its default one when telemetry is asked for; a script is filed
 * in instead. The status says whether MCP then has its OpenTelemetry backend
 * (`telemetry=on`), which a script may or may not have loaded.
 *
 * The image clones `github://` repositories over HTTPS, as a public one needs
 * no credentials that way, before it loads anything and in the image saved.
 *
 * A pinned load forgets the Iceberg repositories it registered whose clone is
 * in the build directory, which a base is renamed away from, and the status
 * names those clones (`clone=`) for PLexus to delete once the image has quit:
 * a clone left without its repository is taken by a later load of the same
 * project for one it must not overwrite, which then fails. A clone elsewhere,
 * in a location every image shares, stays registered. A script's are kept,
 * since its image is built where it stays.
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
            source.telemetry ? `    load: #( 'default' 'Telemetry' ).` : `    load.`,
            ...(source.telemetry
              ? [
                  `  (Smalltalk globals at: #MCP ifAbsent: [ nil ]) ifNotNil: [ :class |`,
                  `    (class canUnderstand: #useOpenTelemetryObservability)`,
                  `      ifFalse: [ Error signal: 'MCP has no OpenTelemetry backend after loading its Telemetry group.' ] ].`,
                ]
              : []),
          ].join("\n");
        })()
      : `  ${smalltalkPath(source.script)} asFileReference fileIn.`;
  const forget =
    source.kind === "pin"
      ? [
          `  (Smalltalk globals at: #IceRepository ifAbsent: [ nil ]) ifNotNil: [ :class |`,
          `    (class registry reject: [ :each | repositoriesBefore includes: each ]) do: [ :each |`,
          `      | location |`,
          `      location := [ each location ifNotNil: [ :place | place asFileReference ] ]`,
          `        on: Error do: [ :error | nil ].`,
          `      (location isNil or: [ FileLocator imageDirectory asFileReference contains: location ]) ifTrue: [`,
          `        class registry remove: each ifAbsent: [ ].`,
          `        location ifNotNil: [ clones add: location fullName ] ] ] ].`,
        ].join("\n")
      : "";

  return `"Written by PLexus to prepare this image. Do not edit."
| dir status repositoriesBefore clones |
dir := FileLocator imageDirectory asFileReference / 'plexus'.
dir ensureCreateDirectory.
status := dir / 'prepare-status.properties'.
clones := OrderedCollection new.
[
  (Smalltalk globals at: #Iceberg ifAbsent: [ nil ]) ifNotNil: [ :class |
    (class respondsTo: #remoteTypeSelector:) ifTrue: [ class remoteTypeSelector: #httpsUrl ] ].
  repositoriesBefore := (Smalltalk globals at: #IceRepository ifAbsent: [ nil ])
    ifNil: [ #() ] ifNotNil: [ :class | class registry copy ].
${load}
  (Smalltalk globals includesKey: #MCP)
    ifFalse: [ Error signal: 'MCP is not in the image after loading.' ].
${forget}
  status ensureDelete.
  status writeStreamDo: [ :stream |
    stream nextPutAll: 'status=ok'; cr;
      nextPutAll: 'telemetry=';
      nextPutAll: (((Smalltalk globals at: #MCP) canUnderstand: #useOpenTelemetryObservability)
        ifTrue: [ 'on' ] ifFalse: [ 'off' ]); cr.
    clones do: [ :each | stream nextPutAll: 'clone='; nextPutAll: each; cr ] ].
  Smalltalk snapshot: true andQuit: true ]
    on: Error
    do: [ :error |
${failureWriter("status", "      ")}
      Smalltalk exitFailure ]
`;
}

/**
 * Start this image's MCP server and say where it listens. The same text for
 * every image, but for whether telemetry is asked: everything else it needs
 * it finds from the image's own directory.
 *
 * Port 0 asks the system for a free port; the file names the port bound and
 * the pid that bound it, written under another name and renamed so that a
 * reader never sees half of it. It never saves the image.
 *
 * With telemetry, a server that has an OpenTelemetry backend is switched to
 * it before it starts; one without is started as it is, and a backend that
 * fails to switch leaves it so too. The file says whether the server records
 * through OpenTelemetry (`telemetry=on`), and when not, why
 * (`telemetry.reason`, `telemetry.detail`): see `TelemetryOffReason`.
 */
export function startScript(options: { telemetry?: boolean } = {}): string {
  const observability = options.telemetry
    ? [
        `  telemetry := 'no-backend'.`,
        `  (mcp respondsTo: #useOpenTelemetryObservability) ifTrue: [`,
        `    telemetry := [ mcp useOpenTelemetryObservability. nil ]`,
        `      on: Error`,
        `      do: [ :error | failure := ${errorText}. 'switch-failed' ] ].`,
        ``,
      ].join("\n")
    : `  telemetry := 'not-asked'.\n`;
  return `"Written by PLexus to start this image's MCP server. Do not edit."
| dir status mcp port pid endpoint temporary telemetry failure records |
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
${observability}  mcp port: 0.
  mcp start.
  port := mcp port.
  (port isInteger and: [ port > 0 ])
    ifFalse: [ Error signal: 'MCP did not report a bound port after starting.' ].
  Smalltalk globals at: #PLexusMCPServer put: mcp.
  records := [
    (mcp respondsTo: #observability) and: [
      (Smalltalk globals at: #MCPOpenTelemetryObservabilityBackend ifAbsent: [ nil ])
        ifNil: [ false ]
        ifNotNil: [ :backend | mcp observability isKindOf: backend ] ] ]
    on: Error do: [ :error | false ].
  endpoint := dir / 'endpoint.properties'.
  temporary := dir / 'endpoint.properties.tmp'.
  temporary ensureDelete.
  temporary writeStreamDo: [ :stream |
    stream nextPutAll: 'transport=http'; cr.
    stream nextPutAll: 'host=127.0.0.1'; cr.
    stream nextPutAll: 'port='; nextPutAll: port asString; cr.
    stream nextPutAll: 'path=/'; cr.
    pid ifNotNil: [ :value | stream nextPutAll: 'pid='; nextPutAll: value asString; cr ].
    records
      ifTrue: [ stream nextPutAll: 'telemetry=on'; cr ]
      ifFalse: [
        stream nextPutAll: 'telemetry=off'; cr.
        telemetry ifNotNil: [ :reason | stream nextPutAll: 'telemetry.reason='; nextPutAll: reason; cr ].
        failure ifNotNil: [ :text |
          stream nextPutAll: 'telemetry.detail='; nextPutAll: (text first: (text size min: ${detailLength})); cr ] ] ].
  endpoint ensureDelete.
  temporary renameTo: endpoint basename ]
    on: Error
    do: [ :error |
${failureWriter("status", "      ")}
      Smalltalk exitFailure ].
Semaphore new wait.
`;
}
