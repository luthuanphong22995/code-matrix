---
title: Graph canvas — Cytoscape rendering, files + imports, expand/collapse, unresolved, selection, Details, empty state
type: epic-change
epic: code-graph
status: planned
depends-on: [shell-panel-and-sidecar, graph-rpc]
feature: code-graph
---

# graph-canvas

**As a** developer, **I want** the panel to draw my workspace as file nodes with import edges,
let me expand a file into its classes and functions and follow their calls and references,
and show a selected node's details **so that** I can see how an unfamiliar codebase hangs
together without reading every file.

## Intent
The first visible graph. Builds the `explore the graph` journey of `code-graph` (R1, R2, R3,
R4, R10, R12) on Cytoscape.js inside the shell's main region: fetch the file layer when the
sidecar is ready, draw it, expand/collapse through `graph/expand`, draw unresolved references
distinctly, select nodes through the shell, fill the Details region with the shell fields plus
code-graph's additions, and show `No supported source files found` for an empty graph.
Narrowing (search, glob, toggles, focus, cap) is change 14; refresh-after-re-index is change 15;
opening the file is change 13 — but the webview already emits `shell/openNode` on
double-click/Enter so 13 touches only the extension host.

## Approach
- **Dependency**: `cytoscape` (runtime, the extension's first and only runtime dep in this
  epic); layout = built-in `cose` run on every structural change, animated off; no `dagre`
  extension. Positions are never persisted (R11).
- **Extension host, `graphController.ts`** (registered on the `MessageRouter` for `graph/*`):
  - on `graph/changed` from the sidecar, and on panel creation while the sidecar is already
    `ready`: `graph/files` → post `graph/files { nodes, edges }`; zero nodes → post
    `graph/empty` (R10).
  - `graph/expand { fileId }` from the webview → sidecar `graph/expand` → post
    `graph/expanded { fileId, nodes, edges }`; remember `fileId` in `expandedFiles` (used by 15).
  - `graph/collapse { fileId }` → remove from `expandedFiles`.
  - `graph/details { nodeId }` → sidecar `graph/node` → post `graph/nodeDetails { node, inbound, outbound }`.
  - Keep a `nodeIndex: Map<id, Node>` of every node forwarded, so change 13 can resolve a
    node id to `path`/`startLine` without another round trip.
- **Webview, `graph.ts`** (Cytoscape wrapper): `setFiles(slice)` replaces the file layer;
  `addExpanded(fileId, slice)` adds the subtree and marks the file expanded; `collapse(fileId)`
  removes every node whose ancestor chain reaches `fileId` and their edges; `select(id)`,
  `clearSelection()`. **Edges are drawn only when both ends are present** (api.md): held
  edges whose other end is not yet loaded are kept in a pending map and materialise when it
  arrives, and dematerialise when it is removed. Placeholder (`unresolved`) nodes are added
  with the slice that references them and removed when their last referencing edge goes.
- **Glyphs** (`ui.md § Main region`): stylesheet in `styles.ts` — file: rectangle, label =
  path, expand handle `+`/`−` drawn as a second label at the right edge (click target
  distinguished by position, or a compound child element); class: rectangle with double left
  border; function: rounded rectangle; placeholder: dashed rectangle, label raw name + tag
  `unresolved`. Edges: contains thin grey; imports solid; calls solid + arrowhead; references
  dotted + arrowhead; `resolved=false` dashed. Selected: 2 px dark outline. Search-halo class
  reserved for change 14.
- **Interaction**: handle click → toggle expand (`graph/expand` or local collapse +
  `graph/collapse`); single click → `shell/selectNode` then `graph/details`; double-click or
  Enter → `shell/openNode { nodeId }` (no-op on a placeholder — the webview does not send it);
  Escape → clear selection (shell). Scroll zoom, background drag pan, node drag for the session.
- **Details region, `details.ts`**: on `graph/nodeDetails`, render Kind, Name, Location
  (`path:startLine`, omitted for placeholder), `Open in editor` button (omitted for
  placeholder; posts `shell/openNode`), then for a file node the `Expand`/`Collapse` button
  (mirrors the handle), then the **Edges** list `in · <kind>: N` / `out · <kind>: N`
  with `resolved: false` counted under `unresolved` instead of their kind, zero counts
  omitted. No selection → `Select a node to see its details`.
- **Counts**: `N nodes · M edges` of what is drawn, at the toolbar middle slot's right edge
  (`toolbar.ts` creates the slot content; change 14 adds the controls to its left).
- **Canvas states**: populated; empty (`No supported source files found` centred, R10); the
  shell's overlays cover everything else. `graph/files` with zero nodes vs. zero visible
  after filtering is distinguished in change 14 — here any zero-node slice is `empty`.
