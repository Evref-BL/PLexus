# Project Model

This document defines the detailed PLexus runtime vocabulary and arity. For a
shorter user-facing version, see `docs/user/runtime-model.md`.

## Arity

```text
PLexus project       1:N  PLexus workspaces
PLexus workspace     1:1  runtime target
runtime target       1:N  Pharo images
```

## Concepts

### PLexus Project

A PLexus project is the logical project described by `plexus.project.json` at a repository root.

The project id comes from:

```json
{
  "id": "sample-project",
  "name": "SampleProject"
}
```

That `id` identifies the logical project. It must not be used alone as a unique runtime route once parallel worktrees are open. Legacy configs with `kanban.provider: "vibe-kanban"` and `kanban.projectId` are still readable as compatibility input, but `kanban` is not part of normal PLexus project identity.

### PLexus Workspace

A PLexus workspace is one isolated runtime instance of a PLexus project, usually backed by one Git worktree.

The `workspaceId` separates sibling worktrees for the same project. The default is the project root directory name, which works well for agent worktree directories. Callers can override it with:

```text
--workspace-id
PLEXUS_WORKSPACE_ID
VIBE_KANBAN_WORKSPACE_ID
```

Workspace-scoped runtime state lives at:

```text
<state-root>/projects/<project-id>/workspaces/<workspace-id>/state.json
```

Use one shared `PLEXUS_STATE_ROOT` across parallel worktrees so PLexus can see sibling workspace allocations and avoid port collisions.

### Runtime Target

A runtime target is the routable identity for one PLexus workspace.

By default:

```text
targetId = <project-id>--<workspace-id>
```

The current prototype keeps the relationship as one workspace to one target. Later, this could expand if one workspace needs multiple independent runtime targets, but that is not part of the current design.

The PLexus Gateway routing table is keyed by `targetId`. A route by `projectId` alone is only unambiguous when exactly one workspace for that project is registered.

### Pharo Image

A runtime target can manage several Pharo images, as configured in `plexus.project.json`.

Each image has:

```text
image id
rendered image name
registered MCP endpoint
optional assigned MCP port fallback
optional process pid
status
```

For parallel worktrees, image names should include workspace identity:

```json
{
  "id": "dev",
  "imageName": "SampleProject-{workspaceId}-dev",
  "active": true,
  "git": {
    "transport": "ssh"
  },
  "mcp": {
    "loadScript": "pharo/load-mcp.st",
    "loadPolicy": "ifMissing"
  }
}
```

Supported image-name template tokens are:

```text
{projectId}
{projectName}
{workspaceId}
{targetId}
{imageId}
```

Image `git.transport` controls the Git/Iceberg transport the image should use
for image-local repository operations. Supported values are `ssh`, `https`, and
`http`; omitted config defaults to `ssh`.

Image `mcp.loadPolicy` controls how PLexus handles an MCP already present in the
image. Omit it or use `ifMissing` to keep the default behavior: use a provided
MCP when present, otherwise load `mcp.loadScript` or the default repository.
Use `always` when the configured script must replace a preloaded MCP, for
example when working on MCP itself from a feature clone. Use `never` to skip
configured preloading and require the image to provide MCP already. When the
policy is `never`, `mcp.loadScript` may be omitted.

Optional SSH key paths can be supplied per image:

```json
{
  "git": {
    "transport": "ssh",
    "ssh": {
      "publicKey": "C:\\Users\\you\\.ssh\\id_rsa.pub",
      "privateKey": "C:\\Users\\you\\.ssh\\id_rsa"
    }
  }
}
```

For `https` or `http`, an image can provide `plainCredentials` with a username
and password/token. PLexus writes these settings into the generated Smalltalk
startup script because the PharoLauncher CLI does not expose a protocol switch
for image launch.

### Prepared Image Cache

A prepared image cache is a project-scoped PharoLauncher image that PLexus can
prepare once and copy into workspace runtime images later. The cache is
described in `plexus.project.json`; pharo-launcher-mcp still owns the low-level
launcher calls.

By default, PLexus passes one project-scoped pharo-launcher-mcp profile for all
workspaces in the project. Workspace isolation comes from PLexus state, rendered
runtime image names, scoped `imageId` handles, and cleanup policy, while cache
images remain reusable inside that project-owned launcher profile.

