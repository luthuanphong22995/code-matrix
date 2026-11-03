---
title: Workspace Index
type: feature
created: 2026-11-03
version: 1
released: 0
---

# Feature: Workspace Index

## Intent
Index the open workspace with every available language frontend, show progress, and re-index changed files so the graph stays current without a full re-run. Every other feature reads the graph this one builds.

## Actors
- **developer** — wants to trigger indexing, see progress and per-file failures, and have edits reflected without a full re-run.

## Scope
**In**
- Automatic full run on first graph open; `Code Matrix: Re-index Workspace` command
- File selection: supported languages, `.gitignore` and `files.exclude`, 1 MB size cap
- Progress in the graph panel with Cancel; status bar state
- Completion summary with per-file failures in the output channel
- Single-file re-index on save, create, delete, rename and external on-disk change
- Queuing of changes that arrive during a full run
- Full run on every sidecar start and on workspace folder add/remove

**Out**
- Persistent on-disk index cache (full run on every sidecar start)
- Indexing unsaved editor buffers
- Progressive graph during a full run
- Graph rendering, filters and the "No supported source files found" display (`code-graph`)
- Sidecar lifecycle, restart budget and the status bar item itself (`app-shell`)
- Settings UI for exclusions or the size cap

## Rules
1. Indexing starts automatically when the graph panel is first opened for a workspace, and `Code Matrix: Re-index Workspace` starts a full run at any time. (v1)
2. A file is indexed when its extension belongs to an available frontend (`.java`; `.ts`, `.tsx`, `.js`, `.jsx`; `.py`; `.go`), it is not matched by `.gitignore` or VS Code `files.exclude`, and it is at most 1 MB; a larger file is skipped and logged as skipped, never counted as failed. (v1)
3. During a full run the graph panel shows "Indexing N of M files" with a Cancel action, and the status bar shows "Code Matrix: indexing". (v1)
4. The graph is published only when a full run completes; no partial graph is shown during a run. (v1)
5. During a re-run the previous complete graph stays visible with progress shown over it; the first run of a workspace shows progress only. (v1)
6. On completion the panel shows "Indexed N files" or, when any file failed, "Indexed N files, F failed"; each failed file and its reason is written to the "Code Matrix" output channel; a failed file stays in the graph as a file node with no symbols. (v1)
7. Saving, creating, deleting or renaming an indexed file, or an on-disk change made outside VS Code, re-indexes that file only; edges from other files to its symbols are re-resolved, references to symbols that no longer exist become Unresolved edges, and the graph is republished. (v1)
8. Watcher events received during a full run are queued and applied in order after the run completes, then the graph is published once. (v1)
9. Cancelling a run discards its partial results; the previous complete graph stays if there is one, otherwise the panel shows "Indexing cancelled" with a "Re-index" action. (v1)
10. Running `Code Matrix: Re-index Workspace` while a run is in progress cancels that run and starts a new full run. (v1)
11. The index is held in memory only: every sidecar start triggers a full run. (v1)
12. After the app shell silently restarts the sidecar while the graph panel is open, the full run starts automatically without developer action. (v1)
13. A skipped file (over the size cap or excluded) has no node in the graph; references to its symbols from indexed files are Unresolved edges. (v1)
14. Adding or removing a workspace folder triggers a full run. (v1)
15. A change to a file in an unsupported language or an excluded path triggers no re-index. (v1)

## Journeys
- **index a workspace** — developer opens the graph for the first time and watches the workspace indexed to a complete graph, with skipped and failed files reported. (v1)
- **keep the graph current** — developer edits, adds, deletes and renames files and sees the graph follow without a full re-run. (v1)
- **re-run or cancel indexing** — developer forces a full re-index, or cancels a run that is taking too long, and always keeps a usable state. (v1)

## Capabilities
- none yet

## Versions
- v1 — automatic and manual full runs, file selection, progress and cancel, failure reporting, single-file re-index on change — opened 2026-11-03
