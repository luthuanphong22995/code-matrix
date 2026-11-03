---
title: Open Graph
type: epic-change
epic: app-shell
status: planned
depends-on: [sidecar-rpc-server, sidecar-lifecycle]
feature: app-shell
---

# open-graph

**As a** developer, **I want** `Code Matrix: Open Graph` to open one graph panel for my
workspace and start the sidecar lazily, with the status bar showing where things stand
**so that** I get a live graph panel, or a clear reason why not.

## Intent
The "open the graph" journey end to end: the `codeMatrix.openGraph` command with its
workspace guard, the singleton `Code Matrix` editor-tab panel with the three named regions
and the starting / indexing / populated-empty / closed states, the status bar item for the
non-failed states, activation on the three commands only, and sidecar shutdown on
deactivate. The failed state's overlay and buttons, the other two commands and the details
region's content are left to `06-failure-recovery` and `07-jump-to-source`; this change
renders their placeholders (toolbar buttons present but inert, details text
`Select a node to see its details`). This is also where the real `code-matrix-server` from
`02` and the manager from `03` first meet, in integration tests.

## Approach
- **Contributions** (`extension/package.json`, `api.md § 3`): commands `codeMatrix.openGraph`
  (`Code Matrix: Open Graph`), `codeMatrix.restartServer`, `codeMatrix.showLog` all declared
  now so the menu is complete; `activationEvents` are the three `onCommand:` entries and
  nothing else (R4). `restartServer` / `showLog` handlers are registered in `06`; here they
  are stubs that call `manager.restart()` / `getOutputChannel().show()` only if trivial —
  decide in plan; the acceptance below does not test them.
- **`extension.ts`** — `activate`: create `SidecarManager`, `StatusBarItem` controller,
  register `openGraph`; store on a module-level `Shell` object other features import.
  `deactivate`: `manager.stop()` (R4).
- **`commands.ts`** — `openGraph()`:
  1. `vscode.workspace.workspaceFolders` empty or undefined → `showInformationMessage('Open a
     folder to analyze')`, return (R2).
  2. `GraphPanel.createOrShow(context)` (R1).
  3. If `manager.state.kind === 'not-started'` → `manager.start(workspaceFolders.map(f =>
     f.uri.fsPath))` (R3, R4). Otherwise nothing: reopening does not restart (scenario
     "reopening a closed panel does not restart the sidecar").
- **`panel/graphPanel.ts`** — `GraphPanel` singleton (`static current`), `createWebviewPanel
  ('codeMatrix.graph', 'Code Matrix', ViewColumn.One, { enableScripts: true,
  retainContextWhenHidden: true, localResourceRoots: [dist] })`. `createOrShow` reveals the
  existing panel (`panel.reveal()`) or creates one. `onDidDispose` clears `current` — the
  sidecar keeps running (closed state). On create and on every `manager.onDidChangeState`,
  post `shell/state { state, cause? }` where `starting`/`indexing`/`ready`/`failed` map from
  `SidecarState` (`not-started` is sent as `starting`, since a panel only exists after
  `Open Graph`). HTML from `getHtml(webview, nonce)` with CSP (`default-src 'none'`,
  `script-src 'nonce-…'`, `style-src ${webview.cspSource}`), loading `dist/webview.js` and
  `dist/webview.css`.
- **`panel/messages.ts`** — the `shell/*` message union from `api.md § 2`, shared by the
  extension and `media/main.ts` (imported by both bundles).
- **`media/main.ts` + `media/main.css`** — the webview: layout from `ui.md § Graph panel`:
  `#toolbar` (36 px; left: `Code Matrix` label + `#state-text`; middle: empty `#toolbar-slot`
  for other features; right: buttons `#btn-restart` `Restart Server`, `#btn-showlog`
  `Show Log`, `#btn-details` `Details` toggle), `#main` (canvas host, empty; `#overlay`
  child for centered state text), `#details` (300 px, collapsible via `Details`, fields
  `Kind`, `Name`, `Location`, button `Open in editor`, empty text `Select a node to see its
  details`). On `shell/state`: `starting` → overlay `Starting Code Matrix server…`, toolbar
  buttons disabled; `indexing` → overlay `Indexing workspace…`, toolbar enabled; `ready` →
  overlay hidden, toolbar enabled; `failed` → handled in `06` (render the overlay heading
  only, no buttons yet, so the state is not silently lost). `#state-text` shows the state
  word. Colours via `--vscode-*` CSS variables only. Vanilla DOM, no framework.
- **`statusBar.ts`** — `StatusBar` controller around
  `createStatusBarItem('codeMatrix.status', StatusBarAlignment.Left)`; hidden until the first
  `start()` (subscribe to `onDidChangeState`, `show()` on the first non-`not-started` state);
  text `Code Matrix: starting | ready | indexing`; `command = 'codeMatrix.openGraph'`. The
  `failed` text, error background and log-click come in `06`.
- **Integration tests** (`@vscode/test-electron`, mocha) run with
  `CODE_MATRIX_SERVER_PATH` pointing at the cargo-built `code-matrix-server` from `02` (the
  test runner builds or locates `core/target/debug/`), plus a scripted fake server for the
  cases the real one cannot produce (see tests in `06`). Workspace-less cases launch VS Code
  with no folder argument; multi-root cases open
  `extension/test/integration/fixtures/multi-root.code-workspace` with two folders.

