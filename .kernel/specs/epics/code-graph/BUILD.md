---
title: Code Graph — first end-to-end graph — Build Plan
type: build-plan
epic: code-graph
status: draft
created: 2026-11-03
---

# Build Plan: Code Graph — first end-to-end graph

Per wave: `/plan:epic code-graph` plans the next wave, you review its proposals, then
`/build:epic code-graph` builds it and marks each change done here as it lands. Running
`/build:epic` is the approval.

Or let the loop build it: commit an empty `.loop` file next to this one. You approve each
wave's proposals and then its code at the loop's gates. Note: `.kernel/` is currently in
`.gitignore`, so the `.loop` file (and this folder) cannot be committed until that line is
removed or negated.

Append `⏸ held` to a change to hold it back — anything depending on it waits too.

## Wave 1 — foundation
- **01-project-init** — cargo workspace with empty `ir`/`rpc`/`index`/`export` crates and a `frontend/*` glob, extension scaffold with esbuild + vitest + test-electron, binary staging script, CI on three OSes.
      Capabilities: none (scaffolding; resolves two `OVERVIEW.md` TBDs)
      Touches: `core/Cargo.toml`, `core/{ir,rpc,index,export}/`, `extension/package.json`, `extension/esbuild.mjs`, `extension/scripts/stage-server.mjs`, `extension/test/`, `.github/workflows/ci.yml`, `.gitignore`, `README.md`
      Done when: `cargo clippy -D warnings && cargo test` and `npm run build && npm test` pass, and `vsce package` yields a `.vsix` containing `dist/` and `bin/`.

## Wave 2 — needs wave 1, two changes in parallel (disjoint crates)
- **02-ir-graph-model** — nodes, edges, stable ids, one placeholder per raw name, `Graph` store with per-file ownership, two-phase `Frontend` trait, `SymbolTable`.
      Capabilities: creates `core/ir`
      Touches: `core/ir/src/{node,edge,id,graph,symbols,frontend}.rs`, `core/ir/tests/`
      Done when: id-stability, placeholder-dedupe, `remove_file` and `FakeFrontend` resolve tests pass and `ir` has no project-internal dependency.
- **03-sidecar-rpc-skeleton** — `code-matrix-server`: `Content-Length` framing, dispatch, `initialize`/`shutdown`, `$/status`, `$/log`, `NotInitialized`, `InvalidRoots`.
      Capabilities: creates `core/rpc-transport`
      Touches: `core/rpc/src/{transport,protocol,server,main}.rs`, `core/rpc/tests/`
      Done when: a spawned binary answers `initialize` then `shutdown` and exits 0, and a pre-initialize request gets `-32002`.

## Wave 3 — needs wave 2, six changes in parallel (shared `core/Cargo.lock` only)
- **04-frontend-go** — `.go` extraction (struct/interface → class, func/method → function), module-aware package resolution, `fixtures/go` mirroring the scenarios, snapshots.
      Capabilities: creates `core/frontend-go`
      Touches: `core/frontend/go/`, `fixtures/go/`
      Done when: snapshots show every node/edge kind, a resolved and an unresolved import, and `main → fetchData` as `calls, resolved: false`.
- **05-frontend-typescript** — `.ts/.tsx/.js/.jsx` extraction, relative-path probing, import map binding, `fixtures/typescript`, snapshots.
      Capabilities: creates `core/frontend-typescript`
      Touches: `core/frontend/typescript/`, `fixtures/typescript/`
      Done when: snapshots cover each probe rule, bare-specifier placeholders, named/namespace/`new` calls, and `.js`/`.jsx` files produce nodes.
- **06-frontend-python** — `.py` extraction, dotted/relative import resolution, `self.m()` binding, `fixtures/python`, snapshots.
      Capabilities: creates `core/frontend-python`
      Touches: `core/frontend/python/`, `fixtures/python/`
      Done when: snapshots cover absolute/aliased/from/relative/package imports and `import os` as a placeholder.
- **07-frontend-java** — `.java` extraction (class/interface/enum/record/nested), declared-package binding, superclass-chain calls, `fixtures/java`, snapshots.
      Capabilities: creates `core/frontend-java`
      Touches: `core/frontend/java/`, `fixtures/java/`
      Done when: snapshots cover import-by-package, wildcard/JDK placeholders, static import, inherited and constructor calls; a type resolves by declared package, not directory.
- **08-workspace-index-core** — `FrontendRegistry`, `.gitignore`-aware walk, extension + 1 MiB selection, parallel extract, per-language resolve, `IndexStore::publish` returning removed ids, `RunEvents`.
      Capabilities: creates `core/index`
      Touches: `core/index/src/{registry,walk,run,store}.rs`, `core/index/tests/`
      Done when: a fake-frontend run over a temp workspace reports indexed/failed/skipped exactly, a failed file is a bare `File` node, and `publish` returns the removed ids.
