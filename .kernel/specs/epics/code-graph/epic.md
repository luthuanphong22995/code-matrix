---
title: Code Graph — first end-to-end graph
type: epic
status: draft
created: 2026-11-03
tags: [epic, requirements, code-graph, app-shell, greenfield]
---

# Epic: Code Graph — first end-to-end graph

## Summary
A developer opens a workspace in VS Code, runs `Code Matrix: Open Graph`, and gets an
interactive files-first graph of the workspace: file nodes and import edges by default,
expandable into classes and functions with contains, calls and references edges, unresolved
references drawn distinctly, and the narrowing controls (search, path glob, kind toggles,
focus) that keep a large repo readable under the 2,000-node cap. Selecting a node shows its
details; double-click jumps to source. The graph survives a re-index with its expansion,
filters, focus and selection intact.

The repository has no application code yet, so this epic also lays the foundation the
`code-graph` feature stands on: the cargo workspace and extension scaffold, the
language-agnostic IR, the four tree-sitter frontends (go, typescript/js, python, java), an
in-memory full-run index, the JSON-RPC sidecar, and the app shell (panel, sidecar lifecycle,
recovery, jump-to-source). It deliberately builds only the non-UI core of `workspace-index`
(full run on sidecar start, file selection) — progress, cancel, watchers and single-file
re-index stay with that feature's own epic.

## Context
Greenfield. The repo holds `README.md`, `LICENSE`, `CLAUDE.md` and `.kernel/specs/`; the
capability corpus is empty (`sdlc caps list` → `no capabilities`), no changes are active or
archived. Everything below is grounded in `.kernel/specs/OVERVIEW.md` and the feature
specs, not in code.

Architecture (from `OVERVIEW.md`): sidecar + per-language frontends.
- `core/` — Rust 2021 cargo workspace, binary `code-matrix-server`. Crates `ir`, `rpc`,
  `index`, `export`, `frontend/<lang>`. Allowed edges: `rpc → index, export`;
  `index → frontend/*, ir`; `frontend/* → ir, tree-sitter`; `export → ir`; `ir → nothing`.
  `ir`/`export` must compile with zero frontends.
- `extension/` — TypeScript, UI only, minimal npm deps. Talks JSON-RPC 2.0 over stdio with
  LSP `Content-Length` framing. Protocol types defined once in Rust (`rpc` crate, serde) and
  mirrored in TS.
- Tests: `cargo test` against `fixtures/<lang>/` with snapshot tests; new frontend = new
  fixture repo + snapshots.

Seams that decide the change boundaries:
- **`ir` is the hub.** Frontends only produce it, `index` only stores it, `export` only
  projects it. It is the first core change and the one every later change reads.
- **Frontends never depend on each other** — four parallel changes, one crate + one fixture
  repo each, disjoint anchors except the shared `Cargo.lock`.
- **The sidecar protocol is app-shell's** (`app-shell/design/api.md § 1`): `initialize`,
  `shutdown`, `$/status`, `$/log`. code-graph adds `graph/*` on top. So the RPC skeleton is an
  app-shell change and the graph methods are a code-graph change.
- **The webview is split by region** (`app-shell/design/ui.md § Graph panel`): the shell
  draws toolbar chrome, overlays and the Details frame; code-graph fills the toolbar's
  middle slot, owns the canvas, and appends to Details. Shell chrome and canvas are
  separate changes; narrowing is a third, webview-only change.
- **Re-index in this epic happens only on sidecar (re)start.** `graph/changed` is emitted
  after every full run (including the first), which is the single trigger for the
  extension to fetch `graph/files`. The watcher-driven re-index arrives with the
  `workspace-index` epic and reuses the same notification.

Constraints:
- `cargo clippy` clean, no `unsafe` outside tree-sitter FFI.
- Unresolved references are kept as `Unresolved` edges to a placeholder node, never dropped.
- Node ids must be stable across re-index while `(path, kind, qualified name)` is unchanged —
  this is what makes R11 work.
