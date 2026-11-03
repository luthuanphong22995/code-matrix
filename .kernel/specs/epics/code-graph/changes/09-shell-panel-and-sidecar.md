---
title: Shell panel and sidecar — commands, singleton panel, lazy spawn, status bar, output channel, overlays
type: epic-change
epic: code-graph
status: planned
depends-on: [sidecar-rpc-skeleton]
feature: app-shell
---

# shell-panel-and-sidecar

**As a** developer, **I want** `Code Matrix: Open Graph` to open one graph panel for my
workspace, start the analysis server behind it, and show me its state in the panel and the
status bar **so that** every other feature has a place to render and I always know whether
analysis is available.

## Intent
Builds the `open the graph` journey of `app-shell` (R1, R2, R3, R4, R7, R10, R11): the three
commands, the singleton `codeMatrix.graph` webview panel with its toolbar, canvas overlays and
Details frame, the status bar item, the `Code Matrix` output channel, and the sidecar process
wrapper with a JSON-RPC client that mirrors change 03's protocol. The webview shell is built so
that change 12 can fill the canvas and Details and change 14 the toolbar's middle slot without
rewriting it. Restart budget and the failed-state recovery buttons' behaviour are change 11;
`Restart Server` here is a plain stop + start. Jump-to-source is change 13.

## Approach
- **`package.json` contributions** exactly as `app-shell/design/api.md § 3`: commands
  `codeMatrix.openGraph`, `codeMatrix.restartServer`, `codeMatrix.showLog`; `activationEvents`
  on those commands; no sidecar start on activation (R4).
- **`sidecar.ts`** — `Sidecar` class: `start(roots)`, `stop()`, `request(method, params)`,
  `onNotification`, `onExit`. Resolves the binary at
  `<extensionPath>/bin/${process.platform}-${process.arch}/code-matrix-server[.exe]`; a
  missing binary rejects `start` with cause `Server binary not found for <platform>-<arch>: <path>`
  (R11); other spawn errors use the OS error text. stdout → framed JSON-RPC reader; stderr
  and `$/log` → output channel (R10). Sends `shutdown` on `deactivate`/window close (R4).
  State machine `NotStarted | Starting | Ready | Indexing | Failed` from
  `app-shell/design/flows.md § Sidecar lifecycle`, driven by `initialize` result and `$/status`.
  Exposes `onStateChange` for the status bar and the panel. Unexpected exit here → `Failed`
  with `Process exited with code N` (change 11 adds the one silent restart in between).
- **`jsonrpc.ts`** — `Content-Length` framing over a `Readable`/`Writable`, request id
  correlation, notification dispatch; no `vscode` import, so it is unit-testable with vitest.
- **`protocol.ts`** — TS mirrors of `InitializeParams/Result`, `StatusParams`, `LogParams`,
  error codes; one comment per type naming the Rust type in `core/rpc/src/protocol.rs`.
- **`panel.ts`** — `GraphPanel.show(context)`: creates or reveals the single
  `WebviewPanel` (`viewType codeMatrix.graph`, title `Code Matrix`, `ViewColumn.One`,
  `retainContextWhenHidden: true` so webview state survives tab switches); loads
  `dist/webview.js` with a CSP nonce; posts `shell/state` on every sidecar state change and
  once on creation; routes incoming messages through a `MessageRouter` keyed by `type`
  prefix (`shell/` handled here, `graph/` registered by change 12) so later changes add a
  handler module without editing this file's switch. Handles `shell/showLog`,
  `shell/restart`, `shell/retry` (retry = restart for now; change 11 adds budget reset),
  `shell/selectNode` (records the selected node id for change 13).
- **`extension.ts`** — `openGraph`: no workspace folder → information toast
  `Open a folder to analyze` and return (R2); else show the panel and, if the sidecar is
  `NotStarted`, start it with every `workspaceFolders` path (R3); if already running, the
  panel just shows the current state. `restartServer` → `stop()` then `start()`;
  `showLog` → `outputChannel.show()`.
- **`statusBar.ts`** — created hidden; shown on first start; text `Code Matrix: <state>`
  with `starting | ready | indexing | failed`; `errorBackground` when failed; click runs
  `openGraph`, or `showLog` when failed (R7).
- **Webview (`webview/src/`)** — plain TS, no framework. `shell.ts` renders the layout from
  `app-shell/design/ui.md § Graph panel`: 36 px toolbar (left: `Code Matrix` + state text;
  middle: an empty slot `#toolbar-middle`; right: `Details` toggle, `Restart Server`, `Show Log`),
  main region `#canvas` (empty element for change 12), 300 px collapsible Details region
  `#details` with `Select a node to see its details`. Overlays over the main region by state:
  starting → `Starting Code Matrix server…` with toolbar buttons disabled; indexing →
  `Indexing workspace…` with toolbar enabled; failed → heading `Code Matrix server failed`,
  the cause line, buttons `Retry` and `Show Log`, Details empty; ready → no overlay.
  Buttons post `shell/restart`, `shell/showLog`, `shell/retry`. Keyboard: Escape posts a
  selection clear (used by changes 12/13). Uses VS Code theme CSS variables.
