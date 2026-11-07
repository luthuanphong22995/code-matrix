// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import type { DebugOp, DebugState, GraphRefresh, GraphToWebview } from '../../../src/graph/messages';
import { getHtml } from '../../../src/panel/graphPanel';
import type { GraphEdge, GraphNode, GraphSlice } from '../../../src/sidecar/protocol';
import { mountTree, type TreeView } from '../../../media/tree';
import { Uri } from '../mocks/vscode';

vi.mock('cytoscape', async (original) => (await import('../fakes/headlessCytoscape')).headlessCytoscape(original));

const file = (id: string, path: string): GraphNode => ({ id, kind: 'file', name: path, path });
const fn = (id: string, name: string, parentId: string, startLine: number, kind: GraphNode['kind'] = 'function'): GraphNode => ({
  id,
  kind,
  name,
  path: 'x',
  startLine,
  endLine: startLine + 1,
  parentId,
});
const placeholder = (id: string, name: string): GraphNode => ({ id, kind: 'unresolved', name });
const roots = [{ name: 'proj', prefix: '' }];
const refreshOf = (nodes: GraphNode[], expanded: GraphRefresh['expanded'] = [], r = roots): GraphRefresh => ({
  files: { nodes, edges: [] },
  expanded,
  roots: r,
});

const main = file('m', 'main.go');
const conn = file('c', 'internal/db/conn.go');
const layer = refreshOf([main, conn, placeholder('u', 'fmt')]);
// main.go: Server (class, line 10) ⊃ Server.Run (12); main (3).
const mainSlice: GraphSlice = {
  nodes: [fn('srv', 'Server', 'm', 10, 'class'), fn('run', 'Server.Run', 'srv', 12), fn('mf', 'main', 'm', 3), placeholder('u2', 'fetchData')],
  edges: [],
};
const edge = (kind: GraphEdge['kind'], fromId: string, toId: string, resolved = true): GraphEdge => ({ id: `${kind}:${fromId}:${toId}`, kind, fromId, toId, resolved });
const linksOf = (node: GraphNode, inbound: GraphEdge[] = [], outbound: GraphEdge[] = [], linked: GraphNode[] = []) => ({ node, inbound, outbound, linked });

