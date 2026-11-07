import cytoscape, { type Collection, type Core, type ElementDefinition, type EventObject, type NodeSingular } from 'cytoscape';
import type { DebugState, GraphRefresh, WebviewToGraph } from '../src/graph/messages';
import type { WebviewToShell } from '../src/panel/messages';
import type { GraphEdge, GraphNode, GraphSlice } from '../src/sidecar/protocol';
import { computeVisible, type Visible } from './filters';
import { graphStyle } from './graphStyle';
import { defaultNarrowing, type NarrowingState, type Viewport } from './narrowing';

// Width of a file node's +/− handle zone, in model units.
const HANDLE_PX = 16;
const EMPTY_TEXT = 'No supported source files found';
const tooLargeText = (n: number) => `Graph too large to render (${n} nodes). Narrow it with a filter.`;
const scopePromptText = (n: number) => `Large graph (${n} nodes). Select a node in the tree to show its graph.`;

// The shell's selection seam (media/main.ts).
interface CodeMatrixShell {
  selectNode(id: string | null): void;
  getSelectedNodeId(): string | null;
}

// The flow overlay's structure (media/flow.ts builds it): block nodes, drawn inside `functionId` as its children,
// and branch edges between them.
export interface FlowOverlay {
  functionId: string;
  blocks: ElementDefinition[];
  branches: ElementDefinition[];
}

// The overlay's marks: element ids of highlighted blocks, the current block, and the hop arrow (from = to: a loop).
export interface FlowMarks {
  trace: string[];
  current: string | null;
  hop: { from: string; to: string; label: string } | null;
}

export const HOP_EDGE = 'flow-hop';
const NO_MARKS: FlowMarks = { trace: [], current: null, hop: null };

export interface GraphView {
  readonly cy: Core;
  // Swaps in a whole view (file layer + expansions) in one batch; zero file nodes is the empty state. The selection
  // survives iff its node is in the payload. `roots` is the tree's, not the canvas's.
  applyRefresh(payload: Omit<GraphRefresh, 'roots'>): void;
  addExpanded(fileId: string, slice: GraphSlice): void;
  // Scoped view (code-graph R13–R18): the selection is the scope node; its neighbourhood arrives here.
  addScoped(nodeId: string, slice: GraphSlice): void;
  isScoped(): boolean;
  collapse(fileId: string): void;
  isExpanded(fileId: string): boolean;
  isPlaceholder(id: string): boolean;
  select(id: string): void;
  clearSelection(): void;
  // User actions; the debug seam runs these same paths.
  tap(id: string): void;
  toggle(fileId: string): void;
  // Narrowing (09): what is shown is computeVisible(held, state); the rest is hidden, never removed.
  applyVisibility(state: NarrowingState): void;
  visibleNodes(): GraphNode[];
  expandedFiles(): Set<string>;
  centerOn(id: string): void;
  viewport(): Viewport;
  restoreViewport(v: Viewport): void;
  // The text shown in #graph: the empty-workspace or too-large message, else ''.
  canvasText(): string;
  counts(): string;
  state(): Omit<DebugState, 'details' | 'narrowing' | 'strip' | 'overlay' | 'flow' | 'tree'>;
  // Data-flow: the overlay is drawn (and pinned) only while its function node is held; it survives refresh,
  // expansion and collapse until replaced. `markFlow` restyles and moves the hop arrow only: no sync, no layout.
  setFlow(overlay: FlowOverlay | undefined): void;
  markFlow(marks: FlowMarks): void;
  // The held file node with this wire path.
  fileByPath(path: string): string | undefined;
  // Group by folder: file and symbol nodes drawn inside nested folder boxes, laid out by `cose`. Changing it redraws.
  setGrouped(on: boolean): void;
  isGrouped(): boolean;
}

