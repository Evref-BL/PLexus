# Isolated Live-Smoke Runner Boundary

This boundary defines what must be true before a caller authorizes a PLexus
live smoke. It is a PLexus planning contract for disposable runtime checks, not
permission for ad hoc host mutation. Until an approval record names the runner
boundary, contributors may update documentation and run static checks, but they
must not run `plexus project open`, `plexus project close`, Docker, Pharo
Launcher image launches, gateway live probes, or host process mutation.

## Runner Ownership

The live smoke runner is the only owner of runtime side effects. Callers may
request a smoke, but they must not directly start images or mutate host
processes outside the runner.

The runner must:

- allocate a unique `runId`, `workspaceId`, and `targetId` for the smoke
- create all runtime files under a disposable state root
- pass the state root, workspace id, and target id explicitly to PLexus
- record every command it runs and the environment variables it sets
- retain enough logs and state snapshots for diagnosis before cleanup
- run cleanup even when setup, launch, health checks, routing, or close fails

## Disposable Inputs

A future approved run must use disposable inputs only:

- a temp PLexus project directory or an explicitly throwaway project fixture
- a temp `PLEXUS_STATE_ROOT` or `--state-root` outside source checkouts
- image names rendered from the unique `workspaceId` and `imageId`
- dynamic MCP ports or ports reserved from the disposable state root
- copied images or temporary images, never a mutable shared source image
- a source image or template named in the approval record
- no package installs, Git cleanup, commit, push, pull, or fetch

Fixed image names and fixed ports are not acceptable for concurrent live smokes
because they can collide with another workspace.

## Cleanup Responsibilities

Cleanup belongs to the runner and must be idempotent. It must:

- call PLexus project close for the same project, workspace, target, and state
  root used for open
- verify gateway routes for the target are unregistered
- verify owned image processes are stopped
- delete only copied or temporary images created for the smoke
- remove disposable temp directories after retaining selected artifacts
- avoid killing processes that cannot be tied to the owned image name, target
  id, or recorded pid
- preserve the source image, user profiles, source repositories, and unrelated
  PLexus state

If close fails, the runner may use launcher cleanup hooks only for images and
pids it created and recorded.

## Timeouts And Failure State

Every phase needs a bounded timeout:

- setup and fixture creation
- project open and startup script execution
- process visibility and MCP health polling
- gateway route registration and routed read-only probe
- project close
- post-close process and route checks
- cleanup of copied images and temp directories

Timeouts must mark the target image state as `failed` or stopped through PLexus
state, retain stdout/stderr, and continue into cleanup. A timeout must not cause
the runner to widen cleanup to unrelated images or processes.

## Artifacts To Retain

Retain these artifacts before deleting disposable runtime directories:

- initial and final `git status --short --branch` for the owning repositories
- `plexus.project.json` fixture
- PLexus state snapshots before open, after open, and after close
- generated startup scripts
- gateway status snapshots
- command stdout/stderr and timeout metadata
- Pharo Launcher logs from the isolated profile
- the list of created image names, pids, assigned ports, and target ids

## Checks That Do Not Need Live Services

These checks are allowed without the isolated runner:

- static review of `plexus.project.json` fixtures and docs
- `git status --short --branch`
- TypeScript build, typecheck, and unit tests
- inspection of scripts and source files
- `git diff --check`

They must not invoke Pharo Launcher, start PLexus gateway routes, or launch
images.

## Checks Requiring The Runner

These checks require the isolated runner and explicit approval:

- `plexus project open`
- `plexus project close`
- `npm run prototype:open-close`
- `npm run smoke:open-route-close`
- gateway route registration or routed `pharo` calls
- process stop or image delete cleanup
- any check that starts, copies, saves, or deletes Pharo images

## Approval Criteria

Before a future live PLexus smoke is enabled, a human approval record must name:

- the source image or template
- the disposable state root pattern
- the expected project fixture and image specs
- the cleanup sequence and retained artifacts
- the timeout budget for each phase
- the allowed launcher cleanup hooks
- the policy for failures that leave a process running
- confirmation that source worktrees are clean or that unrelated changes are
  intentionally preserved

Without that approval, runtime and image work remains blocked at the planning
boundary.
