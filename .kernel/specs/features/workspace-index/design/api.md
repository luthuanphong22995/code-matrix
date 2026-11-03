# Workspace Index — API

Extends the shell's two interfaces (`.kernel/specs/features/app-shell/design/api.md`) with
`index/*` methods and one command.

## 1. Sidecar JSON-RPC: `index/*`

All require a successful `initialize`.

### Requests (extension → sidecar)

| Method | Params | Result | Errors |
|---|---|---|---|
| `index/run` | `{ roots: string[], exclude: string[] }` — absolute root paths (authoritative for this run; sent again when folders are added or removed, R14) and the VS Code `files.exclude` globs that are enabled | `{ runId: number }` returned at once; progress and outcome arrive as notifications. Cancels any run in progress first (R10) | `-32002 NotInitialized`; `-32001 InvalidRoots` |
| `index/cancel` | `{ runId: number }` | `{ cancelled: boolean }` — `false` when that run had already finished | — |

### Notifications (extension → sidecar)

| Method | Params | When |
|---|---|---|
| `index/filesChanged` | `{ changes: { path: string, type: "created" \| "changed" \| "deleted" }[] }` — absolute paths | From the file watcher. The extension sends only supported extensions not matched by `files.exclude` (R15); the sidecar applies `.gitignore` and the size cap (R2). A rename is `deleted` then `created`. During a full run the sidecar queues them (R8) |

### Notifications (sidecar → extension)

| Method | Params | When |
|---|---|---|
| `index/progress` | `{ runId, phase: "scanning" \| "indexing", done: number, total: number }` | at most every 100 ms while a run is in progress; `total` is 0 while scanning (R3) |
| `index/done` | `{ runId, outcome: "complete" \| "cancelled", indexed: number, failed: number, skipped: number, durationMs: number }` | once per run (R6, R9) |
| `$/status` (shell) | `{ state: "indexing" }` at run start, `{ state: "ready" }` at `index/done` | drives the status bar (R3) |
| `$/log` (shell) | `{ level, message }` with the lines in `ui.md § Output channel lines`; `Failed` lines are `error`, `Skipped` lines `warn`, the rest `info` | per event |
| `graph/changed` (code-graph) | `{ removedNodeIds }` | after every complete run and after every single-file re-index; never after a cancelled run (R4, R7) |

`graph/*` requests before the first complete run are answered with `-32010 NotIndexed`
(code-graph's error); the extension does not send them until the first `index/done` with
`outcome: "complete"`.

## 2. Webview messages: `index/*`

| Direction | `type` | Payload | Effect |
|---|---|---|---|
| ext → webview | `index/progress` | `{ phase, done, total }` | strip shows `Scanning workspace…` or `Indexing <done> of <total> files` |
| ext → webview | `index/done` | `{ outcome, indexed, failed, skipped, hadGraph: boolean }` | `complete`: strip shows the summary; `cancelled`: strip hidden, and when `hadGraph` is false the canvas shows the cancelled overlay |
| webview → ext | `index/run` | none | `Re-index` toolbar button or the cancelled overlay's `Re-index` |
| webview → ext | `index/cancel` | none | strip `Cancel` |
| webview → ext | `shell/showLog` (shell) | none | strip `Show Log` |

## 3. VS Code contributions

| Contribution | Id / label / detail |
|---|---|
| command | `codeMatrix.reindex` — `Code Matrix: Re-index Workspace`. Enabled when the sidecar is `ready` or `indexing`; otherwise shows the information toast `Code Matrix server is not running` |
| file watcher | one `FileSystemWatcher` per workspace root over `**/*.{java,ts,tsx,js,jsx,py,go}`, created / changed / deleted; catches saves and external on-disk changes (R7). Events are batched per 100 ms into one `index/filesChanged` |
| workspace folders listener | `onDidChangeWorkspaceFolders` → log `Workspace roots changed, starting full run` → `index/run` with the new roots (R14) |
| trigger on ready | on every shell transition to `ready` from `starting` while the graph panel is open → `index/run` (R1, R11, R12) |

Activation adds nothing: the watcher is created when the sidecar first becomes ready and
disposed when it exits.

**Rules**: R1, R2, R3, R4, R6, R7, R8, R9, R10, R11, R12, R14, R15
