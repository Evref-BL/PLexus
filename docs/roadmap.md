# Roadmap

## 1. MCP-PL: PharoLauncher CLI Contract On Windows

- Verify `clap launcher image list --ston`.
- Verify `clap launcher image info --ston`.
- Verify `clap launcher process list`.
- Verify `clap launcher vm list --ston`.
- Document which commands emit STON and which need text parsing.

This work lives in the sibling `MCP-PL` repository.

## 2. PLexus: Kanban And Worktree Model

- Define how Vibe Kanban tasks map to Git worktrees.
- Define how worktrees map to target images.
- Keep runtime state per `projectId` and `workspaceId`.
- Reserve allocated ports across sibling workspaces under a shared state root.
- Store enough metadata to recreate a target after a crash.

## 3. Target Registry

- Keep `targetId` stable for one project workspace.
- Map target to worktree, branch, image, VM, PID, port, token, and status.
- Persist registry and workspace state outside Pharo image state.
- Add lock files or SQLite before multiple PLexus processes can open targets concurrently.

## 4. MCP-PL Integration

- Configure MCP-PL as the PharoLauncher lifecycle provider.
- Call MCP-PL for image creation, process listing, and worker launch.
- Keep PLexus policy separate from MCP-PL's CLI adapter.

## 5. In-Image Worker Bootstrap

- Start the existing Pharo MCP worker inside one image.
- Bind to localhost.
- Use per-worker token.
- Report health and loaded project status.

## 6. Routing

- Add `targetId` to routed Pharo tools.
- Forward calls to the selected worker.
- Handle worker crash, timeout, and restart.

## 7. Recovery

- Recreate target image from a base image.
- Reload the worktree.
- Clean stale registry rows.
- Add safe delete/reset workflows.
