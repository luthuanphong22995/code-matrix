---
title: Jump To Source
type: epic-change
epic: app-shell
status: planned
depends-on: [open-graph]
feature: app-shell
---

# jump-to-source

**As a** developer, **I want** to select a node in the graph, see what it is, and open its
code beside the graph **so that** I can move from the picture to the source in one gesture.

## Intent
The "jump to source" journey: a shell-owned **node registry** in the extension host
(`nodeId → kind, name, path, range`), node selection (`shell/selectNode`) that fills the
Details region (`Kind`, `Name`, `Location` as `path:line`, `Open in editor`), opening the
node's file beside the graph at its range (`shell/openNode`, double-click, Enter, `Open in
editor`), the `File not found: <path>` toast that keeps the selection, and Escape to clear.
The interview settled that the shell owns the registry: whatever feature sends nodes to the
webview (`code-graph`, via `graph/files` / `graph/expanded`) registers them first, so the
shell never calls `graph/*`. Until `code-graph` lands no real nodes exist; this change
proves the mechanism with nodes injected through the registry in tests, and gives the webview
a generic node element contract (`data-node-id`) the canvas will emit.

## Approach
- **`nodes/registry.ts`** — `NodeRegistry`: `register(nodes: NodeRecord[])`,
  `remove(ids)`, `get(id): NodeRecord | undefined`, `clear()`; `NodeRecord = { id, kind:
  string, name: string, path: string /* absolute */, range: { startLine, startCol, endLine,
  endCol } /* 0-based */ }`. Exposed on the `shell` object from `extension.ts` so
  `code-graph` can call `shell.nodes.register(...)` before posting `graph/*` payloads.
  `code-graph`'s own `Node` (`.kernel/specs/features/code-graph/design/data-model.md`) maps
  onto `NodeRecord`; the registry does not import it.
- **Selection** — `GraphPanel` keeps `selectedNodeId`. `shell/selectNode { nodeId }` →
  look up the record; post `shell/selection { node: { kind, name, location:
  '<workspace-relative path>:<startLine+1>' } | null }` back to the webview so the Details
  region renders (this ext → webview message is new; add it to `panel/messages.ts` and to
  `design/api.md § 2` in the change's docs task). Unknown id → `shell/selection null`.
  Selection is re-posted after `shell/state` so a re-shown panel keeps it.
- **`nodes/openNode.ts`** — `openNodeInEditor(record)`: `fs.stat` the path; missing →
  `showWarningMessage('File not found: <workspace-relative path>')`, selection untouched
  (R9). Else `workspace.openTextDocument(uri)` → `window.showTextDocument(doc, {
  viewColumn: ViewColumn.Beside, preserveFocus: false, selection: new Range(startLine,
  startCol, startLine, startCol) })`, then `editor.revealRange(fullRange,
  TextEditorRevealType.InCenter)` so lines start–end are revealed with the cursor at the
  start line (R8). `shell/openNode { nodeId }` → this.
- **Webview** (`media/main.ts`): selection model over elements carrying `data-node-id`
  inside `#main` (the canvas library later emits real elements or calls the same
  `selectNode(id)` API from `window.codeMatrixShell`): single click → `shell/selectNode`;
  double-click → `shell/openNode`; keydown Enter with a selection → `shell/openNode`;
  Escape → clear selection locally and post `shell/selectNode { nodeId: null }` (extend the
  message to allow `null`; document). `shell/selection` → fill `#details` fields or show
  `Select a node to see its details`; `Open in editor` button → `shell/openNode` for the
  selected id. The `Details` toggle on the toolbar collapses `#details` (ui.md). Expose
  `window.codeMatrixShell = { selectNode(id), getSelectedNodeId() }` as the seam the canvas
  uses and tests drive.
- **Tests** — unit (vitest, mocked `vscode`): registry; `openNodeInEditor` happy path
  (asserts `showTextDocument` options and `revealRange` args) and missing-file path
  (warning text, no `openTextDocument`). Integration: register a node for
  `fixtures/workspace/src/config.go` lines 12–40 through `shell.nodes.register`, post
  `shell/openNode` → an editor for that file is visible in a different view column from
  the panel with `selection.active.line === 11`; register a node for a missing file →
  warning shown (spy) and `GraphPanel.selectedNodeId` unchanged. Webview unit (jsdom): click
  / dblclick / Enter / Escape / `Open in editor` post the expected messages; `shell/selection`
  renders `function`, `parseConfig`, `src/config.go:12`.

## Design
- `.kernel/specs/features/app-shell/design/ui.md § Graph panel` — Details region (field
  order `Kind`, `Name`, `Location`, `Open in editor`; empty text), **populated** state,
  Behavior (single click, double-click / Enter / `Open in editor`, Escape), `Details` toggle
- `.kernel/specs/features/app-shell/design/ui.md § Toasts` — `File not found: <path>` (warning)
- `.kernel/specs/features/app-shell/design/flows.md § Jump to source`
- `.kernel/specs/features/app-shell/design/api.md § 2` — `shell/selectNode`, `shell/openNode`;
  this change adds `shell/selection` (ext → webview) and `nodeId: null` on `selectNode`

## Code anchors
- `extension/src/nodes/registry.ts` — `NodeRegistry`, `NodeRecord`
- `extension/src/nodes/openNode.ts` — `openNodeInEditor`
- `extension/src/extension.ts` — `shell.nodes` export
- `extension/src/panel/graphPanel.ts` — `selectedNodeId`, handlers for `shell/selectNode`, `shell/openNode`, `postSelection`
- `extension/src/panel/messages.ts` — `shell/selection`, `selectNode` with `nodeId | null`
- `extension/media/main.ts`, `extension/media/main.css` — selection model, details rendering, keyboard, `Details` toggle, `window.codeMatrixShell`
- `extension/test/unit/nodes/registry.test.ts`, `extension/test/unit/nodes/openNode.test.ts`,
  `extension/test/unit/webview/details.test.ts`
- `extension/test/integration/suite/jumpToSource.test.ts`,
  `extension/test/integration/fixtures/workspace/src/config.go` (a 40+ line fixture file)
- `.kernel/specs/features/app-shell/design/api.md` — document `shell/selection` and `nodeId: null`

## Capabilities
- Modifies: `extension/graph-panel` (selection state, two new message handlers, details
  rendering, keyboard)
- Creates: `extension/jump-to-source` — node registry, open-beside with range reveal,
  missing-file toast, selection semantics

## Invariants / constraints
- Single click selects and shows kind, name, `file:line`; double-click or Enter opens the
  file at its range in an editor **beside** the graph (app-shell R8). `Open in editor` does
  the same (ui.md).
- A node whose file no longer exists → `File not found: <path>` warning and the selection
  stays (R9). Nothing else changes: no deselect, no editor opened.
- `Location` shows the workspace-relative path and the 1-based start line; the registry
  stores absolute paths and 0-based ranges (VS Code API convention).
- The shell never calls `graph/*`; node data enters only through `NodeRegistry.register`
  (dependency direction `code-graph → shell`). The Details region's extra sections (edge
  counts, code-graph R12) are appended by `code-graph`, below the shell's fields.
- Escape clears the selection and the Details region shows `Select a node to see its
  details`; with nothing selected, Enter and `Open in editor` do nothing.
- The editor opens in `ViewColumn.Beside` relative to the panel, never replacing the panel's
  tab.

## Acceptance criteria
- [ ] Unit: `register` then `get` returns the record; `remove` drops it; `register` with an existing id overwrites it
- [ ] Unit: `openNodeInEditor` for an existing file calls `showTextDocument` with `viewColumn: Beside` and a selection at `(startLine, startCol)`, then `revealRange` with the full range (R8)
- [ ] Unit: `openNodeInEditor` for a missing file calls `showWarningMessage('File not found: src/old.go')` and never `openTextDocument`; the panel's `selectedNodeId` is unchanged (R9)
- [ ] Integration: node `parseConfig` registered for `src/config.go` lines 12–40; `shell/openNode` → an editor for `config.go` is in `window.visibleTextEditors`, its `viewColumn !== panel.viewColumn`, `selection.active.line === 11`, and the `Code Matrix` tab is still open (R8)
- [ ] Integration: `shell/selectNode { nodeId }` → the panel posts `shell/selection` with `kind: 'function'`, `name: 'parseConfig'`, `location: 'src/config.go:12'` (captured through a test hook on `GraphPanel`) (R8)
- [ ] Webview unit: with `parseConfig` selected, `Enter` posts `shell/openNode { nodeId }`; `Escape` posts `shell/selectNode { nodeId: null }` and the details show `Select a node to see its details`; `Open in editor` posts `shell/openNode`; dblclick posts `shell/openNode`; with nothing selected, `Enter` posts nothing (R8)
- [ ] Webview unit: `shell/selection null` renders `Select a node to see its details`; the `Details` toggle hides and shows `#details`
- [ ] `design/api.md § 2` documents `shell/selection` and the `null` form of `shell/selectNode`
- [ ] `npm run lint`, `npm run test:unit`, `npm run test:integration` pass

## Plan
`/plan:change .kernel/specs/epics/app-shell/changes/07-jump-to-source.md` — plan reads this
file directly and derives the change name from it.