describe('tree pane', () => {
  let container: HTMLElement;
  let tree: TreeView;
  const post = vi.fn();
  const select = vi.fn();
  const rows = () => tree.state().rows;
  const loads = () => post.mock.calls.map(([m]) => m).filter((m) => m.type === 'tree/loadFile');

  beforeEach(() => {
    post.mockClear();
    select.mockClear();
    document.body.innerHTML = '<div id="tree"></div>';
    container = document.getElementById('tree')!;
    tree = mountTree(container, { post, select });
  });

  it('before any refresh shows only the NODES header (R13)', () => {
    expect(container.textContent).toBe('NODES');
    expect(rows()).toEqual([]);
  });

  it('a zero-node file layer shows No supported source files found and no rows (R13)', () => {
    tree.applyRefresh(refreshOf([]));
    expect(rows()).toEqual(['No supported source files found']);
    expect(container.querySelectorAll('.tree-row')).toHaveLength(0);
  });

  it('roots start expanded one level; folders before files, case-insensitively; Unresolved (N) last (R2–R4)', () => {
    tree.applyRefresh(refreshOf([file('z', 'zeta.ts'), file('a', 'Alpha.ts'), file('u', 'util/x.ts'), file('M', 'Models/y.ts')]));
    expect(rows()).toEqual(['[root] proj', '  [dir] Models', '  [dir] util', '  [file] Alpha.ts', '  [file] zeta.ts']);
  });

  it('only directories on a file path get rows, each with its own segment', () => {
    tree.applyRefresh(layer);
    tree.expand('dir:internal');
    tree.expand('dir:internal/db');
    expect(rows()).toEqual(['[root] proj', '  [dir] internal', '    [dir] db', '      [file] conn.go', '  [file] main.go', 'Unresolved (1)']);
  });

  it('one top row per root, in order, files matched by prefix', () => {
    const two = [
      { name: 'api', prefix: 'api/' },
      { name: 'web', prefix: 'web/' },
    ];
    tree.applyRefresh(refreshOf([file('w', 'web/index.ts'), file('a', 'api/main.go')], [], two));
    expect(rows()).toEqual(['[root] api', '  [file] main.go', '[root] web', '  [file] index.ts']);
  });

  it('Unresolved (N) is present only when N > 0 and lists raw names', () => {
    tree.applyRefresh(refreshOf([main]));
    expect(rows().some((r) => r.startsWith('Unresolved'))).toBe(false);
    tree.applyRefresh(layer);
    tree.expand('group:unresolved');
    expect(rows().slice(-2)).toEqual(['Unresolved (1)', '  [?] fmt']);
  });

  it('expanding an unloaded file shows one Loading… and posts tree/loadFile and tree/loadLinks, never graph/expand (R8)', () => {
    tree.applyRefresh(layer);
    tree.expand('m');
    expect(rows().filter((r) => r.includes('Loading…'))).toEqual(['    Loading…']);
    expect(post.mock.calls.map(([m]) => m)).toEqual([
      { type: 'tree/loadFile', fileId: 'm' },
      { type: 'tree/loadLinks', nodeId: 'm' },
    ]);
    // Symbols arrived, links not yet: a trailing Loading… after them.
    tree.addSlice('m', mainSlice);
    expect(rows().slice(-2)).toEqual(['    Loading…', 'Unresolved (2)']);
  });

  it('the slice replaces Loading… in place: symbols in source order, methods under their class; placeholders join Unresolved', () => {
    tree.applyRefresh(layer);
    tree.expand('m');
    tree.addSlice('m', mainSlice);
    tree.addLinks(linksOf(main));
    tree.expand('srv');
    tree.addLinks(linksOf(mainSlice.nodes[0]));
    expect(rows()).toEqual([
      '[root] proj',
      '  [dir] internal',
      '  [file] main.go',
      '    [fn] main',
      '    [class] Server',
      '      [fn] Run',
      'Unresolved (2)',
    ]);
  });

  it('tree/loadFailed removes the Loading… row', () => {
    tree.applyRefresh(layer);
    tree.expand('m');
    tree.loadFailed('m');
    expect(rows().some((r) => r.includes('Loading…'))).toBe(false);
  });

  it('a slice the canvas already sent is never requested again', () => {
    tree.applyRefresh(refreshOf(layer.files.nodes, [{ fileId: 'm', ...mainSlice }]));
    tree.expand('m');
    expect(loads()).toEqual([]);
    expect(rows()).toContain('    [fn] main');
  });

  it('refresh keeps expansion of survivors, drops removed rows, re-requests expanded files it was not given (R12)', () => {
    tree.applyRefresh(layer);
    tree.expand('dir:internal');
    tree.expand('m');
    tree.addSlice('m', mainSlice);
    post.mockClear();
    tree.applyRefresh(refreshOf([main, file('c2', 'internal/other.go')]));
    expect(loads()).toEqual([{ type: 'tree/loadFile', fileId: 'm' }]);
    // The previous symbols stay drawn until the new slice arrives.
    expect(rows()).toEqual([
      '[root] proj',
      '  [dir] internal',
      '    [file] other.go',
      '  [file] main.go',
      '    [fn] main',
      '    [class] Server',
      '    Loading…',
      'Unresolved (1)',
    ]);
  });

  it('a symbol keeps its chevron until its links are known; with no symbols and no groups it has none; no data-node-id (R7)', () => {
    tree.applyRefresh(layer);
    tree.expand('m');
    tree.addSlice('m', mainSlice);
    const chevron = () => container.querySelector('[data-tree-id="mf"] .tree-chevron')!.textContent;
    expect(chevron()).toBe('▸');
    tree.addLinks(linksOf(mainSlice.nodes[2], [edge('contains', 'm', 'mf')]));
    expect(chevron()).toBe('');
    expect(container.querySelector('[data-node-id]')).toBeNull();
  });

  describe('keyboard (R15)', () => {
    beforeEach(() => {
      tree.applyRefresh(layer);
      tree.expand('m');
      tree.addSlice('m', mainSlice);
    });
    const focused = () => tree.state().focused;

    it('Down / Up move through visible rows', () => {
      tree.key('ArrowDown');
      expect(focused()).toBe('[root] proj');
      tree.key('ArrowDown');
      tree.key('ArrowDown');
      expect(focused()).toBe('[file] main.go');
      tree.key('ArrowUp');
      expect(focused()).toBe('[dir] internal');
      expect(document.activeElement?.textContent).toContain('internal');
    });

    it('Right expands a collapsed row (focus stays), then moves to its first child', () => {
      tree.key('ArrowDown');
      tree.key('ArrowDown');
      tree.key('ArrowRight');
      expect(focused()).toBe('[dir] internal');
      expect(rows()).toContain('    [dir] db');
      tree.key('ArrowRight');
      expect(focused()).toBe('[dir] db');
    });

    it('Left collapses an expanded row (focus stays); on a collapsed row moves to the parent without collapsing', () => {
      for (let i = 0; i < 3; i++) tree.key('ArrowDown');
      expect(focused()).toBe('[file] main.go');
      tree.key('ArrowLeft');
      expect(focused()).toBe('[file] main.go');
      expect(rows()).not.toContain('    [fn] main');
      tree.key('ArrowLeft');
      expect(focused()).toBe('[root] proj');
      expect(rows()).toContain('  [file] main.go');
    });

    it('a leaf: Right does nothing, Left moves to the parent', () => {
      tree.addLinks(linksOf(mainSlice.nodes[2]));
      for (let i = 0; i < 4; i++) tree.key('ArrowDown');
      expect(focused()).toBe('[fn] main');
      tree.key('ArrowRight');
      expect(focused()).toBe('[fn] main');
      tree.key('ArrowLeft');
      expect(focused()).toBe('[file] main.go');
    });

    it('handled arrows never reach document (a shown trace is not stepped)', () => {
      const reached = vi.fn();
      document.addEventListener('keydown', reached);
      tree.key('ArrowDown');
      tree.key('ArrowRight');
      document.removeEventListener('keydown', reached);
      expect(reached).not.toHaveBeenCalled();
    });

    it('refresh keeps focus on a surviving row', () => {
      tree.key('ArrowDown');
      tree.applyRefresh(layer);
      expect(focused()).toBe('[root] proj');
    });
  });

  describe('selection and open (R9–R12)', () => {
    beforeEach(() => {
      tree.applyRefresh(layer);
      tree.expand('m');
      tree.addSlice('m', mainSlice);
      tree.expand('group:unresolved');
      post.mockClear();
    });
    const selected = () => tree.state().selected;
    const row = (id: string) => container.querySelector<HTMLElement>(`[data-tree-id="${id}"]`)!;

    it('a click on a node row selects it and calls select once with the node and its file', () => {
      tree.click('mf');
      expect(selected()).toBe('[fn] main');
      expect(tree.state().focused).toBe('[fn] main');
      expect(row('mf').getAttribute('aria-selected')).toBe('true');
      expect(row('mf').classList.contains('selected')).toBe(true);
      expect(select.mock.calls).toEqual([[mainSlice.nodes[2], 'm']]);
      tree.click('u');
      expect(select.mock.calls[1]).toEqual([placeholder('u', 'fmt'), undefined]);
    });

    it('a click on a root, folder or Unresolved row only moves focus', () => {
      for (const id of ['root:', 'dir:internal', 'group:unresolved']) tree.click(id);
      expect(tree.state().focused).toBe('Unresolved (2)');
      expect(selected()).toBeNull();
      expect(select).not.toHaveBeenCalled();
    });

    it('reveal expands root → folder → file, selects and focuses the row; never posts tree/loadFile', () => {
      tree.addSlice('c', { nodes: [fn('open', 'Open', 'c', 4)], edges: [] });
      tree.reveal('open');
      expect(rows()).toContain('        [fn] Open');
      expect(selected()).toBe('[fn] Open');
      expect(tree.state().focused).toBe('[fn] Open');
      expect(loads()).toEqual([]);
      // The expanded ancestor file asks for its links.
      expect(post.mock.calls.map(([m]) => m)).toEqual([{ type: 'tree/loadLinks', nodeId: 'c' }]);
    });

    it('reveal of the selected id does not re-render; hidden, unknown or null clears the selection', () => {
      tree.click('mf');
      const before = row('mf');
      tree.reveal('mf');
      expect(row('mf')).toBe(before);
      tree.reveal('nope');
      expect(selected()).toBeNull();
      tree.reveal('mf');
      tree.reveal(null);
      expect(selected()).toBeNull();
      tree.setShown(false);
      tree.reveal('mf');
      expect(selected()).toBeNull();
    });

    it('double-click and Enter post shell/openNode for a node, nothing for a placeholder; Enter never reaches document', () => {
      const reached = vi.fn();
      document.addEventListener('keydown', reached);
      tree.dblClick('mf');
      tree.expand('srv');
      tree.click('run');
      tree.key('Enter');
      tree.dblClick('u');
      tree.click('u');
      tree.key('Enter');
      document.removeEventListener('keydown', reached);
      expect(post.mock.calls.map(([m]) => m).filter((m) => m.type === 'shell/openNode')).toEqual([
        { type: 'shell/openNode', nodeId: 'mf' },
        { type: 'shell/openNode', nodeId: 'run' },
      ]);
      expect(reached).not.toHaveBeenCalled();
    });

    it('a refresh without the selected node drops the selection; with it keeps it', () => {
      tree.click('m');
      tree.applyRefresh(layer);
      expect(selected()).toBe('[file] main.go');
      tree.applyRefresh(refreshOf([conn]));
      expect(selected()).toBeNull();
    });
  });

  describe('edge groups, links and tooltips (R6, R7, R9, R11, R12)', () => {
    const cart = file('k', 'src/cart/Cart.ts');
    const add: GraphNode = { id: 'add', kind: 'function', name: 'add', path: 'src/cart/Cart.ts', startLine: 12, endLine: 20, parentId: 'k' };
    const debounce = placeholder('u3', 'lodash.debounce');
    const [srv, , mf] = mainSlice.nodes;
    const mfLinks = linksOf(
      mf,
      [edge('contains', 'm', 'mf'), edge('calls', 'mf', 'mf')],
      [edge('calls', 'mf', 'add'), { ...edge('calls', 'mf', 'add'), id: 'dup' }, edge('calls', 'mf', 'u3', false), edge('calls', 'mf', 'mf'), edge('references', 'mf', 'srv')],
      [add, debounce, mf, srv],
    );
    const withCart = () => refreshOf([main, conn, cart, placeholder('u', 'fmt')], [{ fileId: 'm', ...mainSlice }]);
    const posts = () => post.mock.calls.map(([m]) => m);
    const linkLoads = () => posts().filter((m) => m.type === 'tree/loadLinks');
    const row = (id: string) => container.querySelector<HTMLElement>(`[data-tree-id="${id}"]`)!;

    beforeEach(() => {
      tree.applyRefresh(withCart());
      tree.expand('m');
      tree.addLinks(linksOf(main));
      post.mockClear();
    });

    it('expanding a function posts tree/loadLinks once and shows Loading…, which addLinks replaces (R7, R8)', () => {
      tree.expand('mf');
      expect(linkLoads()).toEqual([{ type: 'tree/loadLinks', nodeId: 'mf' }]);
      expect(rows()).toContain('      Loading…');
      tree.expand('mf');
      tree.expand('mf');
      tree.expand('dir:internal');
      expect(linkLoads()).toHaveLength(1);
      tree.addLinks(mfLinks);
      expect(rows().some((r) => r.includes('Loading…'))).toBe(false);
    });

    it('lists only non-empty groups in order, distinct far ends by label; a linked placeholder does not join Unresolved (R7)', () => {
      tree.expand('mf');
      tree.addLinks(mfLinks);
      tree.expand('links:mf:calls');
      tree.expand('links:mf:calledBy');
      tree.expand('group:unresolved');
      expect(rows()).toEqual([
        '[root] proj',
        '  [dir] internal',
        '  [dir] src',
        '  [file] main.go',
        '    [fn] main',
        '      Calls (3)',
        '        [fn] add  src/cart/Cart.ts:12',
        '        [?] lodash.debounce  unresolved',
        '        [fn] main  x:3',
        '      Called by (1)',
        '        [fn] main  x:3',
        '      References (1)',
        '    [class] Server',
        'Unresolved (2)',
        '  [?] fetchData',
        '  [?] fmt',
      ]);
      const linked = row('link:mf:calls:add');
      expect(linked.querySelector('.tree-location')!.textContent).toBe('src/cart/Cart.ts:12');
      expect(linked.querySelector('.tree-chevron')!.textContent).toBe('');
      expect(linked.hasAttribute('aria-expanded')).toBe(false);
    });

    it('mouseenter asks for an un-held node once; loadFailed drops Loading… and the expansion', () => {
      row('srv').dispatchEvent(new MouseEvent('mouseenter'));
      row('srv').dispatchEvent(new MouseEvent('mouseenter'));
      expect(linkLoads()).toEqual([{ type: 'tree/loadLinks', nodeId: 'srv' }]);
      tree.expand('mf');
      tree.loadFailed('mf');
      expect(rows().some((r) => r.includes('Loading…'))).toBe(false);
      expect(row('mf').getAttribute('aria-expanded')).toBe('false');
    });

    it('tooltip: Kind, Name, Location, In / Out without contains; Loading… until links; placeholders have no Location (R6)', () => {
      tree.expand('mf');
      tree.addLinks(mfLinks);
      tree.expand('links:mf:calls');
      expect(row('link:mf:calls:add').title).toBe('Kind      function\nName      add\nLocation  src/cart/Cart.ts:12\nIn        Loading…\nOut       Loading…');
      tree.addLinks(
        linksOf(add, [edge('contains', 'k', 'add'), edge('calls', 'mf', 'add'), edge('calls', 'x', 'add'), edge('references', 'y', 'add')], [edge('calls', 'add', 'z')]),
      );
      expect(row('link:mf:calls:add').title).toBe(
        'Kind      function\nName      add\nLocation  src/cart/Cart.ts:12\nIn        calls 2 · references 1\nOut       calls 1',
      );
      tree.expand('group:unresolved');
      tree.addLinks(linksOf(placeholder('u', 'fmt'), [edge('imports', 'a', 'u', false), edge('imports', 'b', 'u', false), edge('calls', 'c', 'u', false)]));
      expect(row('u').title).toBe('Kind      unresolved\nName      fmt\nIn        unresolved 3');
      for (const id of ['root:', 'dir:internal', 'group:unresolved', 'links:mf:calls']) expect(row(id).title).toBe('');
    });

    it('a linked row click selects the linked node with its file by path; reveal keeps it; dblclick / Enter open it (R9, R11)', () => {
      tree.expand('mf');
      tree.addLinks(mfLinks);
      tree.expand('links:mf:calls');
      tree.click('link:mf:calls:add');
      expect(select.mock.calls).toEqual([[add, 'k']]);
      expect(tree.state().selected).toBe('[fn] add  src/cart/Cart.ts:12');
      tree.reveal('add');
      expect(tree.state().selected).toBe('[fn] add  src/cart/Cart.ts:12');
      expect(rows()).not.toContain('    [file] Cart.ts');
      tree.key('Enter');
      tree.dblClick('link:mf:calls:add');
      tree.dblClick('link:mf:calls:u3');
      tree.click('link:mf:calls:u3');
      tree.key('Enter');
      expect(select.mock.calls[1]).toEqual([debounce, undefined]);
      expect(posts().filter((m) => m.type === 'shell/openNode')).toEqual([
        { type: 'shell/openNode', nodeId: 'add' },
        { type: 'shell/openNode', nodeId: 'add' },
      ]);
    });

    it('refresh keeps an expanded node’s links drawn and re-asks for them; drops the rest; a removed node’s go (R12)', () => {
      tree.expand('mf');
      tree.addLinks(mfLinks);
      tree.addLinks(linksOf(srv, [edge('references', 'mf', 'srv')]));
      post.mockClear();
      tree.applyRefresh(withCart());
      expect(rows()).toContain('      Calls (3)');
      expect(linkLoads().map((m) => m.nodeId).sort()).toEqual(['m', 'mf']);
      expect(row('srv').title).toContain('In        Loading…');
      post.mockClear();
      tree.applyRefresh(refreshOf([conn, cart]));
      expect(linkLoads()).toEqual([]);
    });
  });

  it('setShown hides and shows the pane', () => {
    tree.setShown(false);
    expect(container.hidden).toBe(true);
    expect(tree.state().shown).toBe(false);
    tree.setShown(true);
    expect(tree.isShown()).toBe(true);
  });
});

