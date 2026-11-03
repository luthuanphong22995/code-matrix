---
title: Failure Recovery
type: epic-change
epic: app-shell
status: planned
depends-on: [open-graph]
feature: app-shell
---

# failure-recovery

**As a** developer, **I want** to see when analysis has stopped and why, read the log, and
retry or restart the server **so that** a crashed sidecar is a bump, not a dead feature.

## Intent
The "recover from a failed sidecar" journey on the surfaces `04-open-graph` created: the
panel's **failed** overlay (heading, cause, `Retry`, `Show Log`), the `shell/retry` /
`shell/restart` / `shell/showLog` messages, the toolbar's `Restart Server` and `Show Log`
buttons, the `Code Matrix: Restart Server` and `Code Matrix: Show Log` commands, and the
status bar's `failed` state with error background and log-on-click. The lifecycle logic
(budget, `retry()`, `restart()`) already exists in `03-sidecar-lifecycle`; this change wires
the user-facing paths onto it and proves the scenarios end to end against a scripted fake
server that can crash on demand.

## Approach
- **Commands** (`commands.ts`): `restartServer` → `manager.restart()` (if `not-started`, do
  nothing — there is nothing to restart; decide in plan whether to start instead; the
  scenario only covers `ready`). `showLog` → `getOutputChannel().show(true)` (R10).
- **Panel** (`panel/graphPanel.ts`): handle webview messages `shell/retry` →
  `manager.retry()`, `shell/restart` → `manager.restart()`, `shell/showLog` → the `showLog`
  command. `postState` for `failed` includes `cause` from `SidecarState`.
- **Webview** (`media/main.ts`, `main.css`): `failed` state replaces the canvas with
  `#overlay-failed`: heading `Code Matrix server failed`, one line with the cause, buttons
  `#btn-retry` `Retry` and `#btn-failed-showlog` `Show Log`; details region emptied;
  toolbar `Restart Server` / `Show Log` stay enabled (ui.md failed state SVG). `Retry` posts
  `shell/retry`, both `Show Log` buttons post `shell/showLog`, toolbar `Restart Server`
  posts `shell/restart`. Leaving `failed` (→ `starting`) removes the overlay and restores
  the starting overlay.
- **Status bar** (`statusBar.ts`): `failed` → text `Code Matrix: failed`, `backgroundColor =
  new ThemeColor('statusBarItem.errorBackground')`, `command = 'codeMatrix.showLog'`; any
  other state clears the background and restores `codeMatrix.openGraph` (R7).
- **Fake server for integration tests** (`extension/test/integration/fixtures/fake-server/`):
  a small Node script speaking the protocol (framing + `initialize` → `ready`) driven by the
  env var `FAKE_SERVER_SCRIPT` with values such as `ok`, `crash-after-init:101`,
  `crash-count-file:<path>` (crash on the first N spawns counted in a file, then behave).
  Launched through a platform wrapper (`fake-server.cmd` / `fake-server.sh` invoking
  `process.execPath` with `ELECTRON_RUN_AS_NODE=1` or the system `node`) so
  `CODE_MATRIX_SERVER_PATH` can point at it. Plan decides the wrapper mechanics; the
  requirement is that the integration suite can produce one crash, two crashes within 60 s,
  and a missing binary.

## Design
- `.kernel/specs/features/app-shell/design/ui.md § Graph panel` — state **failed**
  (`design/ui/graph-panel.failed.svg`), behaviours `Restart Server`, `Show Log`, `Retry`
- `.kernel/specs/features/app-shell/design/ui.md § Status bar item` — `Code Matrix: failed`
  with error background; click reveals the output channel
- `.kernel/specs/features/app-shell/design/flows.md § Recover from a failed sidecar` —
  including abandonment: closing the panel in `failed` leaves the status bar at `failed`;
  nothing retries on its own
- `.kernel/specs/features/app-shell/design/api.md § 2` — `shell/retry`, `shell/restart`,
  `shell/showLog`; `§ 3` — `codeMatrix.restartServer`, `codeMatrix.showLog`

