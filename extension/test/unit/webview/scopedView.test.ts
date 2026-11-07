// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import type { DebugOp, DebugState, GraphRefresh, GraphToWebview } from '../../../src/graph/messages';
import { getHtml } from '../../../src/panel/graphPanel';
import type { GraphEdge, GraphNode } from '../../../src/sidecar/protocol';
import { Uri } from '../mocks/vscode';

vi.mock('cytoscape', async (original) => (await import('../fakes/headlessCytoscape')).headlessCytoscape(original));

// Scoped view end to end in the webview (code-graph R13–R20, node-tree R16, R17), one main.ts instance throughout.
const file = (id: string, path: string): GraphNode => ({ id, kind: 'file', name: path, path });
const edge = (kind: GraphEdge['kind'], fromId: string, toId: string): GraphEdge => ({ id: `${kind}:${fromId}:${toId}`, kind, fromId, toId, resolved: true });
const main = file('m', 'main.go');
const cfg = file('cfg', 'config.go');
const util = file('u', 'util.go');
const parseConfig: GraphNode = { id: 'pc', kind: 'function', name: 'parseConfig', path: 'config.go', startLine: 3, endLine: 9, parentId: 'cfg' };
const imports = [edge('imports', 'm', 'cfg'), edge('imports', 'cfg', 'u')];
const refresh = (scoped: boolean): GraphRefresh => ({
  files: { nodes: [main, cfg, util], edges: imports },
  expanded: [],
  roots: [{ name: 'proj', prefix: '' }],
  scoped,
  total: 5400,
});

describe('scoped view in the webview', () => {
  const post = vi.fn();
  const send = (data: GraphToWebview | { type: 'shell/state'; state: 'ready' }) => window.dispatchEvent(new MessageEvent('message', { data }));
  const posts = () => post.mock.calls.map(([m]) => m).filter((m) => m.type !== 'graph/debugState');
  const debug = (op: DebugOp): DebugState => {
    send({ type: 'graph/debug', ...op });
    return post.mock.calls.map(([m]) => m).filter((m) => m.type === 'graph/debugState').at(-1);
  };
  const drawn = (s: DebugState) => s.nodes.map((n) => n.id).sort();
  const btn = () => document.getElementById('btn-tree') as HTMLButtonElement;

  it('a scoped refresh with no selection draws nothing, prompts, and shows a hidden tree pane (R13, R16, node-tree R17)', async () => {
    const html = getHtml({ cspSource: 'csp', asWebviewUri: (u) => u }, Uri.file('/ext') as unknown as vscode.Uri, 'n');
    document.body.innerHTML = /<body>([\s\S]*)<\/body>/.exec(html)![1];
    (globalThis as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi = () => ({ postMessage: post });
    await import('../../../media/main');
    send({ type: 'shell/state', state: 'ready' });
    send({ type: 'graph/refresh', ...refresh(false) });
    expect(drawn(debug({ op: 'state' }))).toEqual(['cfg', 'm', 'u']);
    btn().click();
    expect(debug({ op: 'state' }).tree.shown).toBe(false);

    send({ type: 'graph/refresh', ...refresh(true) });
    const s = debug({ op: 'state' });
    expect(s.nodes).toEqual([]);
    expect(s.counts).toBe('0 nodes · 0 edges');
    expect(s.narrowing.canvasText).toBe('Large graph (5400 nodes). Select a node in the tree to show its graph.');
    expect([s.tree.shown, s.tree.pressed]).toEqual([true, true]);
    expect([s.narrowing.focusEnabled, s.narrowing.hopsEnabled]).toEqual([false, false]);
  });

  it('a tree click scopes the canvas to the node without expanding its file (R14, R15, node-tree R16)', () => {
    post.mockClear();
    debug({ op: 'treeClick', id: 'cfg' });
    expect(posts()).toEqual([
      { type: 'shell/selectNode', nodeId: 'cfg' },
      { type: 'graph/scope', nodeId: 'cfg', hops: 1 },
      { type: 'graph/details', nodeId: 'cfg' },
    ]);
    send({ type: 'graph/scoped', nodeId: 'cfg', nodes: [cfg, parseConfig, main, util], edges: [...imports, edge('contains', 'cfg', 'pc')] });
    const s = debug({ op: 'state' });
    expect(drawn(s)).toEqual(['cfg', 'm', 'pc', 'u']);
    expect(s.narrowing.canvasText).toBe('');
    expect([s.narrowing.focusEnabled, s.narrowing.hopsEnabled]).toEqual([false, true]);
    expect(s.details).not.toContain('Hidden by current filters');
  });

  it('Hops sets the scope depth and asks again (R14, R20)', () => {
    post.mockClear();
    const s = debug({ op: 'hops', n: 2 });
    expect(posts()).toEqual([{ type: 'graph/scope', nodeId: 'cfg', hops: 2 }]);
    expect([s.narrowing.hops, s.narrowing.focused]).toEqual([2, false]);
  });

  it('a canvas tap re-scopes and reveals the row; a stale reply is ignored (R15)', () => {
    post.mockClear();
    const s = debug({ op: 'tap', id: 'u' });
    expect(posts()).toContainEqual({ type: 'graph/scope', nodeId: 'u', hops: 2 });
    expect(s.tree.selected).toBe('[file] util.go');
    const before = drawn(s);
    send({ type: 'graph/scoped', nodeId: 'cfg', nodes: [cfg, parseConfig, { ...util, id: 'stale' }], edges: [edge('imports', 'stale', 'u')] });
    expect(drawn(debug({ op: 'state' }))).toEqual(before);
  });

  it('a root row click leaves the scope alone (R21)', () => {
    post.mockClear();
    debug({ op: 'treeClick', id: 'proj' });
    expect(posts().filter((m) => m.type === 'shell/selectNode' || m.type === 'graph/scope')).toEqual([]);
  });

  it('a reply saying the scope node is gone clears the selection back to the prompt (R18)', () => {
    send({ type: 'graph/scoped', nodeId: 'u', nodes: [], edges: [] });
    const s = debug({ op: 'state' });
    expect(s.tree.selected).toBeNull();
    expect(s.narrowing.canvasText).toBe('Large graph (5400 nodes). Select a node in the tree to show its graph.');
  });

  it('a refresh keeps a surviving scope node and fetches it again (R18)', () => {
    debug({ op: 'tap', id: 'm' });
    post.mockClear();
    send({ type: 'graph/refresh', ...refresh(true) });
    expect(posts()).toContainEqual({ type: 'graph/scope', nodeId: 'm', hops: 2 });
  });

  it('a refresh under the threshold switches back to the full file layer (R1, R18)', () => {
    send({ type: 'graph/refresh', ...refresh(false) });
    const s = debug({ op: 'state' });
    expect(drawn(s)).toEqual(['cfg', 'm', 'u']);
    expect(s.narrowing.canvasText).toBe('');
    expect(s.narrowing.focusEnabled).toBe(true);
  });
});