## Design
- `.kernel/specs/features/app-shell/design/ui.md § Graph panel` — regions (Toolbar, Main
  region, Details region), states **starting**, **indexing**, **populated**, **closed**
  (SVGs `design/ui/graph-panel.svg`, `design/ui/graph-panel.starting.svg`)
- `.kernel/specs/features/app-shell/design/ui.md § Status bar item` — states `starting`,
  `ready`, `indexing`, hidden; click opens the panel
- `.kernel/specs/features/app-shell/design/ui.md § Toasts` — `Open a folder to analyze`
- `.kernel/specs/features/app-shell/design/flows.md § Open the graph`
- `.kernel/specs/features/app-shell/design/api.md § 2` (`shell/state`) and `§ 3` (contributions, activation)

## Code anchors
- `extension/package.json` — `contributes.commands`, `activationEvents`
- `extension/src/extension.ts` — `activate`, `deactivate`, exported `shell` (manager, panel accessor, status bar)
- `extension/src/commands.ts` — `openGraph`, `registerCommands`
- `extension/src/panel/graphPanel.ts` — `GraphPanel` (`createOrShow`, `postState`, `onDidDispose`, `getHtml`)
- `extension/src/panel/messages.ts` — `ShellToWebview`, `WebviewToShell` message types
- `extension/src/statusBar.ts` — `StatusBar` (`update(state)`)
- `extension/media/main.ts`, `extension/media/main.css` — webview regions and overlays
- `extension/esbuild.mjs` — add the css output for the webview
- `extension/src/sidecar/manager.ts` — consumed (`start`, `state`, `onDidChangeState`); no change expected
- `extension/test/integration/suite/openGraph.test.ts`, `extension/test/integration/suite/noFolder.test.ts`,
  `extension/test/integration/fixtures/multi-root.code-workspace`, `extension/test/integration/runTest.ts` (server path, multiple launches)
- `extension/test/unit/statusBar.test.ts`, `extension/test/unit/commands.test.ts`

## Capabilities
- Modifies: `extension/sidecar-lifecycle` (consumed via `start` / `stop`; its spec gains the
  `deactivate → stop` anchor)
- Creates: `extension/graph-panel` — singleton `Code Matrix` editor tab, regions, state
  overlays, `shell/state`; `extension/status-bar` — state text, visibility, click behaviour

## Invariants / constraints
- At most one `Code Matrix` panel per window; re-running `Open Graph` reveals it
  (app-shell R1).
- No workspace folder → toast `Open a folder to analyze`, no panel, no sidecar (R2).
- Multi-root → one panel, one `initialize` with every root (R3).
- Activation never starts the sidecar; only `Open Graph` does, and only when `not-started`
  (R4). Closing the panel leaves the sidecar running; reopening re-sends the current state
  and does not spawn (ui.md closed state). Window close / deactivate stops it (R4).
- Status bar text is exactly `Code Matrix: starting` / `ready` / `indexing`; hidden before
  the first start; click runs `codeMatrix.openGraph` (R7).
- Region names `Toolbar`, `Main region`, `Details region` and the ids above are the seam
  `code-graph` cites; the shell draws nothing in `#main` except the overlay (ui.md).
- Webview CSP: nonce'd script, no inline handlers, no remote resources.

## Acceptance criteria
- [ ] Integration: with the fixture folder open and the real binary, `codeMatrix.openGraph` → a tab titled `Code Matrix` is active, the status bar item text becomes `Code Matrix: starting` and then `Code Matrix: ready` within 5 s, `manager.state.kind === 'ready'` (R1, R4, R7)
- [ ] Integration: running `codeMatrix.openGraph` again with another editor active → `GraphPanel.current` is the same instance, `window.tabGroups` has exactly one `Code Matrix` tab, and it is active (R1)
- [ ] Integration: VS Code launched with no folder → `codeMatrix.openGraph` shows `Open a folder to analyze` (captured via a `showInformationMessage` spy or a mocked `vscode.window` in the suite), no `Code Matrix` tab, `manager.state.kind === 'not-started'` (R2)
- [ ] Integration: `multi-root.code-workspace` → one panel; the `initialize` request seen by a recording wrapper around the server carries both root paths (R3)
- [ ] Integration: after `activate()` with no command run, no `code-matrix-server` process exists and the status bar item is not shown (R4)
- [ ] Integration: close the `Code Matrix` tab while `ready`, run `codeMatrix.openGraph` → new tab, same `manager.connection` object, status bar still `Code Matrix: ready` (R1, R4)
- [ ] Integration: `deactivate()` → the server process has exited within 3 s (R4)
- [ ] Unit: `StatusBar.update` for each `SidecarState` sets the exact text and `command`; hidden until the first non-`not-started` state (R7)
- [ ] Webview (unit, jsdom or a DOM stub): `shell/state starting` shows `Starting Code Matrix server…` with `#btn-restart` and `#btn-showlog` disabled; `indexing` shows `Indexing workspace…` with buttons enabled; `ready` hides the overlay; `#details` shows `Select a node to see its details` in all three
- [ ] `npm run lint`, `npm run test:unit`, `npm run test:integration` pass

## Plan
`/plan:change .kernel/specs/epics/app-shell/changes/04-open-graph.md` — plan reads this file
directly and derives the change name from it.
