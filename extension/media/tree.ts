import type { GraphRefresh, TreeDebugState, TreeKey, WebviewToGraph } from '../src/graph/messages';
import type { WebviewToShell } from '../src/panel/messages';
import type { GraphEdge, GraphNode, GraphNodeDetail, GraphSlice } from '../src/sidecar/protocol';
import { kindCounts } from './graphDetails';

// The node tree pane (node-tree ui.md § Tree pane): roots → folders → files → symbols, then `Unresolved (N)`.
// Fed only data (the file layer and the slices it holds), never the canvas, so narrowing can't touch it (R5).
export interface TreeView {
  applyRefresh(refresh: GraphRefresh): void;
  addSlice(fileId: string, slice: GraphSlice): void;
  // A `tree/links` reply: the node's edges and their far ends, drawn as its edge groups (R7).
  addLinks(detail: Required<GraphNodeDetail>): void;
  loadFailed(id: string): void;
  setShown(on: boolean): void;
  isShown(): boolean;
  // The pane's part of TreeDebugState; #btn-tree's pressed / disabled are main.ts's.
  state(): Pick<TreeDebugState, 'shown' | 'rows' | 'focused' | 'selected'>;
  // A selection made outside the tree (R10): while shown, expands the node's ancestors, selects its row and scrolls it
  // into view; hidden, null or not held clears the tree's selection. Never posts tree/loadFile.
  reveal(id: string | null): void;
  // The row's chevron handler: expands or collapses the node, root or folder id.
  expand(id: string): void;
  // A keydown on the focused row (on the list when none is focused).
  key(key: TreeKey): void;
  // A click / double-click on the rendered row (no-op when not rendered).
  click(id: string): void;
  dblClick(id: string): void;
}

// `children` undefined: a file whose slice is not held yet, so it may have children. `node`: the backing graph node
// (file, class, function, placeholder); absent for root, folder, `Unresolved (N)` and edge-group rows. `location`: set
// only on a linked-node row (a leaf under an edge group).
interface Item {
  id: string;
  label: string;
  marker: string;
  depth: number;
  parent: Item | undefined;
  children: Item[] | undefined;
  node?: GraphNode;
  location?: string;
}

type Links = Pick<GraphNodeDetail, 'inbound' | 'outbound'> & { linked: GraphNode[] };

const MARKERS: Partial<Record<GraphNode['kind'], string>> = { class: '[class]', function: '[fn]', unresolved: '[?]' };
const ARROWS = new Set<string>(['ArrowUp', 'ArrowDown', 'ArrowRight', 'ArrowLeft']);
const NO_FILES = 'No supported source files found';
const byLabel = (a: Item, b: Item) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' });
const text = (it: Item) => [it.marker, it.label].filter(Boolean).join(' ') + (it.location === undefined ? '' : `  ${it.location}`);
const markerOf = (n: GraphNode) => (n.kind === 'file' ? '[file]' : (MARKERS[n.kind] ?? ''));
const locationOf = (n: GraphNode) => (n.kind === 'unresolved' ? 'unresolved' : n.kind === 'file' ? (n.path ?? '') : `${n.path}:${n.startLine}`);
// The edge groups under a node row, in display order (R7): row-id suffix, label, edge direction, edge kind.
const GROUPS = [
  ['imports', 'Imports', 'outbound', 'imports'],
  ['importedBy', 'Imported by', 'inbound', 'imports'],
  ['calls', 'Calls', 'outbound', 'calls'],
  ['calledBy', 'Called by', 'inbound', 'calls'],
  ['references', 'References', 'outbound', 'references'],
  ['referencedBy', 'Referenced by', 'inbound', 'references'],
] as const;
const isLinkedRow = (it: Item) => it.location !== undefined;