- **09-shell-panel-and-sidecar** — commands, singleton `codeMatrix.graph` panel with toolbar/overlays/Details frame and a `MessageRouter`, `Sidecar` state machine with binary resolution, JSON-RPC client, status bar, output channel, workspace guard.
      Capabilities: creates `extension/shell-panel`, `extension/sidecar-client`
      Touches: `extension/package.json`, `extension/src/{extension,sidecar,jsonrpc,protocol,panel,statusBar}.ts`, `extension/webview/src/{main,shell}.ts`, `extension/test/`
      Done when: `Open Graph` on `fixtures/go` yields one panel and `Code Matrix: ready`; no folder → `Open a folder to analyze`; missing binary → failed overlay with the designed cause.

## Wave 4 — needs wave 3, two changes in parallel (core vs extension)
- **10-graph-rpc** — `export` projection (`files_layer`, `expand`, `node_detail`), `graph/files`, `graph/expand`, `graph/node`, `-32010`/`-32011`, full run after `initialize` with `$/status`/`$/log`/`graph/changed`, four frontends registered.
      Capabilities: creates `core/graph-rpc`, `core/export` · modifies `core/rpc-transport`
      Touches: `core/export/src/`, `core/rpc/src/{protocol,server,main,run_events}.rs`, `core/rpc/src/handlers/graph.rs`, `core/rpc/tests/graph.rs`
      Done when: end to end over `fixtures/go` the notification order is `indexing`, `ready`, `graph/changed` and `graph/expand` on `main.go` returns the unresolved `fetchData` edge + placeholder.
- **11-sidecar-recovery** — one silent restart with a 60 s window, failed state on the second exit, `Retry` resets the budget, `Restart Server` never counts, exit classification table.
      Capabilities: modifies `extension/sidecar-client`, `extension/shell-panel`
      Touches: `extension/src/{sidecar,panel,extension}.ts`, `extension/webview/src/shell.ts`, `extension/test/`
      Done when: two kills within 60 s reach the failed overlay with `Process exited with code N` and `Retry` returns to `ready`; one kill restarts silently with only a log line.

## Wave 5 — needs wave 4
- **12-graph-canvas** — Cytoscape canvas: file layer + imports, expand/collapse via `graph/expand`, both-ends edge rule, placeholder drawing, selection → Details with Expand/Collapse and edge counts, `No supported source files found`, counts; `shell/openNode` emitted on double-click/Enter.
      Capabilities: creates `extension/graph-canvas` · modifies `extension/shell-panel`
      Touches: `extension/package.json` (cytoscape), `extension/src/{graphController,panel,protocol}.ts`, `extension/webview/src/{graph,styles,details,toolbar,main}.ts`, `extension/test/`
      Done when: over `fixtures/go` the default view is files + imports only, expanding `main.go` draws `main → parseConfig` and the dashed `fetchData` placeholder, and selecting `parseConfig` shows `in · calls: 1`.

## Wave 6 — needs wave 5, two changes in parallel (extension host vs webview)
- **13-jump-to-source** — node id → `Uri` + `Range` (multi-root aware), open beside the panel with the range revealed, `File not found: <path>` toast keeping the selection, Escape clears selection.
      Capabilities: creates `extension/jump-to-source` · modifies `extension/shell-panel`
      Touches: `extension/src/{openNode,panel}.ts`, `extension/test/`
      Done when: `shell/openNode` on `parseConfig` opens `config.go` beside the panel on its line, and a deleted file yields the toast with the selection unchanged.
- **14-graph-narrowing** — search, in-house glob → RegExp, kind toggles with R5 defaults, focus + hops with snapshot restore, `computeVisible` pipeline, 2,000 cap and too-large state, filtered-empty state.
      Capabilities: creates `extension/graph-narrowing` · modifies `extension/graph-canvas`
      Touches: `extension/webview/src/{state,filters,glob,search,focus,toolbar,graph,main}.ts`, `extension/test/`
      Done when: every scenario under `find a symbol` and `narrow a large graph` passes, including 2,500 files → too-large and 300 after a glob.

## Wave 7 — needs wave 6
- **15-graph-refresh** — on `graph/changed` re-fetch files + remembered expansions into one `graph/refresh`, atomic swap keeping the old graph visible, re-apply expansion/filters/focus/selection to surviving ids, clear what was removed.
      Capabilities: modifies `extension/graph-canvas`, `extension/graph-narrowing`
      Touches: `extension/src/{graphController,protocol}.ts`, `extension/webview/src/{main,graph,state,focus}.ts`, `extension/test/`
      Done when: after `Restart Server`, `config.go` stays expanded, `parseConfig` stays selected and references stays on; after deleting `config.go` and restarting, both nodes are gone and nothing is selected.

