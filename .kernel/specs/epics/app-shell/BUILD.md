---
title: App Shell — Build Plan
type: build-plan
epic: app-shell
status: draft
created: 2026-11-03
---

# Build Plan: App Shell

Per wave: `/plan:epic app-shell` plans the next wave, you review its proposals, then
`/build:epic app-shell` builds it and marks each change done here as it lands. Running
`/build:epic` is the approval.

Or let the loop build it: commit an empty `.loop` file next to this one. You approve each
wave's proposals and then its code at the loop's gates. (Note: `.kernel/` is in
`.gitignore`; un-ignore this folder or the loop cannot see the `.loop` file.)

Append `⏸ held` to a change to hold it back — anything depending on it waits too.

## Wave 0 — foundation, alone
- **01-project-init** — `extension/` (TypeScript, esbuild, vitest + @vscode/test-electron) and `core/` (cargo workspace: `rpc` lib, `server` bin `code-matrix-server`), CI workflow, root ignores
      Capabilities: creates none (project wiring); lays down `capabilities/core/OVERVIEW.md` and `capabilities/extension/OVERVIEW.md` (`DependsOn: core`)
      Touches: `core/Cargo.toml`, `core/crates/rpc/`, `core/crates/server/`, `extension/package.json`, `extension/esbuild.mjs`, `extension/vitest.config.ts`, `extension/test/`, `.github/workflows/ci.yml`, `.gitignore`, `README.md`
      Done when: `cargo test` + clippy + fmt and `npm run lint && npm run build && npm run test:unit && npm run test:integration` all pass locally and in CI on an empty skeleton

## Wave 1 — needs wave 0, independent of each other (disjoint: `core/` vs `extension/src/sidecar/`)
- **02-sidecar-rpc-server** — `rpc` crate (LSP framing, JSON-RPC types, `initialize`/`shutdown`/`$/status`/`$/log` types, error codes) and the server loop: roots validated, pre-init rejection, `ready` after init, exit 0 after `shutdown`
      Capabilities: creates `core/rpc-server`
      Touches: `core/crates/rpc/src/{framing,message,protocol}.rs`, `core/crates/server/src/{main,handler}.rs`, `core/crates/server/tests/lifecycle.rs`
      Done when: binary-level tests drive `initialize` (one root, two roots, bad root), `shutdown` → exit 0, `NotInitialized`, unknown method, parse error, stdin EOF → non-zero
- **03-sidecar-lifecycle** — `SidecarManager`: binary resolution per `platform-arch` with the R11 cause, spawn, `JsonRpcConnection`, state machine, one-silent-restart / 60 s budget, `retry`, `restart`, `stop`, output channel routing
      Capabilities: creates `extension/sidecar-lifecycle`
      Touches: `extension/src/sidecar/{binary,protocol,jsonrpc,state,manager}.ts`, `extension/src/output.ts`, `extension/test/unit/sidecar/`, `extension/test/unit/fakes/fakeProcess.ts`
      Done when: unit tests with an injected fake process cover first crash → silent restart, second crash within 60 s → `failed`, `retry` resets, `restart` never counts, `stop` kills after 2 s, missing binary → exact R11 cause

## Wave 2 — needs wave 1, independent of each other (disjoint: `extension/src/` vs `bin/`, `.vscodeignore`, workflows)
- **04-open-graph** — `Open Graph` command, workspace guard toast, singleton `Code Matrix` panel with toolbar / main / details regions and starting / indexing overlays, status bar (starting / ready / indexing, click opens panel), activation on commands only, `stop` on deactivate
      Capabilities: creates `extension/graph-panel`, `extension/status-bar` · modifies `extension/sidecar-lifecycle`
      Touches: `extension/package.json`, `extension/src/{extension,commands,statusBar}.ts`, `extension/src/panel/{graphPanel,messages}.ts`, `extension/media/{main.ts,main.css}`, `extension/test/integration/suite/{openGraph,noFolder}.test.ts`
      Done when: integration tests against the real `code-matrix-server` show one panel, `starting` → `ready` in the status bar, `Open a folder to analyze` with no folder, both roots in `initialize`, no process after bare activation, reopen without respawn, process gone after `deactivate`
- **05-platform-packaging** — `bundle-server` script placing the cargo binary at `bin/<platform>-<arch>/`, `.vscodeignore`, `vsce package --target` for 5 targets, CI packaging matrix on native runners
      Capabilities: creates `extension/platform-packaging` · modifies `extension/sidecar-lifecycle`
      Touches: `extension/scripts/bundle-server.mjs`, `extension/package.json` (scripts), `extension/.vscodeignore`, `.github/workflows/package.yml`, `.github/workflows/ci.yml`, `extension/test/integration/suite/bundledBinary.test.ts`
      Done when: `npm run package` yields a .vsix listing exactly one `bin/<key>/code-matrix-server`, and `Open Graph` reaches `ready` from the bundled layout with no env override

## Wave 3 — needs wave 2 (04); anchors INTERSECT on `graphPanel.ts` and `media/main.ts` — build one at a time, not in parallel worktrees
- **06-failure-recovery** — failed overlay (`Code Matrix server failed`, cause, `Retry`, `Show Log`), `shell/retry` / `shell/restart` / `shell/showLog`, toolbar buttons, `Restart Server` and `Show Log` commands, status bar `failed` with error background and log-on-click, scripted fake server for crash scenarios
      Capabilities: creates `extension/sidecar-recovery` · modifies `extension/graph-panel`, `extension/status-bar`
      Touches: `extension/src/commands.ts`, `extension/src/panel/graphPanel.ts`, `extension/src/statusBar.ts`, `extension/media/{main.ts,main.css}`, `extension/test/integration/fixtures/fake-server/`, `extension/test/integration/suite/recovery.test.ts`
      Done when: integration tests show one crash → silent restart (log only), two crashes → failed overlay + `Code Matrix: failed`, `Retry` resets the budget, `Restart Server` never counts, missing binary renders the R11 cause, closing the panel while failed retries nothing