- Binary bundled per platform in the `.vsix` under `extension/bin/<platform>-<arch>/`.
- Graph library: **Cytoscape.js** (decided in the planning interview; `OVERVIEW.md`'s TBD
  resolves to it).

## Actors
- **developer** — opens the graph for a workspace, expands files, follows edges, finds a
  symbol by name, narrows a large graph, jumps to source, and sees clearly when the sidecar
  is starting, indexing or failed.

## Scope
**In scope**
- Project scaffold: cargo workspace, extension build, CI, test harness, binary staging.
- `ir` crate: nodes, edges, stable ids, unresolved placeholders, `Frontend` trait.
- Four frontends: go, typescript (+ js), python, java — files, classes, functions; contains,
  imports, calls, references; best-effort resolution; fixtures + snapshots.
- `index` crate: walk roots, select files (extension, `.gitignore`, 1 MB cap), run every
  frontend, resolve, hold the graph in memory; full run on every sidecar start.
- `rpc` + `code-matrix-server`: framing, `initialize`/`shutdown`, `$/status`, `$/log`,
  `graph/files`, `graph/expand`, `graph/node`, `graph/changed`.
- `export`: `ir` → wire `Node`/`Edge` projection.
- App shell, all of `app-shell` v1: commands, singleton panel, status bar, output channel,
  lazy sidecar start, restart budget and failed state, Retry, jump-to-source, workspace guard.
- code-graph, all of `code-graph` v1 (R1–R12).

**Out of scope**
- `workspace-index` progress UI, Cancel, `Re-index Workspace` command, watchers, queued
  changes, single-file re-index, `files.exclude` (needs plumbing the design has not defined).
- `data-flow` entirely: CFG, def-use, `flow/*`. The `ir` change must leave the `Frontend`
  trait extensible for it, nothing more.
- Export to DOT/GraphML/PNG, saved layouts, variable nodes, editor-cursor → node sync,
  settings UI, runtime binary download, inter-procedural anything.

## Change Sequence
```
01-project-init                                   (wave 1 — foundation, no feature)
  ├─▶ 02-ir-graph-model                           (wave 2)
  │     ├─▶ 04-frontend-go        ┐
  │     ├─▶ 05-frontend-typescript│  (wave 3, parallel, disjoint crates)
  │     ├─▶ 06-frontend-python    │
  │     ├─▶ 07-frontend-java      │
  │     └─▶ 08-workspace-index-core
  └─▶ 03-sidecar-rpc-skeleton                     (wave 2)
        └─▶ 09-shell-panel-and-sidecar            (wave 3)
              ├─▶ 11-sidecar-recovery             (wave 4)
              └─▶ 12-graph-canvas ◀── 10-graph-rpc (wave 4; needs 02,03,04–08)
                    ├─▶ 13-jump-to-source         (wave 6, extension host only)
                    └─▶ 14-graph-narrowing        (wave 6, webview only)
                          └─▶ 15-graph-refresh    (wave 7)
```
Waves: 1 = {01}; 2 = {02, 03}; 3 = {04, 05, 06, 07, 08, 09}; 4 = {10, 11}; 5 = {12};
6 = {13, 14}; 7 = {15}.

Concurrency: within a wave, every change's `Code anchors` are disjoint except the shared
`core/Cargo.lock` in wave 3 (five crates adding dependencies) — build those in separate
worktrees and expect a trivial lockfile merge; run `sdlc caps scan` after the wave.
Close-out is serial.

