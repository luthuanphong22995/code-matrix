---
title: Platform Packaging
type: epic-change
epic: app-shell
status: planned
depends-on: [sidecar-rpc-server, sidecar-lifecycle]
feature: app-shell
---

# platform-packaging

**As a** developer installing code-matrix, **I want** the .vsix for my platform to carry the
sidecar binary **so that** `Open Graph` works without downloading anything.

## Intent
Feature scope: "Sidecar binary bundled per platform in the .vsix" (R11 names the path the
extension looks at). This change makes the cargo-built `code-matrix-server` land where
`03-sidecar-lifecycle`'s `resolveServerBinary` expects it —
`extension/bin/<platform>-<arch>/code-matrix-server[.exe]` — and produces one
platform-specific .vsix per target with `vsce package --target`, built by a CI matrix. It
touches no extension source: the path contract is `03`'s and the binary is `02`'s, so it runs
in parallel with `04-open-graph`.

## Approach
- **Targets** (interview decision): `win32-x64`, `darwin-x64`, `darwin-arm64`, `linux-x64`,
  `linux-arm64` — VS Code's own target names, which equal `${process.platform}-${process.arch}`,
  the `platformKey` in `resolveServerBinary`. Each .vsix carries exactly one binary.
- **`extension/scripts/bundle-server.mjs`** — `node scripts/bundle-server.mjs [--profile
  release] [--target <key>]`: runs `cargo build -p server --profile <profile>` in `../core`
  (unless `--no-build`), copies `core/target/<profile>/code-matrix-server[.exe]` to
  `extension/bin/<key>/code-matrix-server[.exe]` (key defaults to the host), chmod 755 on
  POSIX, and deletes other `bin/*` directories so a package never carries two platforms.
  Wired as npm script `bundle-server`; `npm run package` = `bundle-server --profile release`
  then `vsce package --target <key>` (key from the host or `--target`).
- **`.vscodeignore`** — ship `dist/**`, `bin/**`, `package.json`, `README.md`, `LICENSE`
  (copied from the repo root by the package script); exclude everything else (`src`, `test`,
  `scripts`, `node_modules`, configs). Verify with `vsce ls`.
- **CI** — `.github/workflows/package.yml`, on tag `v*` and `workflow_dispatch`: matrix
  `{ win32-x64: windows-latest, darwin-x64: macos-13, darwin-arm64: macos-14, linux-x64:
  ubuntu-latest, linux-arm64: ubuntu-24.04-arm }` — native runners, no cross-compilation.
  Steps: checkout, rust stable, node 20, `cargo build --release`, `npm ci`, `npm run build`,
  `npm run package -- --target <key>`, upload `code-matrix-<version>-<key>.vsix` as an
  artifact. A final job attaches all five to the GitHub release when the trigger was a tag.
  `ci.yml` gains a step that runs `bundle-server` for the host and `vsce package --target`
  on linux-x64 only, as a smoke test that the package lists `bin/linux-x64/code-matrix-server`.
- **Missing-binary path** (R11) is already produced by `resolveServerBinary`; this change
  adds the test that an *installed* layout is found: an integration test that copies the
  cargo binary into `bin/<host-key>/` of the extension-under-test and runs `Open Graph`
  **without** `CODE_MATRIX_SERVER_PATH` set.

## Design
- `.kernel/specs/features/app-shell/design/api.md § Exit handling` — `spawn fails: binary
  missing → Server binary not found for <platform>: <path>` fixes the `<platform>` token the
  directory layout is named after
- No screen; nothing to render.

## Code anchors
- `extension/scripts/bundle-server.mjs` — new
- `extension/package.json` — scripts `bundle-server`, `package`; `version`
- `extension/.vscodeignore` — include `bin/**`, `dist/**`
- `.github/workflows/package.yml` — new; `.github/workflows/ci.yml` — package smoke step
- `.gitignore` — `extension/bin/` (already ignored by `01`; verify)
- `extension/src/sidecar/binary.ts` — consumed (`resolveServerBinary` path contract); no change expected
- `extension/test/integration/suite/bundledBinary.test.ts` — new
- `README.md` — packaging instructions

## Capabilities
- Modifies: `extension/sidecar-lifecycle` (its `Code:` gains the bundle script that
  satisfies `resolveServerBinary`'s layout)
- Creates: `extension/platform-packaging` — per-target .vsix carrying one sidecar binary
  under `bin/<platform>-<arch>/`; CI packaging matrix

## Invariants / constraints
- The binary path inside the package is exactly `bin/<platform>-<arch>/code-matrix-server`
  (`.exe` on win32), matching `resolveServerBinary` (app-shell R11).
- One binary per .vsix; `bundle-server` removes other platform directories before packaging.
- No runtime download (feature scope: out). No network access at activation.
- Native runners only; a target whose runner is unavailable fails the matrix job rather than
  silently shipping a .vsix without a binary (`vsce ls` must list the binary; the job asserts it).
- `.vscodeignore` must not drop `dist/webview.js` / `dist/webview.css` (the panel's assets).

## Acceptance criteria
- [ ] `npm run bundle-server` on the host builds the server and produces `extension/bin/<host-key>/code-matrix-server[.exe]`, executable on POSIX
- [ ] `npm run package` produces `code-matrix-<version>-<host-key>.vsix`; `vsce ls` (or unzipping it) shows `extension/bin/<host-key>/code-matrix-server[.exe]`, `extension/dist/extension.js`, `extension/dist/webview.js`, `extension/dist/webview.css`, and no `src/`, `test/`, `node_modules/`
- [ ] Running `bundle-server --target linux-arm64` after a `win32-x64` bundle leaves only `bin/linux-arm64/` (one platform per package)
- [ ] Integration: with the binary copied into `bin/<host-key>/` and `CODE_MATRIX_SERVER_PATH` unset, `codeMatrix.openGraph` reaches `Code Matrix: ready` (R11 happy path)
- [ ] Integration: with `bin/` empty and `CODE_MATRIX_SERVER_PATH` unset, `codeMatrix.openGraph` leaves `manager.state` `failed` with cause exactly `Server binary not found for <host-key>: <abs path>` (R11; the panel rendering of it is `06`'s)
- [ ] `package.yml` run on `workflow_dispatch` uploads five artifacts, one per target, each containing its own platform's binary
- [ ] `ci.yml` package smoke step passes on linux-x64

## Plan
`/plan:change .kernel/specs/epics/app-shell/changes/05-platform-packaging.md` — plan reads this
file directly and derives the change name from it.