- **07-jump-to-source** — shell-owned `NodeRegistry`, `shell/selectNode` → `shell/selection` → Details region (`Kind`, `Name`, `Location`, `Open in editor`), `shell/openNode` → editor beside the graph at the range, `File not found: <path>` toast keeping the selection, Enter / Escape, `Details` toggle, `window.codeMatrixShell` seam for the canvas
      Capabilities: creates `extension/jump-to-source` · modifies `extension/graph-panel`
      Touches: `extension/src/nodes/{registry,openNode}.ts`, `extension/src/extension.ts`, `extension/src/panel/{graphPanel,messages}.ts`, `extension/media/{main.ts,main.css}`, `extension/test/integration/suite/jumpToSource.test.ts`, `.kernel/specs/features/app-shell/design/api.md` (adds `shell/selection`)
      Done when: a registered `parseConfig` node opens `src/config.go` beside the panel with the cursor on line 12, a missing-file node shows the warning and keeps the selection, Enter / Escape / `Open in editor` post the right messages

## Beyond the changes themselves
- **`.kernel/specs/capabilities/`**: all new — `core/rpc-server`, `extension/sidecar-lifecycle`, `extension/graph-panel`, `extension/status-bar`, `extension/platform-packaging`, `extension/sidecar-recovery`, `extension/jump-to-source`, nested under two services with `extension/OVERVIEW.md` declaring `DependsOn: core`. `extension/graph-panel` is overwritten by 06 and again by 07 (serial close-out matters there); `extension/sidecar-lifecycle` is overwritten by 04 and 05 — close them out one after the other and run `sdlc caps scan` after wave 2.
- **`.kernel/specs/OVERVIEW.md`**: two `<TBD>` lines resolve — supported VS Code minimum version (`^1.90.0`, decided below) and binary distribution (bundled per platform, from the feature). The Architecture section's crate list stays provisional; `ir`/`index`/`analysis`/`export`/`frontend/*` are not created by this epic.
- **`.kernel/specs/features/app-shell/design/api.md`**: 07 adds `shell/selection` (ext → webview) and the `nodeId: null` form of `shell/selectNode`.
- **`.kernel/specs/features/app-shell/feature.md`**: `## Capabilities — none yet` becomes the list above when the epic is built.
- **`.gitignore`**: `.kernel/` is ignored. The epic folder, the capability corpus and the loop's `.loop` file are therefore untracked. Decide whether to un-ignore `.kernel/specs/` before using the loop or sharing the corpus.

## Decided without you
- Minimum VS Code `^1.90.0`, Node 20, Rust stable (edition 2021). OVERVIEW's `<TBD: supported VS Code minimum version>` resolves to this.
- Test runners: vitest for unit tests with a hand-written `vscode` mock via a module alias; mocha + `@vscode/test-electron` for integration tests pinned to VS Code 1.90.0. Webview logic is unit-tested under jsdom.
- Bundler: esbuild, two entries (`src/extension.ts` → `dist/extension.js`, `media/main.ts` → `dist/webview.js` + `webview.css`). Webview is vanilla DOM with `--vscode-*` CSS variables; no UI framework. `retainContextWhenHidden: true` on the panel (code-graph's canvas will need it; the shell re-posts state and selection on reveal regardless).
- `CODE_MATRIX_SERVER_PATH` environment override in `resolveServerBinary` so tests and development can point at a non-bundled server. It is not a setting (settings UI is out of scope).
- Crate layout: `core/crates/rpc` (lib) and `core/crates/server` (bin `code-matrix-server`), matching OVERVIEW's `rpc` crate + binary name. `initialize` returns `languages: []` until frontends exist.
- Restart budget mechanics: `lastUnexpectedExitAt` timestamp; a second unexpected exit within 60 000 ms fails; otherwise silent restart. This satisfies both phrasings in flows.md (restored by 60 s uptime or by Retry).
- The node registry's `NodeRecord` stores absolute paths and 0-based ranges; `Location` renders workspace-relative `path:line` 1-based.
- `shell/selection` message added to the API (the design named the inbound `shell/selectNode` but no outbound reply for the Details region).
- CI packaging uses native GitHub runners for all five targets (`ubuntu-24.04-arm`, `macos-13`, `macos-14`, `windows-latest`, `ubuntu-latest`); no cross-compilation.
- 04 declares all three commands in `package.json` so the command palette is complete, but only `openGraph` is behaviourally covered there; `restartServer` and `showLog` are 06's.

## Risks
- **06 and 07 both rewrite `graphPanel.ts` and `media/main.ts`** and both overwrite the `extension/graph-panel` capability. Build and close them out serially.
- **Integration tests need a crashable server.** 06 introduces a scripted fake server launched through `CODE_MATRIX_SERVER_PATH`; on Windows a `.js` cannot be spawned directly, so the wrapper mechanics are a plan-time decision. If it proves brittle, the lifecycle scenarios remain fully covered by 03's unit tests with the fake process.
- **`extension -> rpc` is hand-mirrored** (`sidecar/protocol.ts` vs `rpc/src/protocol.rs`). 02's serde JSON fixtures are the contract; a drift shows up only in 04's integration tests. Keep the fixtures byte-exact.
- **`.kernel/` is gitignored**, so none of this plan, the corpus or `.loop` is versioned. The loop flow cannot start until that is changed.

## Progress
<!-- Appended by /build:epic: change · result · commit -->
