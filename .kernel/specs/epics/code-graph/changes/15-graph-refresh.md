---
title: Graph refresh — re-fetch on graph/changed, re-apply expansion, filters, focus and selection
type: epic-change
epic: code-graph
status: planned
depends-on: [graph-narrowing]
feature: code-graph
---

# graph-refresh

**As a** developer, **I want** the graph to update after the workspace is re-indexed without
losing what I had expanded, filtered, focused and selected **so that** a refresh never throws
away my place in the graph.

## Intent
Builds code-graph R11 and the two refresh scenarios of `explore the graph`: on `graph/changed`
the extension re-fetches the file layer and re-expands the files it remembers, the webview
swaps the graph in while keeping the old one visible until the new one is ready, and then
re-applies expansion, narrowing state, focus and selection to the nodes that still exist,
dropping the ones in `removedNodeIds`. In this epic the only re-index trigger is a sidecar
(re)start (`Restart Server`, a silent restart, `Retry`); the watcher-driven re-index from the
`workspace-index` epic will fire the same notification and need nothing more here.

## Approach
- **Extension host, `graphController.ts`**: on `graph/changed { removedNodeIds }` (change 12
  already fetches `graph/files` here) → also fetch `graph/expand` for every id in
  `expandedFiles` that is not in `removedNodeIds` (in parallel), drop the removed ones from
  `expandedFiles`, and post one `graph/refresh { files, expanded: [{fileId, nodes, edges}], removedNodeIds }`
  message instead of the individual `graph/files` / `graph/expanded` messages, so the webview
  can swap atomically. Rebuild `nodeIndex` from the new payload. The first run after start
  carries no expanded files and an empty `removedNodeIds`, so it degenerates to the
  change-12 path — keep one code path (`graph/refresh`) and retire the separate initial
  `graph/files` post.
- **Webview, `main.ts` + `graph.ts`**: `applyRefresh(payload)`: keep the current elements on
  screen (state `refreshing`, no separate drawing) while building the new element set; then
  replace in one batch; expansion marks come from `payload.expanded`; `state.ts` narrowing
  state is reused unchanged (filters are by name/kind/glob, so they carry over); selection:
  keep `selectedNodeId` if present in the new set, else clear it and show
  `Select a node to see its details`; focus: keep if `focus.nodeId` survives, else clear
  focus *and* restore the pre-focus snapshot minus removed ids; search halos recomputed
  over the new visible set; viewport kept; positions of surviving nodes are **not** kept
  (layout is automatic, R11) — run the layout once after the swap. Re-request
  `graph/details` for the surviving selection so counts are current.
- **Ids make this work**: the sidecar's stable ids (change 02) mean the same file/symbol
  has the same id after re-index; this change relies on that and asserts it end to end.
- **Tests**: vitest over `applyRefresh` with hand-built payloads: expanded file survives →
  still expanded; selected node removed → selection cleared; focused node removed → focus
  cleared and snapshot restored; references toggle on stays on; a search query re-applies.
  Integration over a temp copy of `fixtures/go`: expand `config.go`, select `parseConfig`,
  turn references on, run `codeMatrix.restartServer` (triggers a full run) → after `ready`,
  `config.go` is still expanded, `parseConfig` still selected, references still on; then
  delete `config.go` on disk, restart again → `config.go` and `parseConfig` gone, nothing
  selected, Details shows the placeholder text.

## Design
- `.kernel/specs/features/code-graph/design/api.md § 1 — Notifications` (`graph/changed` contract: re-fetch, re-expand, drop removed selection/focus).
- `.kernel/specs/features/code-graph/design/ui.md § Main region — refreshing` state.
- `.kernel/specs/features/code-graph/design/flows.md § Narrow a large graph` — "A refresh after re-indexing keeps it (R11)".
- `.kernel/specs/features/code-graph/scenarios.md` — "refresh after re-index keeps the view state", "refresh after a selected node was deleted".

## Code anchors
- `extension/src/graphController.ts` — `graph/changed` → re-fetch files + remembered expansions → `graph/refresh`
- `extension/src/protocol.ts` — `GraphRefresh` webview message type
- `extension/webview/src/main.ts` — `graph/refresh` handling, `refreshing` state
- `extension/webview/src/graph.ts` — `applyRefresh`, batch swap, layout rerun
- `extension/webview/src/state.ts` — survive/clear rules for selection and focus
- `extension/webview/src/focus.ts` — restore snapshot minus removed ids
- `extension/test/unit/refresh.test.ts`
- `extension/test/integration/suite/refresh.test.ts`

## Capabilities
- Modifies: `extension/graph-canvas` (refresh swap, `graph/refresh` replaces the initial `graph/files` post); `extension/graph-narrowing` (focus/selection survival rules)
- Creates: none — refresh is a behaviour of the canvas capability, recorded as an invariant there.

## Invariants / constraints
- After a refresh, every expanded file, the selection, the focus and every filter are kept for nodes that still exist; a node in `removedNodeIds` is dropped from expansion, selection and focus (code-graph R11, api.md).
- The previous graph stays visible until the new one replaces it; there is no blank or loading frame (ui.md refreshing state).
- Positions are recomputed by the automatic layout; nothing about positions is persisted (R11).
- With the selection removed, the Details region shows `Select a node to see its details`.
- One `graph/refresh` message carries the whole new view; the webview never sees a half-applied refresh.
- The extension re-expands only files it recorded through `graph/expand` and not collapsed through `graph/collapse`.

## Acceptance criteria
- [ ] vitest passes the five `applyRefresh` cases under Tests.
- [ ] Integration: after `codeMatrix.restartServer` on `fixtures/go`, `config.go` is still expanded, `parseConfig` still selected with current counts, and the references toggle still on; node ids before and after are identical.
- [ ] Integration: deleting `config.go` then restarting removes `config.go` and `parseConfig`, clears the selection, and Details shows the placeholder text; the `main → parseConfig` edge is now an unresolved placeholder edge (because the sidecar re-resolved it).
- [ ] Integration: a focus on `main` with 1 hop survives a restart; a focus on a node that was deleted is cleared and the pre-focus view is restored.
- [ ] The first graph after a cold start still renders (the `graph/refresh` path replaces the initial `graph/files` post without regression in change 12's tests).

## Plan
`/plan:change .kernel/specs/epics/code-graph/changes/15-graph-refresh.md` — plan reads this file
directly and derives the change name from it.
