---
title: Sidecar Lifecycle
type: epic-change
epic: app-shell
status: planned
depends-on: [project-init]
feature: app-shell
---

# sidecar-lifecycle

**As a** developer, **I want** the extension to start, talk to, restart and stop the sidecar
for my window **so that** analysis is available when I open the graph and recovers from a
crash without my noticing.

## Intent
The extension-side half of `design/api.md § 1` and the whole of `design/flows.md § Sidecar
lifecycle`: locate the bundled binary for the current platform, spawn it, run a JSON-RPC
client over its stdio, send `initialize` with every workspace root, track the state
(`not-started | starting | ready | indexing | failed`), apply the one-silent-restart budget
on unexpected exits, route stdout-less diagnostics (stderr and `$/log`) to the `Code Matrix`
output channel, and shut down cleanly. This is pure extension-host logic with no panel or
status bar — those subscribe to its state events in `04-open-graph`. It is built against
the protocol in `api.md` (not against the Rust code), so it can run in parallel with
`02-sidecar-rpc-server`; its integration with the real binary is verified in `04-open-graph`.

## Approach
- **`sidecar/binary.ts`** — `resolveServerBinary(extensionPath, platform = process.platform,
  arch = process.arch)` returns `{ path, platformKey }` where `platformKey =
  \`${platform}-${arch}\`` (e.g. `darwin-arm64`, `win32-x64`) and `path =
  <extensionPath>/bin/<platformKey>/code-matrix-server` (`.exe` on win32). The environment
  variable `CODE_MATRIX_SERVER_PATH`, when set, overrides the path (development and tests
  only; not a setting — settings UI is out of scope). If the file does not exist, throw
  `ServerBinaryMissingError` whose message is exactly `Server binary not found for
  <platformKey>: <path>` (R11).
- **`sidecar/protocol.ts`** — TypeScript mirror of `rpc::protocol`: `InitializeParams`,
  `InitializeResult`, `StatusParams`, `LogParams`, method and error-code constants. Hand
  written; the Rust serde fixtures in `02` are the contract.
- **`sidecar/jsonrpc.ts`** — `JsonRpcConnection` over a `{ stdin: Writable, stdout:
  Readable }` pair: Content-Length framing (buffer partial frames), `request(method,
  params): Promise<result>` with incrementing ids and a per-request rejection on
  `ResponseError`, `notify(method, params)`, `onNotification(method, handler)`, `dispose()`.
  Rejects every pending request with a `ConnectionClosedError` when the stream ends. Other
  features (`code-graph`) call `request('graph/files')` through this same object.
- **`sidecar/manager.ts`** — `SidecarManager` (a `Disposable`):
  - `readonly state: SidecarState`, `onDidChangeState: Event<SidecarState>`,
    `readonly connection: JsonRpcConnection | undefined` (defined while a process is alive).
  - `SidecarState` (`sidecar/state.ts`): `{ kind: 'not-started' } | { kind: 'starting' } |
    { kind: 'ready' } | { kind: 'indexing', detail?: string } | { kind: 'failed', cause:
    string }`.
  - `start(roots: string[])` — no-op if a process is alive; else resolve binary (missing →
    `failed` with the R11 cause, nothing spawned), `child_process.spawn(path, [], { stdio:
    'pipe' })` (spawn `error` event → `failed` with the OS error text), state `starting`,
    pipe stderr lines to the output channel, wire `$/status` → `ready` / `indexing` and
    `$/log` → output channel `[level] message`, send `initialize { roots }`. Initialize error
    → `failed` with `initialize failed: <message>`. Success → `ready` (the server's
    `$/status ready` lands at the same time; both are idempotent).
  - `restart()` — user-initiated (`Restart Server`): mark the current process as expected to
    exit, `shutdown` with a 2 s timeout then `kill()`, then `start(lastRoots)`. Does not
    touch the budget (flows.md).
  - `retry()` — `Retry` from the failed state: clear `lastUnexpectedExitAt`, then
    `start(lastRoots)`.
  - `stop()` — called from `deactivate`: `shutdown` with a 2 s timeout then `kill()`,
    state `not-started`, no restart (R4).
  - **Exit handling** (`api.md § Exit handling`): on child `exit` with `expected === true`
    → nothing. Otherwise log `server exited with code N, restarting` or
    `server exited with code N` to the output channel, then: if `lastUnexpectedExitAt` is
    within the last 60 000 ms → `failed` with cause `Process exited with code N`; else set
    `lastUnexpectedExitAt = now` and `start(lastRoots)` silently. The budget therefore
    restores itself after 60 s of uptime, and `retry()` resets it explicitly. Inject a
    `now()` clock for tests.
  - Only one `start` in flight at a time; calls while `starting` are ignored.
- **`output.ts`** — `getOutputChannel()` creating `vscode.window.createOutputChannel('Code
  Matrix')` once; `appendLine` helpers. Every stderr line and every `$/log` goes here (R10).
- **Tests** (vitest, mocked `vscode`): `FakeChildProcess` (`test/unit/fakes/fakeProcess.ts`)
  implementing the subset of `ChildProcess` used (`stdin`, `stdout`, `stderr` as
  `PassThrough`, `kill`, `on('exit')`, `on('error')`) with a scripted sidecar that answers
  `initialize` and can `crash(code)` on command; `SidecarManager` takes a `spawn` function
  so the fake is injected. `JsonRpcConnection` is tested over `PassThrough` pairs with frames
  split at arbitrary byte boundaries.