// The canvas. Model = every node and edge received since the last file layer; Cytoscape draws the narrowing
// pipeline's visible set of it — an edge only while both ends are drawn, the rest held until its missing end arrives.
export function mountGraph(
  container: HTMLElement | null,
  post: (message: WebviewToGraph | WebviewToShell) => void,
  onChange: () => void = () => undefined,
): GraphView {
  const nodes = new Map<string, GraphNode>();
  const edges = new Map<string, GraphEdge>();
  const expanded = new Set<string>();
  let selected: string | null = null;
  let empty = false;
  let narrowing = defaultNarrowing();
  let visible: Visible = { nodes: new Set(), edges: new Set() };
  let overlay: FlowOverlay | undefined;
  let marks = NO_MARKS;
  let grouped = false;
  let scoped = false;
  let total = 0;
  // The last graph/scope asked for (`nodeId|hops`): a sync asks again only when the scope or its depth changed.
  let scopeAsked: string | undefined;

  let graphEl: HTMLElement | null = null;
  let emptyEl: HTMLElement | null = null;
  if (container) {
    graphEl = document.createElement('div');
    graphEl.id = 'graph';
    emptyEl = document.createElement('p');
    emptyEl.id = 'graph-empty';
    emptyEl.hidden = true;
    graphEl.append(emptyEl);
    container.append(graphEl);
  }
  const css = container ? getComputedStyle(document.body) : undefined;
  const cy = cytoscape(
    graphEl && css
      ? { container: graphEl, style: graphStyle((name) => css.getPropertyValue(name).trim()) }
      : { headless: true, styleEnabled: false },
  );

  const label = (n: GraphNode) => {
    if (n.kind === 'file') return `${n.name}  ${expanded.has(n.id) ? '−' : '+'}`;
    if (n.kind === 'unresolved') return `${n.name}\nunresolved`;
    return n.name;
  };
  const drawable = (e: GraphEdge) => nodes.has(e.fromId) && nodes.has(e.toId);

  // Brings Cytoscape in line with the model's visible set: an element is added once first visible, then only
  // toggles `hidden`. Reruns the layout (over non-hidden elements) when anything was added or removed. `reset`
  // drops every element first, inside the same batch, so nothing from the previous graph survives.
  const sync = ({ reset = false } = {}) => {
    // The overlay is drawn only inside its held function node; its ids are pinned past every filter.
    const flow = overlay && nodes.has(overlay.functionId) ? overlay : undefined;
    const pinned = new Set(flow ? [flow.functionId, ...flow.blocks.map((b) => b.data.id!)] : []);
    const scope = scoped ? { nodeId: selected, hops: narrowing.scopeHops } : undefined;
    visible = computeVisible({ nodes: nodes.values(), edges: edges.values() }, narrowing, pinned, scope);
    const ask = selected !== null && scope ? `${selected}|${scope.hops}` : undefined;
    if (ask !== undefined && ask !== scopeAsked) post({ type: 'graph/scope', nodeId: selected!, hops: scope!.hops });
    scopeAsked = ask;
    const flowEdges = new Set(
      flow?.branches.filter((b) => visible.nodes.has(b.data.source!) && visible.nodes.has(b.data.target!)).map((b) => b.data.id!),
    );
    // Folders come from the held file paths, so filters only show or hide a box, never re-parent a node; a box is
    // shown iff some node inside it is.
    const tree = grouped ? folderTree([...nodes.values()].flatMap((n) => (n.kind === 'file' && n.path !== undefined ? [n.path] : []))) : undefined;
    const parentOf = (n: GraphNode) => (tree && n.path !== undefined ? tree.folderOf(n.path) : undefined);
    const shownFolders = new Set<string>();
    for (const id of visible.nodes) {
      const n = nodes.get(id);
      for (let f = n && parentOf(n); f !== undefined; f = tree!.folders.get(f)!.parent) shownFolders.add(f);
    }
    const shown = (id: string) => visible.nodes.has(id) || visible.edges.has(id) || flowEdges.has(id) || shownFolders.has(id);
    const want = new Map<string, ElementDefinition>();
    for (const [id, f] of tree?.folders ?? []) want.set(id, { group: 'nodes', data: { id, label: f.label, parent: f.parent }, classes: 'folder' });
    for (const n of nodes.values()) {
      want.set(n.id, { group: 'nodes', data: { id: n.id, label: label(n), parent: parentOf(n) }, classes: n.kind });
    }
    for (const e of edges.values()) {
      if (!drawable(e)) continue;
      const classes = e.resolved ? e.kind : `${e.kind} unresolved`;
      want.set(e.id, { group: 'edges', data: { id: e.id, source: e.fromId, target: e.toId }, classes });
    }
    for (const b of flow?.blocks ?? []) want.set(b.data.id!, { ...b, data: { ...b.data, parent: flow!.functionId } });
    for (const b of flow?.branches ?? []) want.set(b.data.id!, b);
    let changed = reset;
    cy.batch(() => {
      // The hop arrow is markFlow's: it never makes a sync re-run the layout.
      const gone = reset ? cy.elements() : cy.elements().filter((el) => !want.has(el.id()) && el.id() !== HOP_EDGE);
      if (gone.nonempty()) changed = true;
      gone.remove();
      const add = [...want.values()].filter((d) => shown(d.data.id!) && cy.getElementById(d.data.id!).empty());
      if (add.length) changed = true;
      cy.add(add);
      cy.elements().forEach((el) => {
        el.toggleClass('hidden', el.id() !== HOP_EDGE && !shown(el.id()));
      });
      for (const n of nodes.values()) if (n.kind === 'file') cy.getElementById(n.id).data('label', label(n));
      cy.$('.selected').removeClass('selected');
      if (selected !== null) cy.getElementById(selected).addClass('selected');
      applyMarks();
    });
    // Layered along edge direction (source above target); `maximal` pushes a node below all its incomers, and
    // same-depth nodes go left to right by label. breadthfirst ignores compound boxes, so grouped runs `cose`.
    if (changed && grouped) cy.elements().not('.hidden').layout({ name: 'cose', animate: false }).run();
    else if (changed) {
      // breadthfirst ranks only childless nodes, yet `maximal` reads the rank of every incomer: a compound parent (an
      // unfolded function) must stay out, along with its edges. It is sized by its children.
      const leaves = cy.nodes(':childless').not('.hidden');
      const drawn = leaves.union(leaves.edgesWith(leaves).not('.hidden'));
      drawn
        .layout({
          name: 'breadthfirst',
          directed: true,
          maximal: true,
          animate: false,
          roots: layerRoots(drawn),
          depthSort: byLabel,
        } as cytoscape.BreadthFirstLayoutOptions)
        .run();
    }
    if (emptyEl) {
      emptyEl.textContent = view.canvasText();
      emptyEl.hidden = emptyEl.textContent === '';
    }
    onChange();
  };

  // Restyles the drawn blocks and adds, moves or removes the single hop arrow (drawn iff both ends are).
  const applyMarks = () => {
    const trace = new Set(marks.trace);
    cy.nodes('.block').forEach((n) => {
      n.toggleClass('trace', trace.has(n.id()));
      n.toggleClass('current', n.id() === marks.current);
    });
    const hop = cy.getElementById(HOP_EDGE);
    const h = marks.hop;
    const drawn = (id: string) => cy.getElementById(id).nonempty() && !cy.getElementById(id).hasClass('hidden');
    if (!h || !drawn(h.from) || !drawn(h.to)) hop.remove();
    else if (hop.empty()) cy.add({ group: 'edges', data: { id: HOP_EDGE, source: h.from, target: h.to, label: h.label }, classes: 'hop' });
    else hop.move({ source: h.from, target: h.to }).data('label', h.label);
  };

  const subtreeOf = (fileId: string) => {
    const inside = (n: GraphNode): boolean => {
      for (let p = n.parentId; p !== undefined; p = nodes.get(p)?.parentId) if (p === fileId) return true;
      return false;
    };
    return [...nodes.values()].filter(inside).map((n) => n.id);
  };

  const view: GraphView = {
    cy,
    applyRefresh({ files, expanded: slices, scoped: s = false, total: t = 0 }) {
      nodes.clear();
      edges.clear();
      expanded.clear();
      for (const slice of [files, ...slices]) {
        for (const n of slice.nodes) nodes.set(n.id, n);
        for (const e of slice.edges) edges.set(e.id, e);
      }
      for (const s of slices) expanded.add(s.fileId);
      empty = files.nodes.length === 0;
      scoped = s;
      total = t;
      // Held neighbourhoods went with the old graph: a surviving scope node is fetched again (R18).
      scopeAsked = undefined;
      const sel = shell()?.getSelectedNodeId() ?? selected;
      selected = sel !== null && nodes.has(sel) ? sel : null;
      sync({ reset: true });
      // A surviving selection gets current Details counts; a removed one is cleared through the shell, which also
      // leaves focus (09's leaveFocus path).
      if (selected !== null) post({ type: 'graph/details', nodeId: selected });
      else if (sel !== null) shell()?.selectNode(null);
    },
    addExpanded(fileId, slice) {
      // A reply for a file the current layer no longer has (or that was collapsed meanwhile) is stale.
      if (!nodes.has(fileId) || !expanded.has(fileId)) return;
      for (const n of slice.nodes) nodes.set(n.id, n);
      for (const e of slice.edges) edges.set(e.id, e);
      sync();
    },
    addScoped(nodeId, slice) {
      // A reply for a node no longer the scope is stale; an empty one means the node is gone.
      if (!scoped || nodeId !== selected) return;
      if (slice.nodes.length === 0) return shell()?.selectNode(null);
      for (const n of slice.nodes) nodes.set(n.id, n);
      for (const e of slice.edges) edges.set(e.id, e);
      sync();
    },
    isScoped: () => scoped,
    collapse(fileId) {
      expanded.delete(fileId);
      for (const id of subtreeOf(fileId)) nodes.delete(id);
      // Edges stay held (an edge into this file only comes back with its source's expand); placeholders
      // left with no drawn edge go.
      for (const n of [...nodes.values()]) {
        if (n.kind !== 'unresolved') continue;
        const used = [...edges.values()].some((e) => (e.toId === n.id || e.fromId === n.id) && drawable(e));
        if (!used) nodes.delete(n.id);
      }
      sync();
    },
    isExpanded: (fileId) => expanded.has(fileId),
    isPlaceholder: (id) => nodes.get(id)?.kind === 'unresolved',
    select(id) {
      selected = id;
      sync();
    },
    clearSelection() {
      selected = null;
      sync();
    },
    tap(id) {
      shell()?.selectNode(id);
      view.select(id);
      post({ type: 'graph/details', nodeId: id });
    },
    toggle(fileId) {
      if (nodes.get(fileId)?.kind !== 'file') return;
      if (expanded.has(fileId)) {
        view.collapse(fileId);
        post({ type: 'graph/collapse', fileId });
      } else {
        // Marked now so the handle flips at once; the reply fills it in.
        expanded.add(fileId);
        sync();
        post({ type: 'graph/expand', fileId });
      }
    },
    applyVisibility(state) {
      narrowing = state;
      sync();
    },
    // Graph nodes only: search never matches a block.
    visibleNodes: () => [...visible.nodes].flatMap((id) => nodes.get(id) ?? []),
    expandedFiles: () => new Set(expanded),
    centerOn(id) {
      cy.center(cy.getElementById(id));
    },
    viewport: () => ({ zoom: cy.zoom(), pan: { ...cy.pan() } }),
    restoreViewport(v) {
      cy.viewport({ zoom: v.zoom, pan: { ...v.pan } });
    },
    canvasText: () => {
      if (empty) return EMPTY_TEXT;
      if (scoped && selected === null) return scopePromptText(total);
      return visible.tooLarge !== undefined ? tooLargeText(visible.tooLarge) : '';
    },
    // Drawn = in Cytoscape without `hidden` (headless runs unstyled, so `:visible` can't be trusted).
    // Blocks and branch edges count; the hop arrow does not.
    // Folder boxes are decoration, never counted.
    counts: () => `${cy.nodes().not('.hidden').not('.folder').length} nodes · ${cy.edges().not('.hidden').not('.hop').length} edges`,
    state: () => ({
      nodes: cy
        .nodes()
        .not('.hidden')
        .map((n) => nodes.get(n.id()))
        .flatMap((g) => (g ? [{ id: g.id, kind: g.kind, name: g.name }] : [])),
      edges: cy
        .edges()
        .not('.hidden')
        .map((e) => edges.get(e.id()))
        .flatMap((g) => (g ? [{ kind: g.kind, fromId: g.fromId, toId: g.toId, resolved: g.resolved }] : [])),
      counts: view.counts(),
      emptyText: empty ? EMPTY_TEXT : '',
      grouped,
      folders: cy
        .nodes('.folder')
        .not('.hidden')
        .map((f: NodeSingular) => ({ label: String(f.data('label')), parent: f.isChild() ? String(f.parent().first().data('label')) : null }))
        .sort((a, b) => a.label.localeCompare(b.label) || String(a.parent).localeCompare(String(b.parent))),
    }),
    setFlow(next) {
      overlay = next;
      // A new overlay's marks follow with markFlow.
      marks = NO_MARKS;
      sync();
    },
    markFlow(next) {
      marks = next;
      cy.batch(applyMarks);
    },
    fileByPath: (path) => [...nodes.values()].find((n) => n.kind === 'file' && n.path === path)?.id,
    setGrouped(on) {
      if (on === grouped) return;
      grouped = on;
      // Cytoscape can't re-parent in place: redraw everything.
      sync({ reset: true });
    },
    isGrouped: () => grouped,
  };

  const inHandle = (n: NodeSingular, x: number) => n.hasClass('file') && x >= n.position('x') + n.width() / 2 - HANDLE_PX;
  // A block or folder is not a graph node: tapping one does nothing.
  cy.on('tap', 'node', (e: EventObject) => {
    const n = e.target as NodeSingular;
    if (n.hasClass('block') || n.hasClass('folder')) return;
    if (inHandle(n, e.position.x)) view.toggle(n.id());
    else view.tap(n.id());
  });
  cy.on('dbltap', 'node', (e: EventObject) => {
    const n = e.target as NodeSingular;
    if (!n.hasClass('block') && !n.hasClass('folder') && !view.isPlaceholder(n.id())) post({ type: 'shell/openNode', nodeId: n.id() });
  });

  sync();
  return view;
}

