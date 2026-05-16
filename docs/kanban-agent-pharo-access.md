# Kanban Agent Pharo Access

This document defines the agent-facing MCP surface for Pharo image access from
Vibe Kanban workspaces. It is a design contract for PLexus; it is not the raw
pharo-launcher-mcp tool catalog.

## Goal

A Kanban-spawned agent should see two stable MCP servers:

- `pharo-launcher`: scoped image lifecycle tools for the current PLexus
  project/workspace.
- `gateway`: typed Pharo code tools for a selected image, exposed through a
  stable project-wide Pharo MCP contract.

The agent uses `pharo-launcher` to list, create, start, and stop images. It then
passes the returned `imageId` to `gateway` tool calls. The gateway facade strips
routing-only fields such as `imageId` before forwarding the call to the selected
image MCP server.

`pharo` may appear in older generated MCP config as a temporary compatibility
alias for the same facade. New configs should use the `gateway` server name and
`PLEXUS_GATEWAY_SURFACE=gateway`.

## Agent Workflow

When Vibe Kanban starts an agent for a PLexus-managed workspace, the agent should
follow this sequence:

1. Inspect the issue and worktree.
2. Use `pharo-launcher` to list workspace images.
3. Create or start the needed image through `pharo-launcher` if no suitable
   image is running.
4. Load or pull the project in that image using the project-specific Pharo tools
   exposed by `gateway`.
5. Pass the selected `imageId` into every `gateway` call.
6. Use `gateway` for normal code work: inspect classes, edit methods, run tests,
   and evaluate Smalltalk.
7. Stop or leave images according to the workspace policy; do not use raw
   host-wide launcher operations.

Example flow:

```text
pharo-launcher.image_list()
  -> [{ imageId: "dev", status: "running", health: { routable: true } }]

gateway.find_classes({ imageId: "dev", pattern: "MyPackage*" })
gateway.compile_method({ imageId: "dev", className: "MyClass", selector: "foo", source: "foo ^ 42" })
gateway.run_tests({ imageId: "dev", packageName: "MyPackage-Tests" })
```

If no image is running:

```text
pharo-launcher.image_create({ imageId: "dev", profileId: "pharo-13-default" })
pharo-launcher.image_start({ imageId: "dev" })
gateway.project_load({ imageId: "dev" })
```

The exact Pharo tool names come from the project Pharo MCP contract. The routing
rule is always the same: add `imageId` at the facade boundary; PLexus removes it
before forwarding to the image MCP server.

## Scope Boundary

The `pharo-launcher` MCP visible to a Kanban agent is a PLexus-scoped facade over
pharo-launcher-mcp. It can reuse pharo-launcher-mcp operations and naming where useful, but it must not
be raw host-wide PharoLauncher access.

Each agent session is scoped by PLexus before tools are exposed:

```text
projectId
workspaceId
targetId
projectRoot
stateRoot
allowed image profiles/specs
```

Tool calls must resolve images through that scope. A caller must not be able to
operate on an arbitrary PharoLauncher image by providing a raw image name, image
path, VM id, process id, or filesystem location.

PLexus generates the workspace MCP entries for this scope. The managed server
names are `pharo-launcher` and `gateway`; unrelated user MCP entries should be
preserved when those managed entries are updated.

Generated path environment values preserve the path style supplied by the
caller. Windows worktree and state roots stay in `C:\...` form, while POSIX
roots stay in `/...` form.

## Image Handles

`imageId` is the public handle for agents. It is a PLexus runtime handle, not a
PharoLauncher image name and not a path.

PLexus maps each handle to runtime state:

```json
{
  "projectId": "project-123",
  "workspaceId": "task-456",
  "targetId": "project-123--task-456",
  "imageId": "dev",
  "launcherImageName": "MyProject-task-456-dev",
  "port": 7100,
  "pid": 12345,
  "status": "running",
  "health": {
    "process": "running",
    "mcp": "healthy",
    "routable": true
  },
  "pharoMcpContract": {
    "id": "project-contract",
    "hash": "sha256:...",
    "status": "matching"
  }
}
```

The exact record can grow, but it should keep these properties:

- `imageId` is stable inside one `projectId` plus `workspaceId`.
- `launcherImageName` is diagnostic output, not a caller-controlled route key.
- `pharoMcpContract.status` is explicit so agents can tell whether an image can
  be used through the `pharo` facade.

## Agent-Facing Tools

The initial `pharo-launcher` surface should be deliberately small.

| Intent | Tool | Scope rule |
| --- | --- | --- |
| List workspace images | `pharo_launcher_image_list` | Return only images declared in, created by, or registered to the current PLexus workspace. Do not list all host images. |
| Inspect one workspace image | `pharo_launcher_image_info({ imageId })` | Resolve `imageId` through PLexus state, then call pharo-launcher-mcp only with the mapped launcher image name if needed. |
| Create a workspace image | `pharo_launcher_image_create({ imageId, profileId? })` | Create only from a project-approved image spec/profile. PLexus renders the launcher image name and records the handle before exposing it. |
| Start a workspace image | `pharo_launcher_image_start({ imageId })` | Start only a scoped image. PLexus supplies the generated startup script and assigned MCP port. |
| Stop a workspace image | `pharo_launcher_image_stop({ imageId, confirm: true })` | Stop only a scoped image. PLexus resolves the process; callers cannot kill by arbitrary pid. |

