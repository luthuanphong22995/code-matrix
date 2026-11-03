---
title: Sidecar recovery — restart budget, failed state, Retry, exit-code handling
type: epic-change
epic: code-graph
status: planned
depends-on: [shell-panel-and-sidecar]
feature: app-shell
---

# sidecar-recovery

**As a** developer, **I want** a crashed analysis server to come back on its own once, and
a clear failed state with Retry and Show Log when it keeps crashing **so that** a flaky
sidecar never leaves me with a dead panel and no explanation.

## Intent
Builds the `recover from a failed sidecar` journey (app-shell R5, R6, plus the exit-handling
table in `api.md § 1`): the one-silent-restart budget with its 60 s window, the failed state
after the second unexpected exit, `Retry` resetting the budget, and the distinction between
expected exit (after `shutdown`), user-initiated `Restart Server`, and unexpected exits.

## Approach
- **Budget** in `sidecar.ts`: `lastUnexpectedExitAt?: number`, `budgetSpent: boolean`. On an
  unexpected exit (any exit not following our own `shutdown`/`stop`): if a previous unexpected
  exit happened < 60 s ago, or the budget is spent → `Failed` with cause
  `Process exited with code N`; else log `server exited with code N, restarting` to the output
  channel, record the time, and respawn silently (state passes through `Starting`; no toast,
  R5). The budget is restored after 60 s of uptime since the last unexpected exit (a timer or
  a check at the next exit — the check is simpler) or by `Retry`.
- **`Restart Server`** (`shell/restart`, the command, the toolbar button): marks the next exit
  expected, stops, starts; never counts against the budget; state passes through `Starting`.
- **`Retry`** (`shell/retry`, failed overlay): resets `budgetSpent` and `lastUnexpectedExitAt`,
  starts the sidecar; on another spawn failure the panel returns to failed with the new cause
  (R6). While the panel is closed in the failed state nothing retries; the status bar stays
  `failed` and its click reveals the log (R7, flows.md abandonment).
- **Index re-run after a silent restart**: nothing to do here — the sidecar runs a full run on
  every start (change 10), which is what workspace-index R12 asks for; the panel shows the
  `indexing` overlay during it.
- Webview: the failed overlay from change 09 already has `Retry`/`Show Log`; this change only
  makes the cause text come from the exit-handling table and verifies the overlay/Details
  behaviour (Details region empty while failed).
- Tests: vitest with a fake child process that can be made to exit with a code on demand and
  a fake clock: first crash → restart, second within 60 s → failed; second after 61 s →
  restart again; `Restart Server` then a crash → restart (budget untouched); `Retry` after
  failed → start and budget reset; exit 0 after `shutdown` → no state change, nothing logged
  as an error. Integration: kill the real sidecar process (via its pid) twice within a few
  seconds and assert the failed overlay with `Process exited with code …` and the status bar
  in error background; click `Retry` (post `shell/retry`) and assert `ready`.

## Design
- `.kernel/specs/features/app-shell/design/flows.md § Sidecar lifecycle` and `§ Recover from a failed sidecar`.
- `.kernel/specs/features/app-shell/design/api.md § 1 — Exit handling`.
- `.kernel/specs/features/app-shell/design/ui.md § Graph panel` failed state; `ui/graph-panel.failed.svg`.

## Code anchors
- `extension/src/sidecar.ts` — `onExit` handling, budget fields, `restart()`, `retry()`, expected-exit flag
- `extension/src/panel.ts` — `shell/retry` → `retry()`, `shell/restart` → `restart()`
- `extension/src/extension.ts` — `restartServer` command → `restart()`
- `extension/webview/src/shell.ts` — failed overlay cause text, Details emptied while failed
- `extension/test/unit/sidecar.test.ts` — budget scenarios with a fake process and clock
- `extension/test/integration/suite/recovery.test.ts`

## Capabilities
- Modifies: `extension/sidecar-client` (budget, retry, exit classification); `extension/shell-panel` (retry wiring, failed overlay cause)
- Creates: none

## Invariants / constraints
- Exactly one silent restart is attempted; a second unexpected exit within 60 s of the previous one puts the shell in the failed state (app-shell R5).
- A silent restart shows no toast; it is logged as `server exited with code N, restarting` (R5, ui.md Toasts).
- `Retry` resets the budget and starts the sidecar; `Restart Server` never consumes the budget (R6, flows.md).
- Exit 0 after our own `shutdown` is expected and shows nothing; any other exit is classified by the table in `api.md § 1`.
- In the failed state the panel shows the cause and the `Retry`/`Show Log` buttons, the Details region is empty, and the status bar uses the error background (R6, R7).
- Nothing retries on its own while failed (flows.md abandonment).

## Acceptance criteria
- [ ] vitest covers each scenario listed under Tests and passes.
- [ ] Integration: two kills within 60 s reach the failed overlay with `Process exited with code <N>`; `Retry` returns the panel to `ready` and the status bar to normal background.
- [ ] Integration: one kill followed by nothing shows no toast, logs the restart line, and the panel returns to `ready` after the automatic restart and re-index.
- [ ] `codeMatrix.restartServer` while ready passes the panel through `starting` and back to `ready` with the budget untouched (assert via the unit test; integration asserts the state sequence).

## Plan
`/plan:change .kernel/specs/epics/code-graph/changes/11-sidecar-recovery.md` — plan reads this file
directly and derives the change name from it.