```json
{
  "preparedImages": [
    {
      "id": "pharo-13-mcp",
      "imageName": "SampleProject-{projectId}-{cacheId}",
      "source": {
        "kind": "template",
        "profileId": "pharo-13-default",
        "templateName": "Pharo 13.0 - 64bit (stable)"
      },
      "mcp": {
        "loadScript": "pharo/load-mcp.st",
        "repository": {
          "githubUser": "ExampleOrg",
          "project": "SampleMCP",
          "commitish": "main",
          "path": "",
          "baseline": "MCP"
        }
      }
    }
  ],
  "images": [
    {
      "id": "dev",
      "imageName": "SampleProject-{workspaceId}-dev",
      "active": true,
      "preparedImage": {
        "cacheId": "pharo-13-mcp",
        "copyMode": "copy-on-open"
      },
      "mcp": {
        "loadScript": "pharo/load-mcp.st"
      }
    }
  ]
}
```

Prepared cache names are project-scoped. Supported cache-name template tokens
are:

```text
{projectId}
{projectName}
{cacheId}
```

PLexus can statically validate these specs and generate the preparation script
under:

```text
<state-root>/projects/<project-id>/prepared-images/prepare-<cache-id>.st
```

Creating the cache image from a launcher template, copying it into a workspace
runtime image, and deleting it are live PharoLauncher mutations. Those operations
require an approved runner boundary. Without that approval, `project open`
fails before copying or launching an image that requests `copy-on-open`.

### PLexus Home Image Cache

PLexus also has a home context for reusable state that is not tied to one
project checkout. The default home path is `~/.plexus`; set `PLEXUS_HOME` to
override it for a process, or use optional project config to override or disable
the image cache for one project:

```json
{
  "home": {
    "path": "/home/user/.plexus",
    "imageCache": {
      "enabled": true
    }
  }
}
```

The home image cache is intended for template-created base images. PLexus
derives a content key from the launcher template identity, normalized Pharo
version, architecture/VM metadata when available, Pharo MCP support policy, MCP
load script/repository identity, Git transport policy, and the PLexus cache
schema version. Moose templates are classified by the underlying Pharo version,
so a Moose 13 template is treated as Pharo 13 for Pharo MCP preparation.

Home cache entries live under:

```text
<PLEXUS_HOME>/image-cache/entries/<cache-key>/manifest.json
<PLEXUS_HOME>/image-cache/entries/<cache-key>/prepare.st
<PLEXUS_HOME>/image-cache/locks/<cache-key>/lock.json
```

The prepared base image lives in an explicit home-level pharo-launcher-mcp
profile under:

```text
<PLEXUS_HOME>/profiles/pharo-launcher-mcp/image-cache
```

Runtime workspace images must remain copies of home cache bases; agents must
not operate directly on home cache images. If a template's Pharo version is not
supported by the image-side Pharo MCP, PLexus may still cache the base image,
but it must skip the MCP load step and mark the manifest as not Pharo MCP
routable.

Because runtime images stay in project-owned launcher profiles while home cache
bases live in a home-owned launcher profile, PLexus uses the launcher-owned
`pharo_launcher_image_copy_between_profiles` tool rather than raw filesystem
copying. On a miss PLexus updates the home profile template catalog, creates the
cache image, starts it headlessly when Pharo MCP is supported, loads MCP,
snapshots, and quits. On a hit PLexus copies the cached base into the project
launcher profile and starts only the project-owned runtime image.

Project MCP tools expose the operational surface:

```text
plexus_home_image_cache_status({ projectPath, key? })
plexus_home_image_cache_flush({ projectPath, key?, confirm: true })
```

Flush deletes the home-profile launcher image before removing PLexus cache
metadata.

## Routing Rules

Split routing into two layers:

### PLexus (Lifecycle)

PLexus lifecycle tools (for example `plexus_project_open`, `plexus_project_close`, `plexus_project_status`) accept project references in three forms:

```text
projectPath
targetId
projectId + workspaceId
```

