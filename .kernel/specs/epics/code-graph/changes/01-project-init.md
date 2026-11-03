---
title: Project init — cargo workspace, extension scaffold, CI, test harness
type: epic-change
epic: code-graph
status: planned
depends-on: []
---

# project-init

**As a** developer on code-matrix, **I want** the repo laid out as `OVERVIEW.md` describes,
with build, test and packaging working end to end on an empty system, **so that** every later
change adds one crate or one module without touching shared wiring.

## Intent
The repository has no application code. This change creates the two deployables' skeletons —
the `core/` cargo workspace and the `extension/` VS Code package — plus CI, the test harness,
and the script that stages the Rust binary into the extension for packaging. It builds no
user-observable behaviour and has no `feature:`. Every other change in the epic depends on it.

## Approach
- **Cargo workspace at `core/`** with members `ir`, `rpc`, `index`, `export` and the glob
  `frontend/*`, so a frontend change adds its crate without editing `core/Cargo.toml`. Create
  the four non-frontend crates as empty libs (a `lib.rs` with a doc comment) so wave-2 changes
  fill them rather than fight over the workspace file. `rpc` also declares the binary
  `code-matrix-server` (`src/main.rs`, prints version and exits for now). Pin shared versions
  in `[workspace.dependencies]`: `serde`, `serde_json`, `tree-sitter` (one version all four
  grammar crates are compatible with — check the grammar crates' `tree-sitter` requirement
  before pinning), `insta` (snapshots), `thiserror`. `[workspace.lints]`: clippy warnings deny
  in CI via `cargo clippy --all-targets -- -D warnings`; `unsafe_code = "deny"` at workspace
  level with an explicit per-crate `allow` reserved for frontends' FFI bindings.
- **Extension at `extension/`**: `package.json` (name `code-matrix`, `engines.vscode`
  `^1.90.0`, `main` → `dist/extension.js`, no `contributes` yet — change 09 adds them),
  `tsconfig.json` (strict), `esbuild.mjs` building two bundles: `src/extension.ts` → `dist/extension.js`
  (platform node, external `vscode`) and `webview/src/main.ts` → `dist/webview.js` (platform
  browser). Dev deps only: `typescript`, `esbuild`, `@types/vscode`, `@types/node`,
  `@vscode/vsce`, `@vscode/test-electron`, `vitest`. No runtime deps yet (`cytoscape` arrives in 12).
  `src/extension.ts` exports an empty `activate`/`deactivate`. `webview/src/main.ts` is a stub.
- **Tests**: `vitest` for pure TS modules (`extension/test/unit/**`), `@vscode/test-electron`
  runner at `extension/test/integration/runTests.ts` opening `fixtures/go` as the workspace
  (fixture content arrives in 04; the runner must tolerate an empty folder). Rust: `cargo test`
  with one smoke test per crate.
- **Binary staging**: `extension/scripts/stage-server.mjs` copies
  `core/target/{debug,release}/code-matrix-server[.exe]` to
  `extension/bin/<process.platform>-<process.arch>/code-matrix-server[.exe]`. `extension/bin/`
  is git-ignored and included in the `.vsix` (`.vscodeignore` excludes `src`, `test`,
  `node_modules`, keeps `dist` and `bin`).
- **CI**: `.github/workflows/ci.yml`, matrix `ubuntu-latest`, `macos-latest`, `windows-latest`:
  `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, `cargo test`, then
  `npm ci`, `npm run build`, `npm test` in `extension/`, then `stage-server` + `vsce package`
  as an artifact. Rust and npm caches on.
- **`.gitignore`**: append `core/target/`, `extension/node_modules/`, `extension/dist/`,
  `extension/bin/`, `*.vsix`. Do not touch the existing three lines.
- **`fixtures/`**: create with a `README.md` stating the per-language layout
  (`fixtures/<lang>/` is a small self-contained repo; snapshots live beside the frontend
  crate's tests).

## Code anchors
All created by this change:
- `core/Cargo.toml` — workspace, members, `[workspace.dependencies]`, `[workspace.lints]`
- `core/ir/Cargo.toml`, `core/ir/src/lib.rs` — empty lib
- `core/rpc/Cargo.toml`, `core/rpc/src/lib.rs`, `core/rpc/src/main.rs` — empty lib + bin `code-matrix-server`
- `core/index/Cargo.toml`, `core/index/src/lib.rs` — empty lib
- `core/export/Cargo.toml`, `core/export/src/lib.rs` — empty lib
- `core/frontend/.gitkeep` — glob member dir
- `core/rustfmt.toml`, `core/clippy.toml` (only if a setting is needed; otherwise omit)
- `extension/package.json`, `extension/tsconfig.json`, `extension/esbuild.mjs`, `extension/.vscodeignore`
- `extension/src/extension.ts` — `activate`, `deactivate` (empty)
- `extension/webview/src/main.ts` — stub
- `extension/scripts/stage-server.mjs`
- `extension/test/unit/smoke.test.ts`, `extension/test/integration/runTests.ts`, `extension/test/integration/suite/index.ts`
- `fixtures/README.md`
- `.github/workflows/ci.yml`
- `.gitignore` — append build outputs
- `README.md` — replace the one-line stub with build/run instructions (`cargo build` in `core/`, `npm run build` + `stage-server` in `extension/`, F5 launch)

## Capabilities
- Modifies: none (empty corpus)
- Creates: none — scaffolding is not a system capability. `OVERVIEW.md § Conventions` is the
  durable record; this change updates its two TBDs it resolves (VS Code min version, bundled
  binary).

## Invariants / constraints
- `core/ir`, `core/export` compile with zero frontends present (workspace builds with `frontend/` empty).
- `unsafe` denied workspace-wide; only `frontend/*` crates may `allow` it, and only for grammar FFI.
- `cargo clippy --all-targets -- -D warnings` is clean.
- The extension has no runtime npm dependency after this change.
- The webview bundle is built for the browser platform; the extension bundle for node with `vscode` external.
- `.gitignore`'s existing lines (`.claude/`, `.kernel/`, `CLAUDE.md`) are untouched.

## Acceptance criteria
- [ ] In `core/`: `cargo build`, `cargo clippy --all-targets -- -D warnings`, `cargo fmt --check` and `cargo test` all succeed; `target/debug/code-matrix-server --version` prints the crate version.
- [ ] In `extension/`: `npm ci`, `npm run build`, `npm test` (vitest smoke + test-electron smoke that activates the extension) succeed.
- [ ] `node scripts/stage-server.mjs` places the binary at `extension/bin/<platform>-<arch>/code-matrix-server[.exe]` and `npx vsce package` produces a `.vsix` that contains `dist/` and `bin/` and not `src/`.
- [ ] `.github/workflows/ci.yml` runs the steps above on the three OS runners (verify by reading the file; a green run is the first PR's job).
- [ ] `OVERVIEW.md` no longer carries the two TBDs this change resolves.

## Plan
`/plan:change .kernel/specs/epics/code-graph/changes/01-project-init.md` — plan reads this file
directly and derives the change name from it.