- **Tests**: vitest for `jsonrpc.ts` framing and `sidecar.ts` state transitions with a fake
  child process; `@vscode/test-electron` integration: activating, running `openGraph` with no
  folder shows the toast (assert via a stubbed `showInformationMessage`), running it with the
  `fixtures/go` folder creates exactly one panel and re-running focuses it; status bar text
  reaches `Code Matrix: ready` against the real binary from change 03 staged into `bin/`.

## Design
- `.kernel/specs/features/app-shell/design/ui.md § Graph panel` — regions, states starting/indexing/failed/populated/closed, toolbar buttons.
- `.kernel/specs/features/app-shell/design/ui.md § Status bar item` and `§ Toasts`.
- `.kernel/specs/features/app-shell/design/ui/graph-panel.svg`, `graph-panel.starting.svg`, `graph-panel.failed.svg` — what each state looks like.
- `.kernel/specs/features/app-shell/design/api.md § 1` (client side), `§ 2` (`shell/*` messages), `§ 3` (contributions).
- `.kernel/specs/features/app-shell/design/flows.md § Sidecar lifecycle` and `§ Open the graph`.

## Code anchors
- `extension/package.json` — `contributes.commands`, `activationEvents`
- `extension/src/extension.ts` — `activate`, command handlers `openGraph`, `restartServer`, `showLog`
- `extension/src/sidecar.ts` — `Sidecar`, state machine, binary path, exit handling (basic)
- `extension/src/jsonrpc.ts` — framing, request correlation
- `extension/src/protocol.ts` — mirrored types and error codes
- `extension/src/panel.ts` — `GraphPanel`, `MessageRouter`, `shell/*` handlers
- `extension/src/statusBar.ts` — status bar item
- `extension/webview/src/main.ts` — boot, message bridge (`acquireVsCodeApi`)
- `extension/webview/src/shell.ts` — layout, overlays, toolbar chrome, Details frame
- `extension/webview/src/shell.css` — layout styles (inlined by esbuild or loaded as a webview resource)
- `extension/test/unit/jsonrpc.test.ts`, `extension/test/unit/sidecar.test.ts`
- `extension/test/integration/suite/shell.test.ts`

## Capabilities
- Modifies: none
- Creates: `extension/shell-panel` — commands, singleton graph panel, overlays, status bar, output channel, webview message routing; `extension/sidecar-client` — process spawn, JSON-RPC client, state machine, binary resolution.

## Invariants / constraints
- At most one graph panel per window; re-running `Open Graph` reveals it (app-shell R1).
- With no workspace folder, `Open Graph` shows `Open a folder to analyze` and starts nothing (R2).
- `initialize` is sent with every workspace root as an absolute path (R3).
- The sidecar is never spawned on activation; only by the first `Open Graph`, `Restart Server` or a status-bar click; it is sent `shutdown` when the window closes (R4).
- The status bar item is hidden until the first start, then always reads one of the four state strings (R7).
- All sidecar stderr and every `$/log` line land in the `Code Matrix` output channel (R10).
- A missing binary is a failed state with cause `Server binary not found for <platform>-<arch>: <path>` (R11).
- The webview shell renders nothing in the main region in the ready state (code-graph owns it).
- `jsonrpc.ts` and `protocol.ts` import nothing from `vscode`.

## Acceptance criteria
- [ ] vitest: `jsonrpc.ts` round-trips a request/response and a notification through `Content-Length` framing, including a body split across two chunks; `sidecar.ts` goes `Starting → Ready` on an `initialize` reply, `Ready → Indexing → Ready` on `$/status`, and `→ Failed` with the right cause on missing binary and on exit code 101.
- [ ] Integration: with `fixtures/go` open, `codeMatrix.openGraph` creates one panel titled `Code Matrix`, a second run does not create another, the status bar shows `Code Matrix: ready` within 10 s, and the panel's webview reports state `ready` (assert via a test-only `shell/stateReport` message or the panel's `webview.html` state attribute).
- [ ] Integration: with no folder open, `codeMatrix.openGraph` shows `Open a folder to analyze` and no panel exists.
- [ ] Renaming the staged binary makes `openGraph` reach the failed overlay with the `Server binary not found…` cause and the status bar in error background.
- [ ] `codeMatrix.showLog` reveals an output channel named `Code Matrix` that contains the sidecar's stderr.

## Plan
`/plan:change .kernel/specs/epics/code-graph/changes/09-shell-panel-and-sidecar.md` — plan reads this file
directly and derives the change name from it.