## Beyond the changes themselves
- **`.kernel/specs/capabilities/`**: creates `core/ir`, `core/rpc-transport`, `core/frontend-go`, `core/frontend-typescript`, `core/frontend-python`, `core/frontend-java`, `core/index`, `core/graph-rpc`, `core/export`, `extension/shell-panel`, `extension/sidecar-client`, `extension/graph-canvas`, `extension/jump-to-source`, `extension/graph-narrowing`. Nested by service (`core/`, `extension/`), so `capabilities/core/OVERVIEW.md` and `capabilities/extension/OVERVIEW.md` (with `DependsOn: core` on the extension side) are written at the first close-out of each service. Nothing is overwritten (empty corpus).
- **`.kernel/specs/OVERVIEW.md`**: change 01 resolves the TBDs "supported VS Code minimum version" (`^1.90.0`) and "binary distribution" (bundled per platform under `extension/bin/`); change 12 resolves "Cytoscape.js or Sigma.js" to Cytoscape.js. "on-disk cache format" stays TBD (workspace-index epic). No section moves.
- **Feature specs**: each change's close-out should add its capability id under the feature's `## Capabilities` (`code-graph`, `app-shell`, `workspace-index` for 08).

## Decided without you
- **Capability ids nested by service** (`core/…`, `extension/…`) per the capabilities README's multi-service convention. Flat ids are a one-line change per file if you prefer.
- **Two-phase `Frontend` trait** (`extract` per file, `resolve` per language over all files) with a documented, optional extension point for CFG/def-use so `data-flow` can land without rewriting frontends.
- **Unresolved placeholders are one per raw name workspace-wide**, so `fetchData` called from two files is one node with two dashed edges.
- **Node id** = fixed-seed 64-bit hash of `(kind, path, qualified name)`; edge id of `(kind, from, to)`.
- **Method parents**: Java/TypeScript/Python methods hang under their class; Go methods hang under the receiver's struct/interface node when it is in the same package, else under the file. TS `interface`/`enum` and Java `interface`/`enum`/`record` map to `class`; type aliases and fields are not nodes; Java overloads collapse into one function node.
- **Resolution limits in v1**: no type inference (`obj.m()` is unresolved everywhere), no `tsconfig` `paths`, no `sys.path`/virtualenv, no Go vendoring; Go imports edge to every file of the imported package.
- **`files.exclude` not honoured** (no plumbing in `initialize`); `.gitignore` and the 1 MiB cap are.
- **`graph/changed` after every full run including the first** is the single trigger for the extension to fetch the graph; 15 folds the initial fetch into the same `graph/refresh` path.
- **Multi-root paths** are prefixed with the root's basename to stay unique.
- **Cytoscape layout** = built-in `cose`; no `dagre` dependency. Webview is plain TS, no framework; `cytoscape` is the only runtime npm dependency.
- **Glob matching** is an in-house `globToRegExp` (`**`, `*`, `?`, `[...]`, `{a,b}`), no npm dependency; invalid = unterminated `[`/`{` or trailing `\`.
- **VS Code engine** `^1.90.0`; webview `retainContextWhenHidden: true`.
- **Test harness**: `insta` snapshots in Rust; `vitest` for pure TS and headless Cytoscape; `@vscode/test-electron` for integration over `fixtures/go`. Tests may add a test-only `graph/debugState` webview message.
- **`Retry` before change 11** behaves as a plain restart; 11 adds the budget reset.

## Risks
- **02 is read by every later change.** A reshaped `Frontend` trait after wave 3 rewrites four frontends and the index; settle the data-flow extension point before planning 02.
- **Shared `core/Cargo.lock` across wave 3** — five crates add dependencies in parallel worktrees; expect a lockfile merge each time and run `cargo build` after merging. Grammar crates must all agree with the pinned `tree-sitter` version (01 pins it; check before pinning).
- **09 is the largest change** (process wrapper, JSON-RPC client, panel, webview shell, status bar, tests). If `/plan:change` produces more than ~12 tasks, split the webview shell out as its own change before building.
- **Integration tests depend on a staged binary**: every extension integration test from 09 on needs `stage-server` to have run; CI must build `core` before `extension` tests.
- **15 changes the initial-load path of 12** (`graph/files` post → `graph/refresh`); 12's integration tests must still pass after 15.
- **`.kernel/` is git-ignored**, so this epic, its waves' change artifacts and the capability corpus are not versioned until that is changed; the loop flow cannot run on an ignored `.loop` file.

## Progress
<!-- Appended by /build:epic: change · result · commit. -->
