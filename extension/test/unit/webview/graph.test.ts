import { beforeEach, describe, expect, it, vi } from 'vitest';
import { globToRegExp } from '../../../media/glob';
import { type FlowOverlay, folderTree, type GraphView, mountGraph } from '../../../media/graph';
import { defaultNarrowing, type NarrowingState } from '../../../media/narrowing';
import type { GraphEdge, GraphNode, GraphSlice } from '../../../src/sidecar/protocol';

const fileA: GraphNode = { id: 'A', kind: 'file', name: 'a.go', path: 'a.go' };
const fileB: GraphNode = { id: 'B', kind: 'file', name: 'b.go', path: 'b.go' };
const fmt: GraphNode = { id: 'fmt', kind: 'unresolved', name: 'fmt' };
const fa: GraphNode = { id: 'fa', kind: 'function', name: 'fa', path: 'a.go', startLine: 1, endLine: 2, parentId: 'A' };
const fb: GraphNode = { id: 'fb', kind: 'function', name: 'fb', path: 'b.go', startLine: 1, endLine: 2, parentId: 'B' };
const gone: GraphNode = { id: 'gone', kind: 'unresolved', name: 'gone' };
const edge = (id: string, kind: GraphEdge['kind'], fromId: string, toId: string, resolved = true): GraphEdge => ({
  id,
  kind,
  fromId,
  toId,
  resolved,
});

const files: GraphSlice = { nodes: [fileA, fileB, fmt], edges: [edge('i1', 'imports', 'B', 'fmt', false)] };
const expandA: GraphSlice = { nodes: [fa], edges: [edge('cA', 'contains', 'A', 'fa')] };
// B's subtree, its contains edge, its outbound call into A and an unresolved call to a placeholder.
const expandB: GraphSlice = {
  nodes: [fb, gone],
  edges: [edge('cB', 'contains', 'B', 'fb'), edge('call', 'calls', 'fb', 'fa'), edge('miss', 'calls', 'fb', 'gone', false)],
};