## Code anchors
- `extension/src/commands.ts` — `restartServer`, `showLog`, `registerCommands`
- `extension/src/panel/graphPanel.ts` — `onDidReceiveMessage` handlers for `shell/retry`, `shell/restart`, `shell/showLog`; `postState` with `cause`
- `extension/src/panel/messages.ts` — already declares the three messages; verify
- `extension/media/main.ts`, `extension/media/main.css` — failed overlay, button wiring
- `extension/src/statusBar.ts` — `failed` branch
- `extension/src/sidecar/manager.ts` — consumed (`retry`, `restart`); no change expected
- `extension/test/integration/fixtures/fake-server/fake-server.js` (+ `.cmd` / `.sh` wrappers)
- `extension/test/integration/suite/recovery.test.ts`
- `extension/test/unit/statusBar.test.ts`, `extension/test/unit/webview/failed.test.ts`

## Capabilities
- Modifies: `extension/graph-panel` (failed overlay, three webview messages),
  `extension/status-bar` (failed state)
- Creates: `extension/sidecar-recovery` — `Retry` / `Restart Server` / `Show Log` surfaces
  and commands wired to the lifecycle manager

## Invariants / constraints
- In `failed` the panel shows the cause with exactly the buttons `Retry` and `Show Log`;
  `Retry` resets the restart budget and starts the sidecar (app-shell R6).
- Status bar text `Code Matrix: failed` uses the error background; clicking it opens the
  log, not the panel (R7).
- `Show Log` reveals the `Code Matrix` output channel, which already contains the sidecar's
  stderr (R10).
- `Restart Server` passes through `starting` and never counts toward the unexpected-exit
  budget (R5, flows.md). `Retry` and `Restart Server` are the only ways out of `failed`;
  nothing retries automatically (flows.md abandonment).
- A missing binary renders in the panel as `Server binary not found for <platform>: <path>`
  with the same two buttons (R11).
- No toast for a silent restart; the first crash is invisible outside the log (R5).

## Acceptance criteria
- [ ] Integration (fake server, `crash-after-init:101` once): panel reaches `ready`, server crashes → no message shown, status bar passes `Code Matrix: starting` → `Code Matrix: ready`, output channel contains `server exited with code 101, restarting` (R5, R10)
- [ ] Integration (fake crashes twice within 60 s): panel shows `Code Matrix server failed`, cause `Process exited with code 101`, buttons `Retry` and `Show Log` (asserted via a webview test hook or the posted `shell/state` message), status bar `Code Matrix: failed` with `backgroundColor` set and `command === 'codeMatrix.showLog'` (R5, R6, R7)
- [ ] Integration: from `failed`, posting `shell/retry` (or clicking `Retry` through the test hook) → status bar `Code Matrix: starting` then `ready`; a subsequent single crash is restarted silently (budget reset) (R6)
- [ ] Integration: `shell/showLog` and `codeMatrix.showLog` both reveal the `Code Matrix` output channel (visible in `window.visibleTextEditors` / output channel spy) (R6, R10)
- [ ] Integration: with `bin/` empty and no override, `codeMatrix.openGraph` opens the panel in `failed` with cause exactly `Server binary not found for <host-key>: <path>` and the two buttons (R11)
- [ ] Integration: `codeMatrix.restartServer` while `ready` → status bar passes `starting` → `ready`, a new server process id, and a crash right afterwards is still restarted silently (R5, R7)
- [ ] Integration: close the panel while `failed`, wait 5 s → status bar still `Code Matrix: failed`, no new spawn (flows.md abandonment)
- [ ] Unit: `StatusBar.update({ kind: 'failed', cause })` sets text, error background and the `showLog` command; a following `starting` clears the background and restores `openGraph` (R7)
- [ ] Webview unit: `shell/state { state: 'failed', cause: 'x' }` renders heading, `x`, `Retry`, `Show Log`, empties `#details`; clicking `Retry` posts `shell/retry`; `shell/state starting` afterwards removes the failed overlay
- [ ] `npm run lint`, `npm run test:unit`, `npm run test:integration` pass

## Plan
`/plan:change .kernel/specs/epics/app-shell/changes/06-failure-recovery.md` — plan reads this
file directly and derives the change name from it.