- **Tests**: vitest with Cytoscape `headless: true` over `graph.ts`: file layer, expand adds
  subtree + contains, a `calls` edge appears only once both ends are present and disappears on
  collapse, placeholder added/removed with its edge, selection class. `details.ts` rendering
  snapshot for a function, a file (Expand/Collapse label), a placeholder (no Location, no
  Open). Integration (test-electron over `fixtures/go`): after `ready`, the webview reports
  3+ file nodes and 0 function nodes; posting `graph/expand` for `config.go` yields a
  `parseConfig` node; selecting it yields Details with `in · calls: 1` once `main.go` is also
  expanded. (Expose a test-only `graph/debugState` request from the webview to assert on.)

## Design
- `.kernel/specs/features/code-graph/design/ui.md § Main region (canvas)` — glyphs, states populated/empty, behaviour; `ui/canvas.svg`, `ui/canvas.empty.svg`.
- `.kernel/specs/features/code-graph/design/ui.md § Details region additions`.
- `.kernel/specs/features/code-graph/design/api.md § 2` — webview messages `graph/files`, `graph/expanded`, `graph/nodeDetails`, `graph/empty`, `graph/expand`, `graph/collapse`, `graph/details`.
- `.kernel/specs/features/code-graph/design/data-model.md` — Node/Edge fields the webview holds.
- `.kernel/specs/features/app-shell/design/ui.md § Graph panel` — Details field order, `Open in editor`.
- `.kernel/specs/features/code-graph/scenarios.md § explore the graph` — the behaviours to reproduce (all but the two refresh scenarios, which are change 15).

## Code anchors
- `extension/package.json` — add `cytoscape` runtime dep, `@types/cytoscape` dev dep
- `extension/src/graphController.ts` — `graph/*` handlers, `expandedFiles`, `nodeIndex`, file-layer fetch on `graph/changed`/panel open
- `extension/src/panel.ts` — register `graphController` on the `MessageRouter`; forward `graph/changed` notifications
- `extension/src/protocol.ts` — TS mirrors of `GraphFiles/Expand/Node` results, `GraphChangedParams`, `-32010`, `-32011`
- `extension/webview/src/graph.ts` — Cytoscape wrapper, pending-edge map, expand/collapse, selection
- `extension/webview/src/styles.ts` — Cytoscape stylesheet (glyphs)
- `extension/webview/src/details.ts` — Details rendering + additions
- `extension/webview/src/toolbar.ts` — middle slot with the counts
- `extension/webview/src/main.ts` — route `graph/*` messages, canvas states populated/empty
- `extension/test/unit/graph.test.ts`, `extension/test/unit/details.test.ts`
- `extension/test/integration/suite/canvas.test.ts`

## Capabilities
- Modifies: `extension/shell-panel` (router registration, Details content hook)
- Creates: `extension/graph-canvas` — Cytoscape rendering of the structural graph, expand/collapse, unresolved drawing, selection and Details additions, empty state.

## Invariants / constraints
- The default view holds exactly the file nodes and imports edges from `graph/files`; no class or function node is present until its file is expanded (code-graph R1).
- Expanding a file adds its subtree and contains edges, and a `calls`/`references` edge is drawn only when both of its ends are present; collapsing removes the subtree and every edge that touched it (R2).
- An unresolved edge is dashed to a placeholder node labelled with the raw name and tagged `unresolved`; it is never dropped from what the sidecar sent (R4).
- Node kinds drawn: file, class, function, placeholder; edge kinds: contains, imports, calls, references, with the glyphs of `ui.md` (R3).
- A zero-node `graph/files` shows `No supported source files found` and draws nothing (R10).
- Selecting a node shows Kind, Name, Location and incoming/outgoing counts by kind, with unresolved edges counted as `unresolved` (R12); a placeholder shows no Location and no `Open in editor`.
- The webview never sends `shell/openNode` for a placeholder.
- Layout is automatic; positions are not saved anywhere (R11).
- `cytoscape` is the only runtime npm dependency added.

## Acceptance criteria
- [ ] vitest (headless Cytoscape) passes the cases under Tests, and `details.ts` snapshots match the three node types.
- [ ] Integration over `fixtures/go`: default view shows file nodes and imports edges only; expanding `config.go` shows `parseConfig` with a contains edge; expanding `main.go` then shows the `main → parseConfig` calls edge and the dashed `main → fetchData` placeholder; collapsing `main.go` removes `main`, the calls edge and the placeholder, and keeps `parseConfig`.
- [ ] Integration: selecting `parseConfig` fills Details with Kind `function`, Name `parseConfig`, Location `config.go:<line>`, `in · calls: 1`; selecting `config.go` shows an `Expand`/`Collapse` button that toggles exactly like the handle; selecting the `fetchData` placeholder shows Kind `unresolved`, no Location, no `Open in editor`.
- [ ] Integration over an empty folder with only `README.md`: the canvas shows `No supported source files found` and the counts read `0 nodes · 0 edges`.
- [ ] `npm run build` produces a webview bundle that includes Cytoscape and `npm test` passes.

## Plan
`/plan:change .kernel/specs/epics/code-graph/changes/12-graph-canvas.md` — plan reads this file
directly and derives the change name from it.