## Design
- `.kernel/specs/features/app-shell/design/flows.md § Sidecar lifecycle` — the state
  diagram, the budget paragraph (one silent restart; spent on a second unexpected exit within
  60 s; restored by 60 s of uptime or by Retry; Restart Server never counts)
- `.kernel/specs/features/app-shell/design/api.md § 1` — client side of `initialize` /
  `shutdown` / `$/status` / `$/log`; `§ Exit handling (extension side)` table, which fixes
  the log line and the two failure causes

## Code anchors
- `extension/src/sidecar/binary.ts` — `resolveServerBinary`, `ServerBinaryMissingError`
- `extension/src/sidecar/protocol.ts` — mirrored types and constants
- `extension/src/sidecar/jsonrpc.ts` — `JsonRpcConnection`
- `extension/src/sidecar/state.ts` — `SidecarState`
- `extension/src/sidecar/manager.ts` — `SidecarManager` (`start`, `restart`, `retry`, `stop`, exit handling)
- `extension/src/output.ts` — `getOutputChannel`
- `extension/test/unit/fakes/fakeProcess.ts`, `extension/test/unit/sidecar/manager.test.ts`,
  `extension/test/unit/sidecar/jsonrpc.test.ts`, `extension/test/unit/sidecar/binary.test.ts`
- `extension/test/unit/mocks/vscode.ts` — gains `window.createOutputChannel`

## Capabilities
- Modifies: none
- Creates: `extension/sidecar-lifecycle` — binary resolution per platform, spawn, JSON-RPC
  client, state machine, restart budget, shutdown, output channel routing

## Invariants / constraints
- The sidecar is never started by this module on its own; only `start()` spawns, and
  `04-open-graph` calls it from `Open Graph` (app-shell R4).
- `initialize` carries every workspace root as absolute paths in one request (app-shell R3).
- Unexpected exit: first → silent restart, no toast, logged; second within 60 s → `failed`
  with cause `Process exited with code N` (app-shell R5, api.md). `Retry` resets the budget
  (R6); `Restart Server` never counts as unexpected (flows.md).
- Exit code 0 after `shutdown` is expected and shows nothing (api.md). An exit code 0 that
  was *not* preceded by `shutdown` is unexpected.
- All sidecar stderr and every `$/log` line is written to the `Code Matrix` output channel;
  nothing from the sidecar is shown as a toast by this module (app-shell R10, R5).
- A missing binary is a failure with cause exactly `Server binary not found for
  <platform>-<arch>: <path>` (app-shell R11).
- `stop()` on deactivate terminates the process (R4): `shutdown`, then `kill()` after 2 s.
- No `vscode` UI calls except `createOutputChannel`; panel and status bar are `04`'s.

## Acceptance criteria
- [ ] Unit: `start(['/proj'])` with a fake that answers `initialize` → states `starting` then `ready`; `connection` is defined; `initialize` params are `{ roots: ['/proj'] }`
- [ ] Unit: `start(['/api', '/web'])` sends one `initialize` with both roots (R3)
- [ ] Unit: fake crashes with code 101 while `ready` → output channel gets `server exited with code 101, restarting`, a second spawn happens, states pass `starting` → `ready`, no `showInformationMessage` / `showWarningMessage` / `showErrorMessage` call on the mock (R5)
- [ ] Unit: second crash 20 s after the first (injected clock) → state `failed` with cause `Process exited with code 101`, no third spawn (R5)
- [ ] Unit: second crash 61 s after the first → silent restart again (budget restored by uptime)
- [ ] Unit: from `failed`, `retry()` → spawn, `starting`, `ready`; a later single crash is again restarted silently (R6)
- [ ] Unit: `restart()` while `ready` → `shutdown` sent, process exits 0, new spawn, `starting` → `ready`; a crash right after does *not* fail (budget untouched)
- [ ] Unit: `stop()` → `shutdown` sent, then on exit no respawn, state `not-started`; if the fake ignores `shutdown`, `kill()` is called after 2 s (R4)
- [ ] Unit: `resolveServerBinary` on `win32`/`x64` with the file absent throws a message exactly `Server binary not found for win32-x64: <extensionPath>\bin\win32-x64\code-matrix-server.exe`; with `CODE_MATRIX_SERVER_PATH` set to an existing file, that path is returned (R11)
- [ ] Unit: `start()` when the binary is missing → `failed` with the R11 cause and `spawn` never called
- [ ] Unit: `$/status { state: 'indexing', detail: 'x' }` → state `{ kind: 'indexing', detail: 'x' }`; `$/log { level: 'warn', message: 'm' }` → output channel line `[warn] m`; a stderr line `boom` → output channel line `boom` (R10)
- [ ] Unit: `JsonRpcConnection` reassembles a frame delivered in 3 chunks split mid-header and mid-body; concurrent requests resolve to their own ids; stream end rejects pending requests
- [ ] `npm run lint`, `npm run test:unit` pass

## Plan
`/plan:change .kernel/specs/epics/app-shell/changes/03-sidecar-lifecycle.md` — plan reads this
file directly and derives the change name from it.