## Changes
1. [`project-init`](changes/01-project-init.md) — cargo workspace, extension scaffold, CI, test harness, binary staging.
2. [`ir-graph-model`](changes/02-ir-graph-model.md) — language-agnostic graph: nodes, edges, stable ids, unresolved placeholders, `Frontend` trait.
3. [`sidecar-rpc-skeleton`](changes/03-sidecar-rpc-skeleton.md) — `code-matrix-server` with LSP-framed JSON-RPC, `initialize`/`shutdown`, `$/status`, `$/log`.
4. [`frontend-go`](changes/04-frontend-go.md) — Go frontend: tree-sitter extraction, package-level resolution, fixture + snapshots.
5. [`frontend-typescript`](changes/05-frontend-typescript.md) — TypeScript/JavaScript frontend, module-path resolution, fixture + snapshots.
6. [`frontend-python`](changes/06-frontend-python.md) — Python frontend, import resolution, fixture + snapshots.
7. [`frontend-java`](changes/07-frontend-java.md) — Java frontend, package/import resolution, fixture + snapshots.
8. [`workspace-index-core`](changes/08-workspace-index-core.md) — walk, select, run frontends, resolve, in-memory store, full run on start.
9. [`shell-panel-and-sidecar`](changes/09-shell-panel-and-sidecar.md) — commands, singleton panel, lazy sidecar spawn, status bar, output channel, overlays.
10. [`graph-rpc`](changes/10-graph-rpc.md) — `export` projection and `graph/files`, `graph/expand`, `graph/node`, `graph/changed`.
11. [`sidecar-recovery`](changes/11-sidecar-recovery.md) — restart budget, failed state, Retry, exit-code handling.
12. [`graph-canvas`](changes/12-graph-canvas.md) — Cytoscape canvas: files + imports, expand/collapse, unresolved, selection, Details additions, empty state.
13. [`jump-to-source`](changes/13-jump-to-source.md) — open a node's file at its range; missing-file toast; Escape clears selection.
14. [`graph-narrowing`](changes/14-graph-narrowing.md) — search, path glob, kind toggles, focus/hops, 2,000-node cap, counts.
15. [`graph-refresh`](changes/15-graph-refresh.md) — re-fetch on `graph/changed`, re-apply expansion/filters/focus/selection to surviving nodes.

## Design
- `.kernel/specs/features/code-graph/design/ui.md` — toolbar controls, canvas glyphs and states, Details additions.
- `.kernel/specs/features/code-graph/design/api.md` — `graph/*` RPC and webview messages.
- `.kernel/specs/features/code-graph/design/data-model.md` — wire `Node`/`Edge`, id stability.
- `.kernel/specs/features/code-graph/design/flows.md` — narrowing pipeline, focus state machine.
- `.kernel/specs/features/app-shell/design/ui.md` — graph panel regions, overlays, status bar, toasts.
- `.kernel/specs/features/app-shell/design/api.md` — sidecar protocol core, webview `shell/*` messages, VS Code contributions.
- `.kernel/specs/features/app-shell/design/flows.md` — sidecar lifecycle, open-the-graph, jump-to-source, recovery.
- `workspace-index` has **no design**; change 08 builds only its non-UI rules (R1 auto-run, R2 file selection minus `files.exclude`, R4, R6 failed-file node, R11, R13).

## Open Questions
- **`data-flow` is being specified in parallel** (its `feature.md` moved from stub to v1
  during this planning). `OVERVIEW.md` says `ir` holds per-function CFG and def-use. This
  epic adds neither; change 02 must shape the `Frontend` trait so a CFG/def-use method can
  be added later without rewriting the four frontends (an optional capability, not a
  required trait method). Confirm before 02 is planned.
- **`files.exclude`** (workspace-index R2): the shell's `initialize` carries only `roots`.
  Honouring VS Code's `files.exclude` needs a param the design does not define. Left to the
  workspace-index epic; this epic honours `.gitignore` and the 1 MB cap only.
- **VS Code minimum version** is TBD in `OVERVIEW.md`; `^1.90.0` is assumed in 01. Change
  it there if you need older.
- **Capability layout**: ids are nested by service, `core/<cap>` and `extension/<cap>`, per
  `.kernel/specs/capabilities/README.md`'s multi-service convention. Say so if you want a flat
  layout instead; it is cheapest to change before wave 2 closes out.
