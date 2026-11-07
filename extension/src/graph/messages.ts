// Code-graph's extension ↔ webview postMessage contract. Types only: both bundles import this.
import type { GraphEdgeKind, GraphNodeDetail, GraphNodeKind, GraphSlice } from '../sidecar/protocol';

// Test-only seam (Shell.graph.debug): `tap` / `toggle` and the narrowing ops run the user code paths (the toolbar's
// real control handlers; `escape` is a document Escape), `click` clicks a webview button by id through its real
// listener, `key` dispatches a document keydown, `state` only reports.
export type DebugOp =
  | { op: 'state' }
  | { op: 'tap' | 'toggle' | 'click'; id: string }
  | { op: 'search' | 'path'; text: string }
  | { op: 'searchEscape' | 'focus' | 'escape' }
  | { op: 'kind'; kind: GraphNodeKind | GraphEdgeKind; on: boolean }
  | { op: 'hops'; n: number }
  | { op: 'key'; key: 'ArrowRight' | 'ArrowLeft' }
  // Tree pane: `treeToggle` clicks #btn-tree, `treeExpand` runs a row's chevron handler (node, root or folder id),
  // `treeKey` is a keydown on the focused tree row, `treeClick` / `treeDblClick` a click / double-click on a rendered row.
  | { op: 'treeToggle' }
  | { op: 'treeExpand'; id: string }
  | { op: 'treeClick' | 'treeDblClick'; id: string }
  | { op: 'treeKey'; key: TreeKey };

export type TreeKey = 'ArrowUp' | 'ArrowDown' | 'ArrowRight' | 'ArrowLeft' | 'Enter';

// The tree pane as the user sees it: #btn-tree, the visible rows (two spaces of indent per level), the focused and the
// selected row (same text format).
export interface TreeDebugState {
  shown: boolean;
  pressed: boolean;
  disabled: boolean;
  rows: string[];
  focused: string | null;
  selected: string | null;
}

// A shown trace as the strip and canvas draw it (block ids without the `flow:` prefix).
export interface FlowDebugState {
  // The strip's status text and whether Prev / Next are enabled.
  status: string;
  prev: boolean;
  next: boolean;
  hop: number;
  // The drawn container's label (the function name), null when not drawn.
  container: string | null;
  blocks: Array<{ id: string; label: string }>;
  highlighted: string[];
  current: string | null;
  hopEdge: { from: string; to: string; label: string } | null;
}

// The toolbar's narrowing state as the user sees it.
export interface NarrowingDebugState {
  matchText: string;
  pathText: string;
  // The text in #graph (empty-workspace or too-large message), '' when none.
  canvasText: string;
  halos: string[];
  centredOn: string | null;
  focusEnabled: boolean;
  hopsEnabled: boolean;
  focused: boolean;
  hops: number;
  kinds: Record<string, boolean>;
}

// What the canvas draws and Details shows, for integration tests.
export interface DebugState {
  nodes: Array<{ id: string; kind: GraphNodeKind; name: string }>;
  edges: Array<{ kind: GraphEdgeKind; fromId: string; toId: string; resolved: boolean }>;
  counts: string;
  emptyText: string;
  // Visible text lines of the Details region, shell fields included.
  details: string[];
  narrowing: NarrowingDebugState;
  // The index strip's visible text then its visible controls, '' when hidden.
  strip: string;
  // The visible #overlay text, '' when hidden.
  overlay: string;
  // The shown trace, null when none.
  flow: FlowDebugState | null;
  // Group by folder: on/off and the drawn folder boxes (label, parent box's label), sorted.
  grouped: boolean;
  folders: Array<{ label: string; parent: string | null }>;
  tree: TreeDebugState;
}

// The whole view in one message: the file layer (zero nodes = the empty state) plus every remembered expansion
// still in it, and the workspace roots (folder name, wire-path prefix) in workspace order for the tree.
export interface GraphRefresh {
  files: GraphSlice;
  expanded: Array<{ fileId: string } & GraphSlice>;
  roots: Array<{ name: string; prefix: string }>;
  // Scoped view (code-graph R13): the graph has more than `codeMatrix.graph.scopeThreshold` nodes, `total` of them.
  // Absent = full view.
  scoped?: boolean;
  total?: number;
}

export type GraphToWebview =
  | ({ type: 'graph/refresh' } & GraphRefresh)
  | ({ type: 'graph/expanded'; fileId: string } & GraphSlice)
  // The scope node's neighbourhood; no nodes = the node is gone (UnknownNode).
  | ({ type: 'graph/scoped'; nodeId: string } & GraphSlice)
  | ({ type: 'graph/nodeDetails' } & GraphNodeDetail)
  | ({ type: 'graph/debug' } & DebugOp)
  | ({ type: 'tree/fileLoaded'; fileId: string } & GraphSlice)
  | ({ type: 'tree/links' } & Required<GraphNodeDetail>)
  | { type: 'tree/loadFailed'; id: string };

export type WebviewToGraph =
  | { type: 'tree/loadFile'; fileId: string }
  | { type: 'tree/loadLinks'; nodeId: string }
  | { type: 'graph/expand'; fileId: string }
  | { type: 'graph/collapse'; fileId: string }
  | { type: 'graph/scope'; nodeId: string; hops: number }
  | { type: 'graph/details'; nodeId: string }
  | ({ type: 'graph/debugState' } & DebugState);
