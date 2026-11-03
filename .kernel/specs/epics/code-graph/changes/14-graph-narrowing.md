---
title: Graph narrowing — search, path glob, kind toggles, focus/hops, 2,000-node cap, counts
type: epic-change
epic: code-graph
status: planned
depends-on: [graph-canvas]
feature: code-graph
---

# graph-narrowing

**As a** developer, **I want** to search nodes by name, restrict the graph to a path pattern,
hide node and edge kinds, focus on a node's neighbourhood, and be told plainly when the graph
is too big to draw **so that** a large repository stays readable.

## Intent
Builds the `find a symbol` and `narrow a large graph` journeys of `code-graph` (R5, R6, R7,
R8, R9, and the filter-related half of R10). Entirely inside the webview: the toolbar's
middle-slot controls, the visible-set pipeline from `flows.md § Narrow a large graph`, the
focus state machine, and the canvas states `too large` and `filters excluded everything`.
Nothing is sent to the sidecar (api.md § 2).

## Approach
- **`state.ts`** — one narrowing state object: `search: string`, `pathGlob: string`,
  `lastValidGlob: RegExp | null`, `kinds: { file, class, function, contains, imports, calls, references }`
  (defaults all `true` except `references: false`, R5), `focus: { nodeId, hops } | null`,
  `snapshotBeforeFocus` (expansion + filters + viewport, R8), `selectedNodeId`. Change 15
  reads and re-applies this object after a refresh.
- **`filters.ts`** — pure function `computeVisible(held: {nodes, edges}, expansion, state) -> { nodes, edges, tooLarge?: number }`
  in the order of `flows.md`: path glob over file nodes (a symbol is kept iff its file is
  kept; placeholders are kept iff at least one kept edge targets them) → kind toggles
  (hiding a node kind hides every edge touching those nodes; hiding an edge kind hides
  those edges) → expansion (collapsed files hide their subtree — already true of what the
  webview holds, kept explicit for refresh) → focus (BFS over the surviving edges from the
  selected node up to `hops`, undirected) → cap: if `nodes.length > 2000` return
  `tooLarge: nodes.length` and no nodes (R9). Edges survive only when both ends survive.
  `graph.ts` applies the result by toggling a `hidden` class / `display: none` rather than
  removing elements, so positions and selection persist across filter changes.
