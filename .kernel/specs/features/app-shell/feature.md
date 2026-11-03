---
title: App Shell
type: feature
created: 2026-11-03
version: 1
released: 0
---

# Feature: App Shell

## Intent
The VS Code surface everything else lives in: commands, the graph webview panel, jump-to-source from a graph node, and status/error reporting when the sidecar is starting, busy, or failed. Every other feature places its screens inside it.

## Actors
- **developer** — wants to open the graph for the current workspace, navigate from graph to code, and know when analysis is unavailable and why.

## Scope
**In**
- Commands: `Code Matrix: Open Graph`, `Code Matrix: Restart Server`, `Code Matrix: Show Log`
- One graph panel per window, opened as an editor tab
- Node selection, node details, jump-to-source
- Status bar item reflecting sidecar state
- Sidecar lifecycle: lazy start, one silent restart, failed state with recovery
- Workspace guard: no folder open, multi-root workspace
- Sidecar binary bundled per platform in the .vsix

**Out**
- Graph rendering, layout and filters (`code-graph`)
- Indexing progress and re-index semantics (`workspace-index`)
- Data-flow highlighting and stepping (`data-flow`)
- Editor-cursor → graph-node sync
- Settings UI; downloading the binary at runtime

## Rules
1. `Code Matrix: Open Graph` opens the graph panel as an editor tab; at most one panel exists per window, and re-running the command focuses the existing one. (v1)
2. With no workspace folder open, `Open Graph` shows the message "Open a folder to analyze" and opens nothing. (v1)
3. A multi-root workspace is analyzed as one graph over all roots. (v1)
4. The sidecar starts lazily on the first `Open Graph`, not on extension activation, and is stopped when the window closes. (v1)
5. If the sidecar exits unexpectedly, the shell restarts it once silently; a second unexpected exit within 60 seconds puts the shell into the failed state. (v1)
6. In the failed state the graph panel shows the failure cause with the buttons "Retry" and "Show Log"; "Retry" resets the restart budget and starts the sidecar again. (v1)
7. The status bar item always shows the sidecar state as "Code Matrix: starting", "Code Matrix: ready", "Code Matrix: indexing" or "Code Matrix: failed"; clicking it opens the graph panel, or the log when failed. (v1)
8. A single click selects a node and shows its details (kind, name, file:line); double-click or Enter opens the node's file at its range in an editor beside the graph. (v1)
9. Jumping to a node whose file no longer exists shows "File not found: <path>" and keeps the selection. (v1)
10. All sidecar stdout and stderr goes to the "Code Matrix" output channel; `Show Log` opens it. (v1)
11. A sidecar binary missing for the current platform is a failure like any other, with the cause "Server binary not found for <platform>: <path>". (v1)

## Journeys
- **open the graph** — developer runs `Open Graph` on the current workspace and gets a live graph panel, or a clear reason why not. (v1)
- **jump to source** — developer selects a node in the graph and lands in its code. (v1)
- **recover from a failed sidecar** — developer sees that analysis stopped, reads the log, and retries. (v1)

## Capabilities
- none yet

## Versions
- v1 — commands, singleton graph panel, jump-to-source, status bar, sidecar lifecycle and recovery — opened 2026-11-03