`projectPath` is the most convenient form when starting from a local worktree path. If `workspaceId` is omitted, PLexus derives it from the path basename.

`targetId` is the most precise route key and should be preferred when a caller already knows it.

`projectId + workspaceId` is the stable pair to use when starting from agent
runner project identity and worktree identity.

### PLexus Gateway (Routing Only)

Gateway proxy calls should route using the gateway's in-memory registrations keyed by `targetId`. The gateway should not resolve projects from disk or derive workspace identity from `projectPath`; that work belongs in PLexus, which then registers/updates routes in the gateway.

`projectId` alone can list all registered targets for that project. It must not be used for image routing when more than one workspace is registered, because the image id may exist in several workspaces.

Project/workspace lifecycle tools (`plexus_project_open`, `plexus_project_close`, `plexus_project_status`) belong to PLexus and are exposed as the `plexus_project` lifecycle surface. Gateway route registration/status/cleanup tools belong to PLexus Gateway route-control plumbing for PLexus core or operators. The normal agent-facing Pharo MCP proxy is the `pharo_gateway` server; raw `plexus_route_to_image` is an explicit opt-in escape hatch, not part of default agent config. See `docs/package-boundaries.md`.

In HTTP service mode, route-control should not require a second route table.
Run one gateway process and expose separate MCP paths, such as `/mcp` for
agent-facing `pharo_gateway` tools and `/control-mcp` for route-control. Both paths
share the in-memory registrations keyed by `targetId`.

## Port And Image Isolation

Parallel worktrees must not share image names or image MCP endpoints.

For the fixed-port fallback, PLexus handles dynamic ports by scanning sibling workspace state under the shared state root and reserving ports used by non-stopped images.

Fixed `mcp.port` values are allowed, but they are not parallel-friendly. If another active workspace for the same project already reserves the configured port, `project open` fails instead of starting two workers on the same port.

PLexus does not create naming conventions on behalf of projects. It only
renders the configured image-name template. The project owns conventions like
`SampleProject-{workspaceId}-dev`.

## Scoped Context For Plugins

DevNexus plugins and subagents should receive PLexus context as scoped data,
not as host-wide PharoLauncher names. The core context model is keyed by:

```text
projectId
workspaceId
targetId
imageId
```

The scoped context includes:

- the project id, project name, workspace id, and target id
- each declared image's public `imageId`
- ownership metadata showing that the image belongs to the current
  project/workspace/target and is disposable with the workspace
- safe create/start/stop/reset affordance descriptions that use scoped
  `imageId` arguments only
- gateway route metadata telling subagents to pass the selected `imageId` to
  `pharo_gateway` tools

The context validator rejects runtime state from a different project, workspace,
or target. It also rejects state images that are not declared in the project
config, so a plugin cannot smuggle arbitrary host images into the scoped agent
surface.

Deletion remains a workspace cleanup policy. Scoped reset is the destructive
workflow for disposable verification images and should report lifecycle plus
`pharo_gateway` route status for the resulting `imageId`. Normal agent-facing
context must not expose host-wide image delete, VM delete, raw process kill,
launcher image names, image MCP ports, or filesystem paths.

Operators can request the trusted diagnostic surface when debugging lifecycle
failures. For `plexus_project_status`, pass `includeDiagnostics: true` to include
raw runtime state, gateway endpoints, registered image MCP endpoints, route
status, port claims, process ids, launcher profile paths, and cleanup paths.
Those details are diagnostic data, not agent mutation handles.
When `refreshHealth: true` finds a managed project-local gateway whose owned
process/port claim is dead, status clears the stale gateway state, reports
`diagnostics.routeTable.status: "gateway-dead"`, and exposes a scoped
`plexus_project_open` repair affordance.

## Example

```text
PLexus project: Sample Project
  projectId: sample-project
    workspaceId: task-a
      targetId: sample-project--task-a
      images:
        dev -> SampleProject-task-a-dev via registered endpoint
        baseline -> SampleProject-task-a-baseline via registered endpoint
    workspaceId: task-b
      targetId: sample-project--task-b
      images:
        dev -> SampleProject-task-b-dev via registered endpoint
        baseline -> SampleProject-task-b-baseline via registered endpoint
```
