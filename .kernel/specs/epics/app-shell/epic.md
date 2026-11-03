---
title: App Shell
type: epic
status: draft
created: 2026-11-03
tags: [epic, requirements]
---

# Epic: App Shell

## Summary
Deliver the VS Code surface every other code-matrix feature lives in: the three
`Code Matrix:` commands, the singleton graph panel opened as an editor tab, the status bar
item that mirrors the sidecar state, jump-to-source from a selected node, and the sidecar
lifecycle (lazy start, one silent restart, failed state with Retry / Show Log). A developer
who installs the .vsix on any supported platform can run `Code Matrix: Open Graph` and get a
live panel at state `ready`, or a clear reason why not.

Planned from the feature `.kernel/specs/features/app-shell/` (`feature.md` rules R1–R11,
`scenarios.md`, `design/`). The repo has no application code yet, so the epic also lays
down the project: `extension/` (TypeScript) and `core/` (Rust cargo workspace) from
`.kernel/specs/OVERVIEW.md`, with only the pieces the shell needs (`rpc` crate and the
`code-matrix-server` binary). `ir`, `index`, `analysis`, `export` and `frontend/*` are
created by the features that need them.

## Context
- **Greenfield.** `sdlc caps list` is empty; `sdlc list` has no active or archived changes.
  The repo holds `README.md`, `LICENSE`, `CLAUDE.md`, `.gitignore` (`.claude/`, `.kernel/`,
  `CLAUDE.md` are ignored — this epic folder is local only) and `.kernel/specs/`.
- **Stack** (from `OVERVIEW.md` Conventions): Rust 2021 cargo workspace in `core/`, clippy
  clean; TypeScript extension in `extension/` with minimal npm deps, UI only; JSON-RPC 2.0
  over stdio between them (rust-analyzer pattern), every request/response type defined once
  in Rust (`rpc` crate, serde) and mirrored in TS.
- **Allowed dependency edge** this epic uses: `extension -> rpc` (protocol only, over stdio),
  never the reverse. `rpc` must compile with zero frontends present.
- **Interfaces fixed by the design** (`design/api.md`): sidecar requests `initialize { roots }`
  / `shutdown`, notifications `$/status` / `$/log`, error codes `-32001 InvalidRoots`,
  `-32002 NotInitialized`; webview messages `shell/state`, `shell/selectNode`,
  `shell/openNode`, `shell/retry`, `shell/restart`, `shell/showLog`; VS Code contributions
  `codeMatrix.openGraph` / `codeMatrix.restartServer` / `codeMatrix.showLog`, output channel
  `Code Matrix`, status bar item `codeMatrix.status`, webview `codeMatrix.graph`.
- **Seams other features extend**: `code-graph` fills the toolbar middle slot, owns the main
  region, appends to the details region, and adds `graph/*` RPC methods and webview messages
  (`.kernel/specs/features/code-graph/design/api.md`). `workspace-index` drives the
  `indexing` state. The shell must therefore expose: named panel regions, a `shell/state`
  overlay the canvas sits under, an extension-side **node registry** (`nodeId → kind, name,
  path, range`) that features populate, and a JSON-RPC client other features can send
  methods through once `initialize` succeeded.
- **Decisions taken in the interview** (2026-11-03): wave 0 scaffolds `extension/` plus
  `core/` with only `rpc` + server binary; node locations resolve from a shell-owned
  extension-side registry; packaging is one platform-specific .vsix per target via
  `vsce package --target`; extension tests are unit (mocked `vscode`, vitest) plus
  integration (`@vscode/test-electron`, mocha).

## Actors
- **developer** — opens the graph for the current workspace, navigates graph → code, and
  needs to know when analysis is unavailable and why. The only actor; no roles.

## Scope
**In scope**
- Project layout, build, CI and test harness for `extension/` and `core/` (wave 0)
- `rpc` crate + `code-matrix-server` binary answering `initialize` / `shutdown`, emitting
  `$/status` / `$/log`
- Sidecar lifecycle in the extension: binary resolution per platform, spawn, JSON-RPC client,
  state machine, restart budget, output channel
