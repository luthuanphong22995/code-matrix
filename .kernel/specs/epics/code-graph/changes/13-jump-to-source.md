---
title: Jump to source — open a node's file at its range, missing-file toast, Escape clears selection
type: epic-change
epic: code-graph
status: planned
depends-on: [graph-canvas]
feature: app-shell
---

# jump-to-source

**As a** developer, **I want** to double-click a graph node, press Enter, or click
`Open in editor` and land in its code beside the graph **so that** the graph is a way into the
source, not a picture of it.

## Intent
Builds the `jump to source` journey of `app-shell` (R8 open-at-range, R9 missing file). The
webview already emits `shell/openNode` and `shell/selectNode` (change 12); this change is the
extension-host side: resolving the node id to a file and range, opening it in a column beside
the graph with the range revealed, the `File not found: <path>` warning toast when the file is
gone, and the Escape-clears-selection path through to the Details region.

## Approach
- `openNode.ts`: `openNode(nodeId)` looks the node up in `graphController.nodeIndex`
  (path, startLine, endLine, workspace root — the index stores paths relative to a root, so
  the controller must keep the root per node; with multiple roots the sidecar's path prefix
  (change 08) is mapped back to the root's `Uri`). Unknown id → no-op with a log line.
  Placeholder → never reaches here (12 does not send it), but guard anyway.
- Existence check with `vscode.workspace.fs.stat`; missing → `showWarningMessage('File not found: <path>')`
  and return, selection untouched (R9).
- Open with `vscode.window.showTextDocument(uri, { viewColumn: ViewColumn.Beside, preserveFocus: false, selection: range })`
  where `range` is `startLine..endLine` (1-based from the wire → 0-based), and
  `editor.revealRange(range, InCenter)`; cursor at the start line (flows.md § Jump to source).
  `Beside` relative to the graph panel: reveal the panel's column first if needed so the
  editor opens next to it rather than next to whatever was last active.
- `shell/selectNode` in `panel.ts` stores `selectedNodeId`; `shell/openNode` calls
  `openNode`. Escape in the webview clears the selection locally and posts
  `shell/selectNode { nodeId: null }`; Details returns to `Select a node to see its details`
  (12 renders that; this change verifies the round trip).
- Tests: vitest for the id → `Uri`/`Range` mapping including the multi-root prefix; integration
  over `fixtures/go`: expand `config.go`, select `parseConfig`, post `shell/openNode`, assert
  the active editor is `config.go` in a column other than the panel's with the selection on
  `parseConfig`'s line; delete `util.go` on disk (in a temp copy of the fixture) and open its
  node → toast text `File not found: util.go` and the selection still `util.go`.

## Design
- `.kernel/specs/features/app-shell/design/flows.md § Jump to source`.
- `.kernel/specs/features/app-shell/design/ui.md § Graph panel — Behavior` (double-click, Enter, `Open in editor`, Escape) and `§ Toasts`.
- `.kernel/specs/features/app-shell/design/api.md § 2` — `shell/selectNode`, `shell/openNode`.

## Code anchors
- `extension/src/openNode.ts` — `openNode`, id → `Uri` + `Range`, stat check, toast
- `extension/src/panel.ts` — `shell/openNode` → `openNode`; `shell/selectNode` with `null`
- `extension/src/graphController.ts` — `nodeIndex` exposes root + path + range (read only; added in 12)
- `extension/test/unit/openNode.test.ts`
- `extension/test/integration/suite/jump.test.ts`

## Capabilities
- Modifies: `extension/shell-panel` (openNode + selection clear handling)
- Creates: `extension/jump-to-source` — node → editor navigation with missing-file handling.

## Invariants / constraints
- Double-click, Enter and `Open in editor` all open the node's file beside the graph with its range revealed and the cursor on the start line (app-shell R8).
- A node whose file no longer exists shows the warning toast `File not found: <path>` and keeps the selection (R9).
- Escape clears the selection and the Details region shows `Select a node to see its details`.
- Opening never moves or replaces the graph panel's tab.
- A placeholder node is never opened.

## Acceptance criteria
- [ ] vitest: relative path + root → correct `Uri`; multi-root prefix maps to the right root; 1-based lines map to a 0-based `Range`.
- [ ] Integration over `fixtures/go`: `shell/openNode` on `parseConfig` opens `config.go` beside the panel with the selection on its declaration line and the panel still open.
- [ ] Integration: a node whose file was deleted shows `File not found: <path>` and the selection is unchanged (assert via the webview's debug state).
- [ ] Integration: Escape in the panel clears the selection and the Details region shows the placeholder text.

## Plan
`/plan:change .kernel/specs/epics/code-graph/changes/13-jump-to-source.md` — plan reads this file
directly and derives the change name from it.
