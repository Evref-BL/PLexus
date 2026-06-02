# Runtime Model

PLexus models Pharo runtime work as project, workspace, target, image, and
route state.

## Arity

```text
PLexus project    1:N  PLexus workspaces
PLexus workspace  1:1  runtime target
runtime target    1:N  Pharo images
Pharo image       1:1  image-local MCP worker when running
```

## Project

A PLexus project is the source root with `plexus.project.json`.

```json
{
  "id": "sample-project",
  "name": "SampleProject"
}
```

The project id is stable logical identity. It is not enough by itself for
runtime routing when parallel workspaces are open.

## Workspace

A workspace is one isolated runtime instance of a project. It is usually backed
by one Git worktree.

The workspace runtime contract is generic. A caller supplies a project root and
may treat that same path as the workspace source path unless it explicitly
declares another source path. PLexus reports the resolved source path in scoped
status as the default place where project code should be loaded from.

The `workspaceId` comes from:

```text
--workspace-id
PLEXUS_WORKSPACE_ID
VIBE_KANBAN_WORKSPACE_ID
default project root directory name
```

Workspace-scoped runtime state lives under:

```text
<state-root>/projects/<project-id>/workspaces/<workspace-id>/state.json
```

Use one shared state root across sibling workspaces.

The scoped status context reports these workspace policies:

```text
source policy: caller-managed
image policy: project-config declarations with scoped imageId handles
route policy: pharo_gateway target route with imageId arguments
cleanup policy: workspace_cleanup_only
```

## Target

A runtime target is the routable identity for one workspace.

By default:

```text
targetId = <project-id>--<workspace-id>
```

PLexus lifecycle tools can derive this from project and workspace identity.
Gateway route-control stores routes by `targetId`.

## Image

A target can manage several Pharo images. Each image has:

```text
imageId
rendered launcher image name
runtime MCP endpoint
optional assigned MCP port fallback
optional process pid
status and health
```

`imageId` is the handle agents use. It is stable only inside one project and
workspace.

Image names should include workspace identity when parallel worktrees are
possible:

```json
{
  "id": "dev",
  "imageName": "SampleProject-{workspaceId}-dev",
  "active": true
}
```

Supported tokens are:

```text
{projectId}
{projectName}
{workspaceId}
{targetId}
{imageId}
```

## Routes

PLexus Gateway owns route tables. PLexus core owns orchestration and registers
resolved routes through the trusted route-control surface.

The normal flow is:

```text
plexus project open
  -> start or inspect scoped images
  -> write runtime state
  -> register target routes through route-control
agent gateway call
  -> pass imageId
  -> gateway validates route and image ownership
  -> gateway forwards to the image-local MCP worker
```

Agents should not register routes directly.

## State Root

The state root stores runtime state outside images:

```text
<state-root>/projects/<project-id>/workspaces/<workspace-id>/state.json
```

It should be shared by sibling worktrees for the same host boundary. That lets
PLexus avoid port and image-name collisions before starting images.

## Home Image Cache

PLexus can use a home-level image cache for template-created base images. The
default home is `~/.plexus`; `PLEXUS_HOME` overrides it.

The cache stores manifests and preparation scripts under:

```text
<PLEXUS_HOME>/image-cache
```

Cache base images live in an explicit home-level pharo-launcher-mcp profile.
Runtime images still belong to project-owned launcher profiles, so cache
materialization remains a live launcher mutation and requires an approved runner
boundary.

## Outside-Image Boundary

PLexus exists outside Pharo images so runtime control survives image failures.
If an image crashes, fails to load MCP, or has incompatible code, PLexus can
still inspect state, close the target, unregister routes, plan rescue, or create
a replacement target.