- Commands `Open Graph`, `Restart Server`, `Show Log`; activation on those commands only
- Singleton graph panel with toolbar / main / details regions and the starting, indexing,
  populated, failed, closed states
- Status bar item with starting / ready / indexing / failed and click behaviour
- Failed overlay with Retry and Show Log; missing-binary failure cause
- Node registry, node selection and details, jump-to-source beside the graph, missing-file
  toast, Enter / Escape keys
- Per-platform .vsix packaging with the bundled binary, CI matrix

**Out of scope**
- Graph rendering, layout, filters (`code-graph`); indexing progress and re-index
  (`workspace-index`); data-flow (`data-flow`)
- Editor-cursor → graph-node sync; settings UI; downloading the binary at runtime
- `ir`, `index`, `analysis`, `export`, `frontend/*` crates

## Change Sequence
```
01-project-init  (wave 0: repo layout, build, CI, test harness — no feature)
  ├─▶ 02-sidecar-rpc-server   (core/: framing, initialize/shutdown, $/status, $/log)
  └─▶ 03-sidecar-lifecycle    (extension/src/sidecar: spawn, client, state machine, budget)
        │
02 + 03 ─┬─▶ 04-open-graph          (commands, workspace guard, panel, overlays, status bar)
         │     ├─▶ 06-failure-recovery  (failed overlay, Retry, Show Log, Restart Server)
         │     └─▶ 07-jump-to-source    (node registry, details region, open beside, toasts)
         └─▶ 05-platform-packaging  (bin/<platform>-<arch>, vsce --target, CI matrix)
```

Concurrency: 02 ∥ 03 (disjoint: `core/` vs `extension/src/sidecar/`); 04 ∥ 05 (disjoint:
`extension/src/` vs `extension/bin/`, `.vscodeignore`, `.github/workflows/`). 06 and 07 both
depend only on 04 but **intersect** on `extension/src/panel/graphPanel.ts` and
`extension/media/main.ts` — same wave, build one at a time, not in parallel worktrees.
Close-out is serial always. Run `sdlc caps scan` after waves 1, 2 and 3.

## Changes
1. [`project-init`](changes/01-project-init.md) — repo layout for `extension/` and `core/`, esbuild + cargo builds, CI, unit and integration test harness
2. [`sidecar-rpc-server`](changes/02-sidecar-rpc-server.md) — `rpc` crate and `code-matrix-server` binary: Content-Length framing, `initialize` / `shutdown`, `$/status` / `$/log`, error codes
3. [`sidecar-lifecycle`](changes/03-sidecar-lifecycle.md) — extension-side sidecar manager: binary resolution, spawn, JSON-RPC client, state machine, one-silent-restart budget, output channel
4. [`open-graph`](changes/04-open-graph.md) — `Open Graph` command, workspace guard, singleton panel with regions and starting / indexing overlays, status bar item, shutdown on window close
5. [`platform-packaging`](changes/05-platform-packaging.md) — bundle the binary under `bin/<platform>-<arch>/`, one .vsix per target, CI packaging matrix
6. [`failure-recovery`](changes/06-failure-recovery.md) — failed overlay with Retry / Show Log, `Restart Server` and `Show Log` commands, failed status bar state
7. [`jump-to-source`](changes/07-jump-to-source.md) — node registry, selection and details region, open file beside the graph, missing-file toast, Enter / Escape

## Design
- `.kernel/specs/features/app-shell/design/ui.md` — graph panel regions and the five panel
  states (SVGs `design/ui/graph-panel.svg`, `.starting.svg`, `.failed.svg`), status bar
  states, toasts
- `.kernel/specs/features/app-shell/design/flows.md` — sidecar lifecycle state diagram and
  restart budget, open-the-graph, jump-to-source and recovery flows
- `.kernel/specs/features/app-shell/design/api.md` — JSON-RPC methods and exit handling,
  webview postMessage types, VS Code contributions

## Open Questions
- None blocking. Decisions the interview did not reach are listed in `BUILD.md` under
  "Decided without you" (minimum VS Code version, test runners, `retainContextWhenHidden`,
  the `CODE_MATRIX_SERVER_PATH` test override).