// `select(node, fileId)`: a node row was clicked; `fileId` is its file's id (the node's own for a file row), undefined
// for a placeholder.
export function mountTree(
  container: HTMLElement,
  { post, select }: { post: (m: WebviewToGraph | WebviewToShell) => void; select: (node: GraphNode, fileId: string | undefined) => void },
): TreeView {
  const header = document.createElement('div');
  header.id = 'tree-header';
  header.textContent = 'NODES';
  const list = document.createElement('div');
  list.id = 'tree-list';
  list.setAttribute('role', 'tree');
  container.replaceChildren(header, list);

  let refresh: GraphRefresh | undefined;
  let slices = new Map<string, GraphSlice>();
  // A node's links by node id, and the node ids whose tree/loadLinks is unanswered.
  let links = new Map<string, Links>();
  const pendingLinks = new Set<string>();
  let expanded = new Set<string>();
  let focused: string | null = null;
  let selected: string | null = null;
  let items = new Map<string, Item>();
  let top: Item[] = [];
  // What render() drew: the focusable rows in order, their elements, and every row's debug text.
  let order: Item[] = [];
  let rowEls = new Map<string, HTMLElement>();
  let rowTexts: string[] = [];

  // `unloaded`: a file without a held slice (children unknown).
  const make = (id: string, label: string, marker: string, parent: Item | undefined, node?: GraphNode, unloaded = false) => {
    const it: Item = { id, label, marker, depth: parent ? parent.depth + 1 : 0, parent, children: unloaded ? undefined : [], node };
    items.set(id, it);
    parent?.children?.push(it);
    return it;
  };

  // A file's symbols by parentId, each level in source order; a method drops its class's `Class.` prefix.
  const addSymbols = (file: Item, slice: GraphSlice) => {
    file.children = [];
    const byParent = new Map<string, GraphNode[]>();
    for (const n of slice.nodes) {
      if (n.kind === 'unresolved' || n.parentId === undefined) continue;
      byParent.set(n.parentId, [...(byParent.get(n.parentId) ?? []), n]);
    }
    const add = (parent: Item) => {
      const kids = (byParent.get(parent.id) ?? []).sort((a, b) => (a.startLine ?? 0) - (b.startLine ?? 0));
      for (const n of kids) {
        const own = parent.marker === '[class]' && n.name.startsWith(`${parent.label}.`) ? n.name.slice(parent.label.length + 1) : n.name;
        add(make(n.id, own, MARKERS[n.kind] ?? '', parent, n));
      }
    };
    add(file);
  };

  const build = () => {
    items = new Map();
    top = [];
    if (!refresh) return;
    const roots = refresh.roots.map((r) => ({ prefix: r.prefix, item: make(`root:${r.prefix}`, r.name, '[root]', undefined) }));
    top = roots.map((r) => r.item);
    const placeholders = new Map<string, GraphNode>();
    const sources = [refresh.files.nodes];
    for (const f of refresh.files.nodes) {
      if (f.kind !== 'file' || f.path === undefined) continue;
      const path = f.path;
      const root = roots.find((r) => path.startsWith(r.prefix));
      if (!root) continue;
      // One folder row per directory on the file's path, labelled with its own segment.
      const segments = path.slice(root.prefix.length).split('/');
      let parent = root.item;
      for (let i = 0; i < segments.length - 1; i++) {
        const id = `dir:${root.prefix}${segments.slice(0, i + 1).join('/')}`;
        parent = items.get(id) ?? make(id, segments[i], '[dir]', parent);
      }
      const file = make(f.id, segments.at(-1)!, '[file]', parent, f, true);
      const slice = slices.get(f.id);
      if (slice) {
        addSymbols(file, slice);
        sources.push(slice.nodes);
      }
    }
    for (const n of sources.flat()) if (n.kind === 'unresolved') placeholders.set(n.id, n);
    // Subfolders before files, each by name case-insensitively (R4).
    for (const it of items.values()) {
      if (it.marker === '[root]' || it.marker === '[dir]') {
        it.children!.sort((a, b) => Number(a.marker !== '[dir]') - Number(b.marker !== '[dir]') || byLabel(a, b));
      }
    }
    // Placeholders come from the file layer and slices only: a linked one never adds to the group (R3).
    if (placeholders.size > 0) {
      const group = make('group:unresolved', `Unresolved (${placeholders.size})`, '', undefined);
      for (const n of placeholders.values()) make(n.id, n.name, '[?]', group, n);
      group.children!.sort(byLabel);
      top.push(group);
    }
    for (const it of [...items.values()]) if (it.node && links.has(it.node.id)) addGroups(it, links.get(it.node.id)!);
  };

  // After the node's symbols, its non-empty edge groups; each lists the distinct far ends, by label (R7).
  const addGroups = (owner: Item, { inbound, outbound, linked }: Links) => {
    const byId = new Map(linked.map((n) => [n.id, n]));
    for (const [key, label, dir, kind] of GROUPS) {
      const ends = new Map<string, GraphNode>();
      for (const e of dir === 'outbound' ? outbound : inbound) {
        const end = e.kind === kind && byId.get(dir === 'outbound' ? e.toId : e.fromId);
        if (end) ends.set(end.id, end);
      }
      if (ends.size === 0) continue;
      const group = make(`links:${owner.id}:${key}`, `${label} (${ends.size})`, '', owner);
      for (const n of ends.values()) make(`link:${owner.id}:${key}:${n.id}`, n.name, markerOf(n), group, n).location = locationOf(n);
      group.children!.sort(byLabel);
    }
  };

  // A node row keeps its chevron until its symbols (file) and links are known; linked rows are leaves (R7, R15).
  const isNodeRow = (it: Item) => it.node !== undefined && !isLinkedRow(it);
  const expandable = (it: Item) =>
    !isLinkedRow(it) && (it.children === undefined || it.children.length > 0 || (isNodeRow(it) && !links.has(it.node!.id)));

  // Asks once for a node's links unless they are held or already asked for.
  const wantLinks = (nodeId: string) => {
    if (links.has(nodeId) || pendingLinks.has(nodeId)) return;
    pendingLinks.add(nodeId);
    post({ type: 'tree/loadLinks', nodeId });
  };

  // Kind, Name, Location, then In / Out counts without `contains` (R6).
  const tooltip = (n: GraphNode) => {
    const held = links.get(n.id);
    const counts = (edges: GraphEdge[]) =>
      kindCounts(edges.filter((e) => e.kind !== 'contains'))
        .map(([kind, c]) => `${kind} ${c}`)
        .join(' · ');
    const lines: Array<[string, string]> = [
      ['Kind', n.kind],
      ['Name', n.name],
      ['Location', n.kind === 'unresolved' ? '' : locationOf(n)],
      ['In', held ? counts(held.inbound) : 'Loading…'],
      ['Out', held ? counts(held.outbound) : 'Loading…'],
    ];
    return lines
      .filter(([, v]) => v !== '')
      .map(([k, v]) => k.padEnd(10) + v)
      .join('\n');
  };

  const render = () => {
    order = [];
    rowEls = new Map();
    rowTexts = [];
    const rows: HTMLElement[] = [];
    const wanted: string[] = [];
    if (refresh && refresh.files.nodes.length === 0) {
      const p = document.createElement('p');
      p.id = 'tree-message';
      p.textContent = NO_FILES;
      list.replaceChildren(p);
      rowTexts = [NO_FILES];
      return;
    }
    const indent = (depth: number) => '  '.repeat(depth);
    const walk = (it: Item) => {
      const row = document.createElement('div');
      row.className = 'tree-row';
      row.setAttribute('role', 'treeitem');
      row.dataset.treeId = it.id;
      row.style.paddingLeft = `${it.depth * 16}px`;
      const open = expanded.has(it.id);
      const chevron = document.createElement('span');
      chevron.className = 'tree-chevron';
      if (expandable(it)) {
        row.setAttribute('aria-expanded', String(open));
        chevron.textContent = open ? '▾' : '▸';
        chevron.addEventListener('click', (e) => {
          e.stopPropagation();
          toggle(it.id);
        });
      }
      const marker = document.createElement('span');
      marker.className = 'tree-marker';
      marker.textContent = it.marker;
      const label = document.createElement('span');
      label.className = 'tree-label';
      label.textContent = it.label;
      row.append(chevron, marker, label);
      if (it.location !== undefined) {
        const location = document.createElement('span');
        location.className = 'tree-location';
        location.textContent = it.location;
        row.append(location);
      }
      if (it.node) {
        const node = it.node;
        row.title = tooltip(node);
        row.addEventListener('mouseenter', () => wantLinks(node.id));
      }
      if (it.id === selected) {
        row.classList.add('selected');
        row.setAttribute('aria-selected', 'true');
      }
      row.addEventListener('click', () => {
        if (!it.node) return moveTo(it);
        selected = it.id;
        moveTo(it);
        select(it.node, isLinkedRow(it) ? fileByPath(it.node) : fileOf(it));
      });
      row.addEventListener('dblclick', () => openSource(it));
      rows.push(row);
      order.push(it);
      rowEls.set(it.id, row);
      rowTexts.push(indent(it.depth) + text(it));
      if (!open) return;
      it.children?.forEach(walk);
      const linksUnknown = isNodeRow(it) && !links.has(it.node!.id);
      if (linksUnknown) wanted.push(it.node!.id);
      if (it.children === undefined || linksUnknown) {
        const loading = document.createElement('div');
        loading.className = 'tree-row loading';
        loading.style.paddingLeft = `${(it.depth + 1) * 16 + 16}px`;
        loading.textContent = 'Loading…';
        rows.push(loading);
        rowTexts.push(`${indent(it.depth + 1)}Loading…`);
      }
    };
    top.forEach(walk);
    // Roving tabindex: the focused row, else the first, is the pane's one tab stop.
    const stop = (focused !== null && rowEls.get(focused)) || rows[0];
    for (const row of rows) if (row.dataset.treeId !== undefined) row.tabIndex = row === stop ? 0 : -1;
    // Rows are rebuilt on every change: keep keyboard focus in the pane if it was there.
    const hadFocus = list.contains(document.activeElement);
    list.replaceChildren(...rows);
    if (hadFocus) stop?.focus();
    // Every expanded node row asks for its links: chevron, Right, reveal's ancestors and a refresh alike.
    wanted.forEach(wantLinks);
  };

  const moveTo = (it: Item | undefined) => {
    if (!it) return;
    focused = it.id;
    render();
    rowEls.get(it.id)?.focus();
  };

  // Tree only: never posts graph/expand or graph/collapse (R8). A file with no held slice asks for one.
  const toggle = (id: string) => {
    const it = items.get(id);
    if (!it || !expandable(it)) return;
    if (expanded.has(id)) expanded.delete(id);
    else {
      expanded.add(id);
      if (it.children === undefined) post({ type: 'tree/loadFile', fileId: id });
    }
    render();
  };

  // A linked node's file: the held file node with its wire path (itself for a file); undefined for a placeholder.
  const fileByPath = (n: GraphNode): string | undefined =>
    n.kind === 'file' ? n.id : n.kind === 'unresolved' ? undefined : refresh?.files.nodes.find((f) => f.kind === 'file' && f.path === n.path)?.id;

  // The nearest file ancestor-or-self; undefined under `Unresolved (N)`.
  const fileOf = (it: Item | undefined): string | undefined => (!it ? undefined : it.marker === '[file]' ? it.id : fileOf(it.parent));

  // Opens source as the canvas's double-click does; placeholders and non-node rows have none (R11).
  const openSource = (it: Item | undefined) => {
    if (it?.node && it.node.kind !== 'unresolved') post({ type: 'shell/openNode', nodeId: it.node.id });
  };

  const onKey = (key: string) => {
    const i = focused === null ? -1 : order.findIndex((it) => it.id === focused);
    const cur = order[i];
    if (key === 'Enter') return openSource(cur);
    if (key === 'ArrowDown') return moveTo(order[Math.min(i + 1, order.length - 1)]);
    if (key === 'ArrowUp') return moveTo(order[Math.max(i - 1, 0)]);
    if (!cur) return moveTo(order[0]);
    const open = expanded.has(cur.id);
    if (key === 'ArrowRight') {
      if (!expandable(cur)) return;
      if (!open) toggle(cur.id);
      else moveTo(cur.children?.[0]);
    } else if (expandable(cur) && open) toggle(cur.id);
    else moveTo(cur.parent);
  };

  // Handled keys stay in the pane: arrows never step a shown trace, Enter never opens the shell's selection instead.
  list.addEventListener('keydown', (e) => {
    if (!ARROWS.has(e.key) && e.key !== 'Enter') return;
    e.stopPropagation();
    e.preventDefault();
    onKey(e.key);
  });

  // A selection whose node is gone after a rebuild is dropped (R12).
  const dropGone = () => {
    if (selected !== null && !items.has(selected)) selected = null;
  };
  const textOf = (id: string | null) => (id === null ? null : (items.get(id) && text(items.get(id)!)) || null);

  return {
    applyRefresh(next) {
      const before = new Set(items.keys());
      const carried = new Map(next.expanded.map((s) => [s.fileId, s]));
      const fileIds = new Set(next.files.nodes.map((n) => n.id));
      // A still-expanded file keeps its previous symbols until its new slice arrives (ui.md § refreshing).
      const kept = new Map<string, GraphSlice>();
      for (const id of fileIds) {
        const slice = carried.get(id) ?? (expanded.has(id) ? slices.get(id) : undefined);
        if (slice) kept.set(id, slice);
      }
      slices = kept;
      refresh = next;
      // Links of rows still expanded stay drawn until their re-posted tree/loadLinks is answered; the rest go (R12).
      links = new Map([...links].filter(([id]) => expanded.has(id)));
      pendingLinks.clear();
      build();
      expanded = new Set([...expanded].filter((id) => items.has(id)));
      links = new Map([...links].filter(([id]) => items.has(id)));
      for (const id of links.keys()) {
        pendingLinks.add(id);
        post({ type: 'tree/loadLinks', nodeId: id });
      }
      for (const it of top) if (it.marker === '[root]' && !before.has(it.id)) expanded.add(it.id);
      if (focused !== null && !items.has(focused)) focused = null;
      dropGone();
      for (const id of expanded) if (fileIds.has(id) && !carried.has(id)) post({ type: 'tree/loadFile', fileId: id });
      render();
    },
    addSlice(fileId, slice) {
      slices.set(fileId, slice);
      build();
      dropGone();
      render();
    },
    addLinks({ node, inbound, outbound, linked }) {
      links.set(node.id, { inbound, outbound, linked });
      pendingLinks.delete(node.id);
      build();
      dropGone();
      render();
    },
    loadFailed(id) {
      expanded.delete(id);
      pendingLinks.delete(id);
      render();
    },
    setShown(on) {
      container.hidden = !on;
    },
    isShown: () => !container.hidden,
    state: () => ({
      shown: !container.hidden,
      rows: [...rowTexts],
      focused: textOf(focused),
      selected: textOf(selected),
    }),
    reveal(id) {
      // Already the selected row, or the node of the selected linked row: a linked-row click's own echo (R9, R10).
      if (id !== null && selected !== null && (id === selected || items.get(selected)?.node?.id === id)) return;
      const it = id === null ? undefined : items.get(id);
      if (container.hidden || !it) {
        if (selected === null) return;
        selected = null;
        return render();
      }
      for (let p = it.parent; p; p = p.parent) expanded.add(p.id);
      selected = focused = it.id;
      render();
      // jsdom has no scrollIntoView.
      rowEls.get(it.id)?.scrollIntoView?.({ block: 'nearest' });
    },
    expand: toggle,
    key(key) {
      const target = (focused !== null && rowEls.get(focused)) || list;
      target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
    },
    click: (id) => rowEls.get(id)?.click(),
    dblClick: (id) => void rowEls.get(id)?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })),
  };
}