- **`glob.ts`** — `globToRegExp(glob)`: anchored, `/`-separated, supports `**` (any depth),
  `*` (within a segment), `?`, `[...]`, `{a,b}`; throws on an unterminated `[` or `{` or a
  trailing `\`. On throw the toolbar shows `Invalid pattern: <glob>` in place of the counts
  and `lastValidGlob` stays (R7). No npm dependency.
- **`search.ts`** — on Enter: case-insensitive substring over *visible* nodes' `name`;
  matches get the `search-halo` class (reserved in 12); the viewport centres on the first
  match in document order of the visible set; inline text `N matches` or
  `No matches for '<query>'` (R6). Escape in the field clears query, halos and text.
- **Focus** (`focus.ts`): `Focus` button enabled only with a selection; click → take
  `snapshotBeforeFocus`, set `focus = { nodeId, hops: 1 }`, `Hops` stepper enabled (1–3);
  changing hops recomputes; selecting another node while focused re-centres focus on it;
  clicking `Focus` again, or Escape clearing the selection, restores the snapshot
  (expansion, filters, viewport) exactly (R8, `flows.md § Focus`).
- **`toolbar.ts`** — the middle slot, left to right per `ui.md § Toolbar controls`: `Search`
  field + match text; `Path` field (placeholder `Path filter, e.g. src/api/**`) + invalid
  text; `Kinds` button with a popover of checkboxes under **Nodes** / **Edges**; `Focus`
  button + `Hops` stepper `1 ▸ 3`; counts `N nodes · M edges` (from 12). Toolbar states:
  disabled (shell not `ready`), idle, searching, filtered, invalid glob, focused.
- **Canvas states** (`main.ts`): `too large` → centred
  `Graph too large to render (N nodes). Narrow it with a filter.`, nothing drawn, toolbar
  stays enabled (R9); visible count 0 because filters excluded everything → canvas empty,
  counts `0 nodes · 0 edges`, **no** `No supported source files found` (that message is only
  for a zero-node `graph/files`, R10); the next filter change that brings the count under the
  cap re-renders (R9).
- **Tests**: vitest over `filters.ts` (every pipeline stage, edge-both-ends rule, placeholder
  rule, cap at exactly 2,000 vs 2,001), `glob.ts` (each construct, invalid patterns), `search.ts`
  (case-insensitivity, visible-only, no-hit text), focus restore equality. Headless-Cytoscape
  tests that hidden elements keep their positions. Integration over `fixtures/go` for one
  journey each: search `parse` highlights two and centres; glob `src/[api` shows the invalid
  text and keeps the previous filter; focus on `main` with 1 hop then 2 hops; and a generated
  2,500-file temp workspace shows the too-large text and then renders after a glob matching
  300 files.

## Design
- `.kernel/specs/features/code-graph/design/ui.md § Toolbar controls` — controls, states, filter composition.
- `.kernel/specs/features/code-graph/design/ui.md § Main region` — too-large state; `ui/canvas.too-large.svg`.
- `.kernel/specs/features/code-graph/design/flows.md § Narrow a large graph` and `§ Focus`.
- `.kernel/specs/features/code-graph/scenarios.md § find a symbol` and `§ narrow a large graph` — every scenario there is this change's.

## Code anchors
- `extension/webview/src/state.ts` — narrowing state, defaults, focus snapshot
- `extension/webview/src/filters.ts` — `computeVisible` pipeline, 2,000 cap
- `extension/webview/src/glob.ts` — `globToRegExp`, `InvalidGlob`
- `extension/webview/src/search.ts` — matching, halo, centre, match text
- `extension/webview/src/focus.ts` — focus enter/recompute/restore
- `extension/webview/src/toolbar.ts` — middle-slot controls, Kinds popover, toolbar states
- `extension/webview/src/graph.ts` — `applyVisibility(result)`, `centerOn(id)`, viewport snapshot/restore (methods added; wrapper from 12)
- `extension/webview/src/main.ts` — canvas states too-large / filtered-empty
- `extension/test/unit/filters.test.ts`, `glob.test.ts`, `search.test.ts`, `focus.test.ts`
- `extension/test/integration/suite/narrowing.test.ts`

## Capabilities
- Modifies: `extension/graph-canvas` (visibility application, viewport helpers, canvas states)
- Creates: `extension/graph-narrowing` — search, path glob, kind toggles, focus and the render cap over the held graph.

## Invariants / constraints
- Defaults: node kinds file/class/function and edge kinds contains/imports/calls shown; references hidden (code-graph R5).
- Hiding a node kind hides every edge touching a node of that kind (R5).
- Search is case-insensitive substring over visible nodes only, centres on the first hit, and with no hit shows `No matches for '<query>'` (R6).
- An invalid glob shows `Invalid pattern: <glob>` and leaves the previous filter in force (R7).
- Focus shows exactly the nodes within `hops` (1–3, default 1) of the selected node over the currently visible edges; clearing focus restores expansion, filters and viewport to the pre-focus snapshot (R8).
- More than 2,000 visible nodes renders nothing and shows `Graph too large to render (N nodes). Narrow it with a filter.`; 2,000 renders (R9).
- Filters that exclude everything leave an empty canvas with `0 nodes · 0 edges` and never show `No supported source files found` (R7, R10).
- Visible = held ∩ path glob ∩ kind toggles ∩ expansion ∩ focus, in that order; an edge is visible only when both ends are (ui.md).
- No message to the sidecar from any control in this change.

## Acceptance criteria
- [ ] vitest passes the unit cases under Tests; `computeVisible` with 2,000 nodes renders and with 2,001 returns `tooLarge: 2001`.
- [ ] Integration: `fixtures/go` with `config.go` expanded — search `parse` → 2 matches highlighted, view centred on `parseConfig`; `PARSECONFIG` → 1 match; with `config.go` collapsed, `parseConfig` → `No matches for 'parseConfig'`; Escape clears.
- [ ] Integration: glob `src/[api` after a valid glob → `Invalid pattern: src/[api` and the previous filter still applied; glob `docs/**` on the Go fixture → empty canvas, `0 nodes · 0 edges`, no empty-workspace message.
- [ ] Integration: focus on `main` with 1 hop shows `main` and `parseConfig` only; hops 2 adds `readFile`; clearing focus restores the previous node set and expansion; `Focus`/`Hops` are disabled with nothing selected.
- [ ] Integration: a 2,500-file generated workspace shows the too-large message and renders 300 file nodes after glob `src/api/**`.
- [ ] Toggling `function` off removes every function node and every calls edge between functions; toggling `references` on draws a references edge between two expanded files.

## Plan
`/plan:change .kernel/specs/epics/code-graph/changes/14-graph-narrowing.md` — plan reads this file
directly and derives the change name from it.