Do not expose these through the scoped surface by default:

- `pharo_launcher_raw_command`
- host-wide `pharo_launcher_image_delete`
- host-wide `pharo_launcher_image_recreate`
- host-wide `pharo_launcher_vm_delete`
- raw `pharo_launcher_process_kill({ pid })`
- arbitrary image package/export locations
- template or VM mutation tools unless a project policy explicitly allows them

Deletion and cleanup should remain a PLexus workspace cleanup policy until there
is a separate, scoped, reviewable workflow for destructive image removal.

## Create Policy

`pharo_launcher_image_create` must not accept arbitrary `newImageName`. PLexus
owns rendered image names so sibling Kanban workspaces cannot collide.

Valid creation inputs are policy-driven:

```json
{
  "imageId": "dev",
  "profileId": "pharo-13-default"
}
```

The profile resolves to one approved source, for example:

- a configured Pharo template and optional category
- a configured base image to copy
- a prepared project image cache entry

The facade may call different pharo-launcher-mcp tools underneath, such as
`pharo_launcher_image_create` or `pharo_launcher_image_copy`, but those raw
source names are chosen by PLexus policy, not by the agent.

## Status Values

The scoped facade should normalize image status so agents do not need to infer
state from PharoLauncher output:

```text
declared       configured in the workspace but not created yet
creating       creation is in progress
created        image exists but is not running
starting       launch is in progress
running        process is running and the MCP health check may be healthy
stopped        process is stopped
failed         last lifecycle operation failed
unavailable    PLexus cannot confirm the launcher image or process state
```

`health.routable` should be true only when the image is owned by the workspace,
the process is reachable, and the Pharo MCP contract is compatible with the
project contract.

## Error Behavior

Errors should be returned as MCP tool errors with stable codes and context:

| Code | Meaning |
| --- | --- |
| `image_not_found` | The `imageId` is not known in the current workspace. |
| `image_outside_workspace` | The requested image exists somewhere else but is not owned by this workspace. |
| `policy_rejected` | The requested creation/start/stop action is outside the project policy. |
| `launcher_unavailable` | pharo-launcher-mcp or PharoLauncher cannot be reached. |
| `image_already_exists` | Create would overwrite an existing scoped image. |
| `image_creation_failed` | pharo-launcher-mcp returned a creation failure. |
| `image_unavailable` | The mapped image cannot currently be inspected, launched, or stopped. |
| `contract_mismatch` | The image is not compatible with the project Pharo MCP contract. |

The facade must not recover from a scoped lookup failure by falling back to a
host-wide pharo-launcher-mcp call.

## Package Ownership

pharo-launcher-mcp remains the low-level PharoLauncher adapter. It accepts raw launcher names
and does not know about Kanban, workspaces, or PLexus policy.

PLexus owns the scoped `pharo-launcher` facade because it owns workspace state,
image naming policy, startup script generation, port allocation, and contract
compatibility.

PLexus Gateway remains routing-only. Its agent-facing `gateway` surface routes
typed Pharo MCP calls to image MCP servers, but it must not gain a dependency on
pharo-launcher-mcp to implement image lifecycle operations.

## Relationship To `gateway`

The `pharo-launcher` surface returns `imageId` handles. The separate `gateway`
surface consumes those handles:

```json
{
  "imageId": "dev",
  "className": "MyClass",
  "selector": "example",
  "source": "example ^ 42"
}
```

The gateway facade validates ownership and contract compatibility, strips
`imageId`, and forwards the remaining arguments to the selected image MCP
server. Its `tools/list` must remain stable while images are added, stopped, or
restarted.

Gateway status and the PLexus scoped context both include route metadata for
each image. That metadata names the `gateway` server, the required `imageId`
argument, the route reference (`projectId`, `workspaceId`, and `targetId`), and
the place a subagent should record the selected image handle before making
Pharo tool calls.

## Why The Tool List Is Stable

The gateway must not rewrite `gateway.tools/list` when images appear, disappear,
or restart. MCP clients can cache tool lists, and dynamically changing tool names
or schemas based on runtime image topology makes agent behavior brittle.

Instead, `gateway.tools/list` is generated from the project-wide Pharo MCP
contract. Runtime image state is represented in data:

- `pharo-launcher` reports which images exist and whether they are routable.
- Each `gateway` call carries `imageId`.
- PLexus rejects unavailable images, images outside the workspace, and contract
  mismatches before forwarding.

This keeps the agent contract stable while still allowing multiple images per
workspace.

## Routing Failures

Agents should treat routing errors as runtime state, not as missing tools:

| Situation | Meaning | Agent response |
| --- | --- | --- |
| `image_not_found` | The `imageId` is not known in this workspace. | List images and choose a valid handle. |
| `image_outside_workspace` | The image exists under another workspace/target. | Do not use it; create or select a workspace-owned image. |
| `image_unavailable` | The image is not running or cannot be reached. | Start or restart it through `pharo-launcher`. |
| `contract_unknown` | PLexus cannot confirm the image Pharo MCP contract. | Refresh status or recreate/prepare the image. |
| `contract_mismatch` | The image uses a different Pharo MCP contract from the project. | Do not route to it; recreate or prepare a compatible image. |

The invariant is strict: one PLexus project equals one Pharo MCP contract. If an
image has a different contract, it must not become routable through the project
`gateway` facade.
