---
title: Project Init
type: epic-change
epic: app-shell
status: planned
depends-on: []
---

# project-init

**As a** developer on code-matrix, **I want** the `extension/` and `core/` projects laid down
with working builds, tests and CI **so that** every shell change lands on a repo that already
compiles, tests and packages.

## Intent
The repo contains only `README.md`, `LICENSE`, `CLAUDE.md`, `.gitignore` and `.kernel/`. This
change creates the two projects `.kernel/specs/OVERVIEW.md` describes, limited to what the
app-shell epic needs: a TypeScript VS Code extension in `extension/` and a Rust cargo
workspace in `core/` holding the `rpc` library crate and the `code-matrix-server` binary
crate. Builds, lint, both test harnesses and a CI workflow run green on an empty skeleton.
It builds no user-observable behaviour, so it carries no `feature:`.

## Approach
- **`core/`**: cargo workspace (`core/Cargo.toml`, `[workspace] members = ["crates/*"]`,
  `resolver = "2"`, edition 2021). `crates/rpc` is a lib with `serde`, `serde_json`;
  `crates/server` is a bin named `code-matrix-server` depending on `rpc`. Both compile with
  placeholder contents (a `pub fn version()` and a `main` that exits 0). `cargo clippy
  -- -D warnings` and `cargo fmt --check` are the lint gate (OVERVIEW: clippy clean).
  No other crates: `ir`, `index`, `analysis`, `export`, `frontend/*` come with their features.
- **`extension/`**: `package.json` with `name: code-matrix`, `publisher` placeholder,
  `engines.vscode: ^1.90.0`, `main: ./dist/extension.js`, empty `contributes` (commands are
  added by `04-open-graph`), scripts `build`, `watch`, `lint`, `test:unit`, `test:integration`,
  `package`. Bundled with **esbuild** (`extension/esbuild.mjs`): entry `src/extension.ts` →
  `dist/extension.js` (cjs, platform node, external `vscode`), entry `media/main.ts` →
  `dist/webview.js` (browser). TypeScript strict. Minimal deps: `@types/vscode`, `typescript`,
  `esbuild`, `@vscode/vsce`, `vitest`, `mocha`, `@types/mocha`, `@vscode/test-electron`, `glob`.
- **Unit harness**: vitest, `extension/vitest.config.ts` with `resolve.alias` mapping
  `vscode` → `extension/test/unit/mocks/vscode.ts` (hand-written stub of `window`,
  `workspace`, `commands`, `Uri`, `Range`, `Position`, `EventEmitter`, `StatusBarAlignment`,
  `ViewColumn`, `ThemeColor`). Tests live in `extension/test/unit/**/*.test.ts`.
- **Integration harness**: `@vscode/test-electron` runner at
  `extension/test/integration/runTest.ts` downloading VS Code `1.90.0`, mocha suite loader at
  `extension/test/integration/suite/index.ts`, tests in `extension/test/integration/suite/*.test.ts`,
  fixture workspace at `extension/test/integration/fixtures/workspace/` (one folder with one
  `.txt` file). Runs under `xvfb-run` on Linux CI.
- **CI**: `.github/workflows/ci.yml`, on push and pull_request, two jobs: `core` (ubuntu:
  `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, `cargo test`) and
  `extension` (ubuntu, node 20: `npm ci`, `npm run lint` = `tsc --noEmit`, `npm run build`,
  `npm run test:unit`, `xvfb-run -a npm run test:integration`).
- **Root files**: `.gitignore` gains `node_modules/`, `extension/dist/`, `extension/bin/`,
  `extension/.vscode-test/`, `core/target/`, `*.vsix`. `README.md` gets build / test commands.
  `extension/.vscodeignore` excludes `src`, `test`, `node_modules`, `esbuild.mjs`,
  `vitest.config.ts`, `tsconfig.json` (final packaging rules come with `05-platform-packaging`).

## Code anchors
All new files; the repo has no code. Paths created, which every later change anchors to:
- `core/Cargo.toml` — workspace root
- `core/crates/rpc/Cargo.toml`, `core/crates/rpc/src/lib.rs` — `rpc` lib crate
- `core/crates/server/Cargo.toml`, `core/crates/server/src/main.rs` — bin `code-matrix-server`
- `extension/package.json`, `extension/tsconfig.json`, `extension/esbuild.mjs`,
  `extension/.vscodeignore`
- `extension/src/extension.ts` — `activate`, `deactivate` (empty bodies)
- `extension/media/main.ts` — webview entry (empty)
- `extension/vitest.config.ts`, `extension/test/unit/mocks/vscode.ts`,
  `extension/test/unit/smoke.test.ts`
- `extension/test/integration/runTest.ts`, `extension/test/integration/suite/index.ts`,
  `extension/test/integration/suite/activate.test.ts`,
  `extension/test/integration/fixtures/workspace/README.txt`
- `.github/workflows/ci.yml`
- `.gitignore`, `README.md`

## Capabilities
- Modifies: none
- Creates: none (project wiring; no user-observable behaviour). Lay down the multi-service
  corpus layout so later changes nest under it: `.kernel/specs/capabilities/core/OVERVIEW.md`
  and `.kernel/specs/capabilities/extension/OVERVIEW.md` (the latter with `DependsOn: core`).

## Invariants / constraints
- OVERVIEW conventions: Rust 2021, `cargo clippy` clean, no `unsafe`; extension owns UI
  only, minimal npm deps; `extension -> rpc` is the only cross-project edge and it is
  protocol-only over stdio — no Rust-to-TS code generation, no shared packages.
- `rpc` and `server` must compile with zero frontend crates present (OVERVIEW rule).
- Minimum VS Code `1.90.0`; Node 20; the integration runner downloads exactly that version.
- Nothing starts a sidecar on activation (R4) — `activate` registers nothing yet.
- No application behaviour: no commands, no panel, no RPC methods.

## Acceptance criteria
- [ ] `cd core && cargo build && cargo test && cargo clippy --all-targets -- -D warnings && cargo fmt --check` all exit 0 and produce `target/debug/code-matrix-server[.exe]`
- [ ] `cd extension && npm ci && npm run lint && npm run build` exit 0 and produce `dist/extension.js` and `dist/webview.js`
- [ ] `npm run test:unit` runs `test/unit/smoke.test.ts`, which imports the `vscode` mock through the alias, and passes
- [ ] `npm run test:integration` launches VS Code 1.90.0 on the fixture workspace, activates the extension and asserts `vscode.extensions.getExtension('<publisher>.code-matrix').isActive` after `activate()`; passes on Windows locally and under `xvfb-run` on Linux
- [ ] `.github/workflows/ci.yml` runs both jobs green on push
- [ ] `git status` shows no `node_modules/`, `dist/`, `target/`, `.vscode-test/` or `*.vsix` as untracked

## Plan
`/plan:change .kernel/specs/epics/app-shell/changes/01-project-init.md` — plan reads this file
directly and derives the change name from it.