describe('mountGraph (headless)', () => {
  let view: GraphView;
  const post = vi.fn();
  const ids = () => view.cy.nodes().map((n) => n.id()).sort();
  const edgeIds = () => view.cy.edges().map((e) => e.id()).sort();
  const expand = (fileId: string, slice: GraphSlice) => {
    view.toggle(fileId);
    view.addExpanded(fileId, slice);
  };

  beforeEach(() => {
    post.mockClear();
    view = mountGraph(null, post);
    view.applyRefresh({ files, expanded: [] });
  });

  it('draws the file layer only, with the import placeholder dashed', () => {
    expect(ids()).toEqual(['A', 'B', 'fmt']);
    expect(edgeIds()).toEqual(['i1']);
    expect(view.cy.getElementById('i1').hasClass('unresolved')).toBe(true);
    expect(view.cy.getElementById('fmt').data('label')).toBe('fmt\nunresolved');
    expect(view.cy.getElementById('A').data('label')).toBe('a.go  +');
    expect(view.counts()).toBe('3 nodes · 1 edges');
  });

  it('toggle posts graph/expand; the reply adds the subtree with its contains edge', () => {
    view.toggle('A');
    expect(post).toHaveBeenCalledWith({ type: 'graph/expand', fileId: 'A' });
    view.addExpanded('A', expandA);
    expect(ids()).toEqual(['A', 'B', 'fa', 'fmt']);
    expect(edgeIds()).toEqual(['cA', 'i1']);
    expect(view.cy.getElementById('A').data('label')).toBe('a.go  −');
  });

  it('a calls edge across files is drawn only while both files are expanded, in either order', () => {
    expand('B', expandB);
    expect(edgeIds()).not.toContain('call');
    expand('A', expandA);
    expect(edgeIds()).toContain('call');

    view.toggle('A');
    expect(post).toHaveBeenLastCalledWith({ type: 'graph/collapse', fileId: 'A' });
    expect(ids()).not.toContain('fa');
    expect(edgeIds()).not.toContain('call');
    // Held, not dropped: re-expanding A brings it back without B re-sending it.
    expand('A', expandA);
    expect(edgeIds()).toContain('call');

    view.applyRefresh({ files, expanded: [] });
    expand('A', expandA);
    expect(edgeIds()).not.toContain('call');
    expand('B', expandB);
    expect(edgeIds()).toContain('call');
    view.toggle('B');
    expect(edgeIds()).not.toContain('call');
    expect(ids()).toContain('fa');
  });

  it('an unresolved edge keeps its placeholder; collapsing removes the orphaned one, not the import placeholder', () => {
    expand('B', expandB);
    expect(ids()).toContain('gone');
    expect(view.cy.getElementById('miss').hasClass('unresolved')).toBe(true);
    view.toggle('B');
    expect(ids()).toEqual(['A', 'B', 'fmt']);
  });

  it('a stale expand reply is ignored', () => {
    view.addExpanded('A', expandA);
    expect(ids()).not.toContain('fa');
  });

  it('select / clearSelection drive the selected class', () => {
    view.select('A');
    expect(view.cy.getElementById('A').hasClass('selected')).toBe(true);
    view.select('B');
    expect(view.cy.getElementById('A').hasClass('selected')).toBe(false);
    view.clearSelection();
    expect(view.cy.$('.selected').length).toBe(0);
  });

  it('tap selects via codeMatrixShell and asks for details', () => {
    const selectNode = vi.fn();
    (globalThis as { codeMatrixShell?: unknown }).codeMatrixShell = { selectNode, getSelectedNodeId: () => null };
    view.tap('A');
    expect(selectNode).toHaveBeenCalledWith('A');
    expect(post).toHaveBeenCalledWith({ type: 'graph/details', nodeId: 'A' });
    expect(view.cy.getElementById('A').hasClass('selected')).toBe(true);
    delete (globalThis as { codeMatrixShell?: unknown }).codeMatrixShell;
  });

  it('a refresh with the same ids re-adds every element and reruns the layout; nothing from the old payload stays', () => {
    expand('A', expandA);
    const oldA = view.cy.getElementById('A');
    oldA.position({ x: 12345, y: 6789 });
    view.applyRefresh({ files, expanded: [{ fileId: 'A', ...expandA }] });
    expect(oldA.removed()).toBe(true);
    expect(view.cy.getElementById('A').position()).not.toEqual({ x: 12345, y: 6789 });
    expect(ids()).toEqual(['A', 'B', 'fa', 'fmt']);
    expect(view.isExpanded('A')).toBe(true);
    expect(view.cy.getElementById('A').data('label')).toBe('a.go  −');

    view.applyRefresh({ files: { nodes: [fileB], edges: [] }, expanded: [] });
    expect(ids()).toEqual(['B']);
    expect(edgeIds()).toEqual([]);
    expect(view.isExpanded('A')).toBe(false);
  });

  it('zero nodes is the empty state', () => {
    view.applyRefresh({ files: { nodes: [], edges: [] }, expanded: [] });
    expect(view.state()).toEqual({ nodes: [], edges: [], counts: '0 nodes · 0 edges', emptyText: 'No supported source files found', grouped: false, folders: [] });
    expect(view.canvasText()).toBe('No supported source files found');
  });

  describe('narrowing (applyVisibility)', () => {
    const drawn = () => view.cy.nodes().not('.hidden').map((n) => n.id()).sort();
    const narrowed = (patch: Partial<NarrowingState>) => ({ ...defaultNarrowing(), ...patch });

    it('a node hidden by a filter stays in Cytoscape and keeps its position when shown again', () => {
      view.cy.getElementById('A').position({ x: 123, y: 45 });
      view.applyVisibility(narrowed({ lastValidGlob: globToRegExp('b.go') }));
      expect(drawn()).toEqual(['B', 'fmt']);
      expect(view.cy.getElementById('A').hasClass('hidden')).toBe(true);
      expect(view.counts()).toBe('2 nodes · 1 edges');
      expect(view.state().nodes.map((n) => n.id).sort()).toEqual(['B', 'fmt']);
      view.applyVisibility(defaultNarrowing());
      expect(drawn()).toEqual(['A', 'B', 'fmt']);
      expect(view.cy.getElementById('A').position()).toEqual({ x: 123, y: 45 });
    });

    it('a filter matching nothing is filtered-empty, not the empty state', () => {
      view.applyVisibility(narrowed({ lastValidGlob: globToRegExp('docs/**') }));
      expect(view.counts()).toBe('0 nodes · 0 edges');
      expect(view.canvasText()).toBe('');
    });

    it('a too-large held set adds no Cytoscape elements and shows the too-large text', () => {
      const big = Array.from({ length: 2001 }, (_, i): GraphNode => ({ id: `f${i}`, kind: 'file', name: `f${i}.go`, path: `f${i}.go` }));
      view.applyRefresh({ files: { nodes: big, edges: [] }, expanded: [] });
      expect(view.cy.elements().length).toBe(0);
      expect(view.counts()).toBe('0 nodes · 0 edges');
      expect(view.canvasText()).toBe('Graph too large to render (2001 nodes). Narrow it with a filter.');
      view.applyVisibility(narrowed({ lastValidGlob: globToRegExp('f1?.go') }));
      expect(view.cy.nodes().length).toBe(10);
      expect(view.canvasText()).toBe('');
    });

    it('a references edge between two expanded files appears only with references on', () => {
      const ref = edge('ref', 'references', 'fa', 'fb');
      expand('A', { nodes: [fa], edges: [edge('cA', 'contains', 'A', 'fa'), ref] });
      expand('B', expandB);
      expect(edgeIds()).not.toContain('ref');
      view.applyVisibility(narrowed({ kinds: { ...defaultNarrowing().kinds, references: true } }));
      expect(view.cy.getElementById('ref').hasClass('hidden')).toBe(false);
      expect(view.state().edges.some((e) => e.kind === 'references')).toBe(true);
    });

    it('centerOn / viewport / restoreViewport', () => {
      view.restoreViewport({ zoom: 2, pan: { x: 5, y: 7 } });
      expect(view.viewport()).toEqual({ zoom: 2, pan: { x: 5, y: 7 } });
      expect(() => view.centerOn('A')).not.toThrow();
    });
  });

  describe('layered layout', () => {
    const y = (id: string) => view.cy.getElementById(id).position('y');
    const x = (id: string) => view.cy.getElementById(id).position('x');
    const file = (id: string): GraphNode => ({ id, kind: 'file', name: `${id}.go`, path: `${id}.go` });

    it('places every edge source above its target', () => {
      const chain: GraphSlice = {
        nodes: [file('a'), file('b'), file('c')],
        // `a` also imports `c` directly: `c` still sits below `b`.
        edges: [edge('ab', 'imports', 'a', 'b'), edge('bc', 'imports', 'b', 'c'), edge('ac', 'imports', 'a', 'c')],
      };
      view.applyRefresh({ files: chain, expanded: [] });
      expect(y('a')).toBeLessThan(y('b'));
      expect(y('b')).toBeLessThan(y('c'));

      // File above contained function, caller above callee, referrer above placeholder.
      view.applyRefresh({ files, expanded: [{ fileId: 'A', ...expandA }, { fileId: 'B', ...expandB }] });
      expect(y('A')).toBeLessThan(y('fa'));
      expect(y('B')).toBeLessThan(y('fb'));
      expect(y('fb')).toBeLessThan(y('fa'));
      expect(y('fb')).toBeLessThan(y('gone'));
      expect(y('B')).toBeLessThan(y('fmt'));
    });

    it('orders siblings by label and lays out the same graph identically', () => {
      const fan: GraphSlice = {
        nodes: [file('r'), file('z'), file('m'), file('b')],
        edges: [edge('rz', 'imports', 'r', 'z'), edge('rm', 'imports', 'r', 'm'), edge('rb', 'imports', 'r', 'b')],
      };
      view.applyRefresh({ files: fan, expanded: [] });
      expect(x('b')).toBeLessThan(x('m'));
      expect(x('m')).toBeLessThan(x('z'));
      const before = view.cy.nodes().map((n) => ({ ...n.position() }));
      view.applyRefresh({ files: fan, expanded: [] });
      expect(view.cy.nodes().map((n) => ({ ...n.position() }))).toEqual(before);
    });

    it('lays out cycles and isolated nodes without stacking them', () => {
      const cyclic: GraphSlice = {
        nodes: [file('a'), file('b'), file('c')],
        edges: [edge('ab', 'imports', 'a', 'b'), edge('ba', 'imports', 'b', 'a')],
      };
      view.applyRefresh({ files: cyclic, expanded: [] });
      const spots = new Set(view.cy.nodes().map((n) => `${n.position('x')},${n.position('y')}`));
      expect(spots.size).toBe(3);
    });
  });

  describe('flow overlay (data-flow)', () => {
    // `fa` unfolded into entry → b1 → exit.
    const overlay: FlowOverlay = {
      functionId: 'fa',
      blocks: ['b0', 'b1', 'b2'].map((id) => ({ group: 'nodes', data: { id: `flow:${id}`, label: id }, classes: 'block' })),
      branches: [
        { group: 'edges', data: { id: 'flow-branch:0', source: 'flow:b0', target: 'flow:b1' }, classes: 'branch' },
        { group: 'edges', data: { id: 'flow-branch:1', source: 'flow:b1', target: 'flow:b2' }, classes: 'branch' },
      ],
    };
    const blocks = () => view.cy.nodes('.block').not('.hidden').map((n) => n.id()).sort();

    it('blocks are children of the function node, whose contains edge still attaches; counts include them', () => {
      expand('A', expandA);
      view.setFlow(overlay);
      expect(blocks()).toEqual(['flow:b0', 'flow:b1', 'flow:b2']);
      expect(view.cy.getElementById('flow:b1').data('parent')).toBe('fa');
      expect(view.cy.getElementById('fa').children().length).toBe(3);
      expect(view.cy.getElementById('cA').target().id()).toBe('fa');
      expect(edgeIds()).toEqual(['cA', 'flow-branch:0', 'flow-branch:1', 'i1']);
      expect(view.counts()).toBe('7 nodes · 4 edges');
      // Debug state reports graph elements only.
      expect(view.state().nodes.map((n) => n.id).sort()).toEqual(['A', 'B', 'fa', 'fmt']);
      expect(view.visibleNodes().map((n) => n.id).sort()).toEqual(['A', 'B', 'fa', 'fmt']);
    });

    it('is not drawn without its function node, survives a refresh with it, and goes and comes back with collapse / expand', () => {
      view.setFlow(overlay);
      expect(blocks()).toEqual([]);
      expand('A', expandA);
      expect(blocks()).toHaveLength(3);
      view.applyRefresh({ files, expanded: [{ fileId: 'A', ...expandA }] });
      expect(blocks()).toHaveLength(3);
      view.toggle('A');
      expect(view.cy.nodes('.block').length).toBe(0);
      expand('A', expandA);
      expect(blocks()).toHaveLength(3);
      view.applyRefresh({ files, expanded: [] });
      expect(view.cy.nodes('.block').length).toBe(0);
      view.setFlow(undefined);
      expand('A', expandA);
      expect(view.cy.nodes('.block').length).toBe(0);
      expect(view.cy.getElementById('fa').isParent()).toBe(false);
    });

    it('stays drawn under a glob and kind toggles that exclude it', () => {
      expand('A', expandA);
      view.setFlow(overlay);
      view.applyVisibility({ ...defaultNarrowing(), lastValidGlob: globToRegExp('b.go'), kinds: { ...defaultNarrowing().kinds, function: false } });
      expect(view.cy.getElementById('fa').hasClass('hidden')).toBe(false);
      expect(blocks()).toHaveLength(3);
    });

    it('markFlow restyles and moves the hop arrow without adding a node or running the layout', () => {
      expand('A', expandA);
      view.setFlow(overlay);
      const layout = vi.spyOn(view.cy, 'layout');
      const nodeCount = view.cy.nodes().length;
      view.markFlow({ trace: ['flow:b0', 'flow:b1'], current: 'flow:b1', hop: { from: 'flow:b0', to: 'flow:b1', label: 'x' } });
      view.markFlow({ trace: ['flow:b0', 'flow:b1'], current: 'flow:b1', hop: { from: 'flow:b1', to: 'flow:b1', label: 'x' } });
      expect(layout).not.toHaveBeenCalled();
      expect(view.cy.nodes().length).toBe(nodeCount);
      expect(view.cy.$('.trace').map((n) => n.id()).sort()).toEqual(['flow:b0', 'flow:b1']);
      expect(view.cy.$('.current').map((n) => n.id())).toEqual(['flow:b1']);
      const hop = view.cy.edges('.hop');
      expect(hop.length).toBe(1);
      expect([hop.data('source'), hop.data('target'), hop.data('label')]).toEqual(['flow:b1', 'flow:b1', 'x']);
      // The hop arrow is not counted.
      expect(view.counts()).toBe('7 nodes · 4 edges');
      view.markFlow({ trace: [], current: null, hop: null });
      expect(view.cy.edges('.hop').length).toBe(0);
      // A selection sync keeps the marks and does not re-run the layout.
      view.markFlow({ trace: ['flow:b0'], current: 'flow:b0', hop: { from: 'flow:b0', to: 'flow:b1', label: 'x' } });
      view.select('A');
      expect(layout).not.toHaveBeenCalled();
      expect(view.cy.$('.current').map((n) => n.id())).toEqual(['flow:b0']);
      expect(view.cy.edges('.hop').length).toBe(1);
    });

    it('a tap or double-tap on a block posts nothing; fileByPath finds the held file', () => {
      expand('A', expandA);
      view.setFlow(overlay);
      post.mockClear();
      view.cy.getElementById('flow:b1').emit('tap');
      view.cy.getElementById('flow:b1').emit('dbltap');
      expect(post).not.toHaveBeenCalled();
      expect(view.fileByPath('a.go')).toBe('A');
      expect(view.fileByPath('nope.go')).toBeUndefined();
    });

    it('a refresh re-adding a traced function that calls out lays out without throwing (retrace, R14)', () => {
      // fb is a compound parent (its blocks) and the source of calls edges: breadthfirst gives parents no depth.
      const onB = { ...overlay, functionId: 'fb' };
      view.applyRefresh({ files, expanded: [{ fileId: 'A', ...expandA }, { fileId: 'B', ...expandB }] });
      view.setFlow(onB);
      expect(() => view.applyRefresh({ files, expanded: [{ fileId: 'A', ...expandA }, { fileId: 'B', ...expandB }] })).not.toThrow();
      expect(view.cy.getElementById('fb').children().length).toBe(3);
    });

    it('lays the blocks out along their branch edges, entry on top', () => {
      expand('A', expandA);
      view.setFlow(overlay);
      const y = (id: string) => view.cy.getElementById(id).position('y');
      expect(y('flow:b0')).toBeLessThan(y('flow:b1'));
      expect(y('flow:b1')).toBeLessThan(y('flow:b2'));
    });
  });

  describe('group by folder', () => {
    // The Go fixture's shape: root files, broken/, internal/db/ (internal has no file of its own).
    const main: GraphNode = { id: 'M', kind: 'file', name: 'main.go', path: 'main.go' };
    const broken: GraphNode = { id: 'K', kind: 'file', name: 'broken/broken.go', path: 'broken/broken.go' };
    const conn: GraphNode = { id: 'C', kind: 'file', name: 'internal/db/conn.go', path: 'internal/db/conn.go' };
    const open: GraphNode = { id: 'open', kind: 'function', name: 'open', path: 'internal/db/conn.go', startLine: 1, endLine: 2, parentId: 'C' };
    const layer: GraphSlice = { nodes: [main, broken, conn, fmt], edges: [edge('i1', 'imports', 'M', 'C'), edge('i2', 'imports', 'C', 'fmt', false)] };
    const expandC: GraphSlice = { nodes: [open], edges: [edge('cC', 'contains', 'C', 'open')] };
    const parent = (id: string) => view.cy.getElementById(id).data('parent');

    beforeEach(() => view.applyRefresh({ files: layer, expanded: [] }));

    it('folderTree: a box per directory with a file or 2+ subdirectories, single-child chains merged', () => {
      const go = folderTree(['main.go', 'broken/broken.go', 'internal/db/conn.go']);
      expect([...go.folders]).toEqual([
        ['folder:broken', { label: 'broken', parent: undefined }],
        ['folder:internal/db', { label: 'internal/db', parent: undefined }],
      ]);
      expect([go.folderOf('main.go'), go.folderOf('internal/db/conn.go')]).toEqual([undefined, 'folder:internal/db']);
      const java = folderTree(['src/main/java/a/X.java', 'src/main/java/b/Y.java']);
      expect([...java.folders]).toEqual([
        ['folder:src/main/java', { label: 'src/main/java', parent: undefined }],
        ['folder:src/main/java/a', { label: 'a', parent: 'folder:src/main/java' }],
        ['folder:src/main/java/b', { label: 'b', parent: 'folder:src/main/java' }],
      ]);
      // Multi-root: each root's `<basename>/` prefix is the outer box.
      const roots = folderTree(['api/x.go', 'api/h/y.go', 'web/z.ts']);
      expect([...roots.folders.entries()].map(([id, f]) => [id, f.label, f.parent])).toEqual([
        ['folder:api', 'api', undefined],
        ['folder:api/h', 'h', 'folder:api'],
        ['folder:web', 'web', undefined],
      ]);
    });

    it('off by default; on parents files and symbols by folder, placeholders and root files stay out', () => {
      expect(view.isGrouped()).toBe(false);
      expect(view.cy.nodes('.folder').length).toBe(0);
      view.setGrouped(true);
      expand('C', expandC);
      expect([parent('M'), parent('K'), parent('C'), parent('open'), parent('fmt')]).toEqual([
        undefined,
        'folder:broken',
        'folder:internal/db',
        'folder:internal/db',
        undefined,
      ]);
      expect(view.state().folders).toEqual([
        { label: 'broken', parent: null },
        { label: 'internal/db', parent: null },
      ]);
      view.setGrouped(false);
      expect(view.cy.nodes('.folder').length).toBe(0);
      expect(parent('C')).toBeUndefined();
      expect(view.state()).toMatchObject({ grouped: false, folders: [] });
    });

    it('folders never count, search or select; a repeat setGrouped does nothing', () => {
      const before = view.counts();
      const nodesBefore = view.state().nodes;
      view.setGrouped(true);
      expect(view.counts()).toBe(before);
      expect(view.state().nodes).toEqual(nodesBefore);
      expect(view.visibleNodes().map((n) => n.id).sort()).toEqual(['C', 'K', 'M', 'fmt']);
      post.mockClear();
      view.cy.getElementById('folder:broken').emit('tap');
      view.cy.getElementById('folder:broken').emit('dbltap');
      expect(post).not.toHaveBeenCalled();
      const layout = vi.spyOn(Object.getPrototypeOf(view.cy.elements()), 'layout');
      view.setGrouped(true);
      expect(layout).not.toHaveBeenCalled();
      layout.mockRestore();
    });

    it('a box is drawn only while something inside it is', () => {
      view.setGrouped(true);
      view.applyVisibility({ ...defaultNarrowing(), lastValidGlob: globToRegExp('internal/**') });
      expect(view.state().folders.map((f) => f.label)).toEqual(['internal/db']);
      view.applyVisibility({ ...defaultNarrowing(), kinds: { ...defaultNarrowing().kinds, file: false } });
      expect(view.state().folders).toEqual([]);
    });

    it('lays out with cose grouped and breadthfirst ungrouped, once per toggle', () => {
      const layout = vi.spyOn(Object.getPrototypeOf(view.cy.elements()), 'layout');
      view.setGrouped(true);
      view.setGrouped(false);
      expect(layout.mock.calls.map(([o]) => (o as { name: string }).name)).toEqual(['cose', 'breadthfirst']);
      layout.mockRestore();
    });

    it('survives refresh, expansion, collapse and a flow overlay inside a folder', () => {
      view.setGrouped(true);
      view.applyRefresh({ files: layer, expanded: [{ fileId: 'C', ...expandC }] });
      expect(view.isGrouped()).toBe(true);
      expect(parent('open')).toBe('folder:internal/db');
      view.setFlow({ functionId: 'open', blocks: [{ group: 'nodes', data: { id: 'flow:b0', label: 'b0' }, classes: 'block' }], branches: [] });
      expect(parent('flow:b0')).toBe('open');
      view.toggle('C');
      expect(view.isGrouped()).toBe(true);
      expect(parent('C')).toBe('folder:internal/db');
    });
  });
});