// main.ts runs once per module load: these share one webview, in order.
describe('main.ts tree wiring', () => {
  const post = vi.fn();
  const send = (data: GraphToWebview) => window.dispatchEvent(new MessageEvent('message', { data }));
  const posts = () => post.mock.calls.map(([m]) => m);
  // Runs a debug op and returns the debug state it posts.
  const debug = (op: DebugOp): DebugState => {
    send({ type: 'graph/debug', ...op });
    return posts().filter((m) => m.type === 'graph/debugState').at(-1);
  };
  const btn = () => document.getElementById('btn-tree') as HTMLButtonElement;
  const note = () => document.getElementById('details-hidden')!;

  it('Tree is pressed but disabled with only NODES until the first graph/refresh; a click toggles it (R1, R13)', async () => {
    const html = getHtml({ cspSource: 'csp', asWebviewUri: (u) => u }, Uri.file('/ext') as unknown as vscode.Uri, 'n');
    document.body.innerHTML = /<body>([\s\S]*)<\/body>/.exec(html)![1];
    (globalThis as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi = () => ({ postMessage: post });
    await import('../../../media/main');
    const pane = document.getElementById('tree')!;
    expect([btn().disabled, btn().getAttribute('aria-pressed'), pane.hidden, pane.textContent]).toEqual([true, 'true', false, 'NODES']);
    send({ type: 'graph/refresh', ...layer });
    expect(btn().disabled).toBe(false);
    btn().click();
    expect([btn().getAttribute('aria-pressed'), pane.hidden]).toEqual(['false', true]);
    send({ type: 'graph/refresh', ...layer });
    expect(pane.hidden).toBe(true);
    btn().click();
  });

  it('a tree click on a symbol of a collapsed file expands it, selects and asks for details (R9)', () => {
    debug({ op: 'treeExpand', id: 'm' });
    send({ type: 'tree/fileLoaded', fileId: 'm', ...mainSlice });
    post.mockClear();
    debug({ op: 'treeClick', id: 'mf' });
    expect(posts().filter((m) => m.type !== 'graph/debugState')).toEqual([
      { type: 'graph/expand', fileId: 'm' },
      { type: 'shell/selectNode', nodeId: 'mf' },
      { type: 'graph/details', nodeId: 'mf' },
    ]);
  });

  it('with the function kind off the click leaves the canvas alone and Details shows Hidden by current filters (R9)', () => {
    debug({ op: 'toggle', id: 'm' });
    debug({ op: 'kind', kind: 'function', on: false });
    debug({ op: 'treeExpand', id: 'srv' });
    post.mockClear();
    const s = debug({ op: 'treeClick', id: 'run' });
    expect(posts().some((m) => m.type === 'graph/expand')).toBe(false);
    expect(s.tree.selected).toBe('[fn] Run');
    send({ type: 'graph/nodeDetails', node: mainSlice.nodes[1], inbound: [], outbound: [] });
    expect(note().hidden).toBe(false);
    expect(debug({ op: 'state' }).details).toContain('Hidden by current filters');
    debug({ op: 'kind', kind: 'function', on: true });
  });

  it('a canvas tap reveals the row while shown, not while hidden; Escape clears it (R10)', () => {
    let s = debug({ op: 'tap', id: 'c' });
    expect(s.tree.selected).toBe('[file] conn.go');
    expect(s.tree.rows).toContain('      [file] conn.go');
    expect(note().hidden).toBe(true);
    s = debug({ op: 'escape' });
    expect(s.tree.selected).toBeNull();
    debug({ op: 'treeToggle' });
    s = debug({ op: 'tap', id: 'm' });
    expect(s.tree.selected).toBeNull();
    debug({ op: 'treeToggle' });
  });
});