// Every drawn component's in-degree-0 leaf nodes, or its lowest-label one when it is all cycle: breadthfirst must
// reach every node (an unreached one crashes `maximal`).
const layerRoots = (drawn: Collection): string[] =>
  drawn.components().flatMap((comp) => {
    const leaves = comp.nodes().filter((n) => n.isChildless()).toArray() as NodeSingular[];
    const tops = leaves.filter((n) => n.incomers('node').intersection(drawn).empty());
    return (tops.length ? tops : leaves.sort(byLabel).slice(0, 1)).map((n) => n.id());
  });

// breadthfirst's depth rows hold nulls where `maximal` moved a node down (spliced out after sorting): sort them last.
const byLabel = (a: NodeSingular | null, b: NodeSingular | null) => {
  if (!a || !b) return a ? -1 : b ? 1 : 0;
  return String(a.data('label')).localeCompare(String(b.data('label'))) || (a.id() < b.id() ? -1 : 1);
};

interface Folder {
  label: string;
  parent: string | undefined;
}

// The folder boxes for these file wire paths: a box per directory holding a file or 2+ subdirectories; any other
// directory merges into its single child, so the box is labelled with the joined segments below its parent box
// (`internal/db`). Root files have no folder. `folders` lists parents before children.
export function folderTree(paths: string[]): { folders: Map<string, Folder>; folderOf(path: string): string | undefined } {
  const dirOf = (p: string) => p.slice(0, Math.max(p.lastIndexOf('/'), 0));
  const hasFile = new Set<string>();
  const children = new Map<string, Set<string>>();
  for (const p of paths) {
    hasFile.add(dirOf(p));
    for (let d = dirOf(p); d !== ''; d = dirOf(d)) {
      if (!children.has(dirOf(d))) children.set(dirOf(d), new Set());
      children.get(dirOf(d))!.add(d);
    }
  }
  const kept = (d: string) => d !== '' && (hasFile.has(d) || (children.get(d)?.size ?? 0) >= 2);
  // Nearest kept directory at or above `d`, '' for none.
  const keptAt = (d: string): string => (d === '' || kept(d) ? d : keptAt(dirOf(d)));
  const id = (d: string) => (d === '' ? undefined : `folder:${d}`);
  const folders = new Map<string, Folder>();
  for (const d of [...new Set([...hasFile, ...children.keys()])].filter(kept).sort()) {
    const up = keptAt(dirOf(d));
    folders.set(id(d)!, { label: up === '' ? d : d.slice(up.length + 1), parent: id(up) });
  }
  return { folders, folderOf: (p) => id(keptAt(dirOf(p))) };
}

const shell = () => (globalThis as unknown as { codeMatrixShell?: CodeMatrixShell }).codeMatrixShell;
