// @vitest-environment jsdom
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import type { DebugState, GraphRefresh, GraphToWebview } from '../../../src/graph/messages';
import type { ShellToWebview } from '../../../src/panel/messages';
import { getHtml } from '../../../src/panel/graphPanel';
import type { GraphEdge, GraphNode } from '../../../src/sidecar/protocol';
import { Uri } from '../mocks/vscode';

vi.mock('cytoscape', async (original) => (await import('../fakes/headlessCytoscape')).headlessCytoscape(original));

const m: GraphNode = { id: 'm', kind: 'file', name: 'main.go', path: 'main.go' };
const c: GraphNode = { id: 'c', kind: 'file', name: 'config.go', path: 'config.go' };
const fmt: GraphNode = { id: 'u', kind: 'unresolved', name: 'fmt' };
const mainFn: GraphNode = { id: 'mf', kind: 'function', name: 'main', path: 'main.go', startLine: 5, endLine: 9, parentId: 'm' };
const p: GraphNode = { id: 'p', kind: 'function', name: 'parseConfig', path: 'config.go', startLine: 14, endLine: 18, parentId: 'c' };
const T: GraphNode = { id: 'T', kind: 'class', name: 'Config', path: 'config.go', startLine: 3, endLine: 6, parentId: 'c' };
const edge = (id: string, kind: GraphEdge['kind'], fromId: string, toId: string, resolved = true): GraphEdge => ({ id, kind, fromId, toId, resolved });

const expandM = { fileId: 'm', nodes: [mainFn], edges: [edge('cm', 'contains', 'm', 'mf'), edge('call', 'calls', 'mf', 'p'), edge('r1', 'references', 'mf', 'T')] };
const expandC = { fileId: 'c', nodes: [p, T], edges: [edge('cp', 'contains', 'c', 'p'), edge('cT', 'contains', 'c', 'T'), edge('r2', 'references', 'p', 'T')] };
// Before and after config.go is deleted.
const roots = [{ name: 'proj', prefix: '' }];
const withConfig: GraphRefresh = { files: { nodes: [m, c, fmt], edges: [edge('i', 'imports', 'm', 'u', false)] }, expanded: [expandM, expandC], roots };
const withoutConfig: GraphRefresh = { files: { nodes: [m, fmt], edges: [edge('i', 'imports', 'm', 'u', false)] }, expanded: [expandM], roots };

// Drives the real media/main.ts with hand-built graph/refresh payloads.
describe('graph/refresh in the webview', () => {
  const postMessage = vi.fn();
  const send = (data: ShellToWebview | GraphToWebview) => window.dispatchEvent(new MessageEvent('message', { data }));
  const refresh = (payload: GraphRefresh) => send({ type: 'graph/refresh', ...payload });
  const posts = () => postMessage.mock.calls.map(([msg]) => msg as { type: string });
  const state = (): DebugState => {
    send({ type: 'graph/debug', op: 'state' });
    return postMessage.mock.calls.at(-1)![0] as DebugState;
  };
  const drawn = () => state().nodes.map((n) => n.id).sort();

  beforeAll(async () => {
    const html = getHtml({ cspSource: 'csp', asWebviewUri: (u) => u }, Uri.file('/ext') as unknown as vscode.Uri, 'n');
    document.body.innerHTML = /<body>([\s\S]*)<\/body>/.exec(html)![1];
    (globalThis as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi = () => ({ postMessage });
    await import('../../../media/main');
    send({ type: 'shell/state', state: 'ready' });
    refresh(withConfig);
  });

  it('(a) an expanded file in the next payload stays expanded with its symbols drawn', () => {
    refresh(withConfig);
    expect(drawn()).toEqual(['T', 'c', 'm', 'mf', 'p', 'u']);
    send({ type: 'graph/debug', op: 'tap', id: 'c' });
    send({ type: 'graph/nodeDetails', node: c, inbound: [], outbound: [] });
    expect(state().details).toContain('Collapse');
  });

  it('(b) a surviving selection re-requests details; a removed one is cleared through the shell', () => {
    postMessage.mockClear();
    refresh(withConfig);
    expect(posts()).toContainEqual({ type: 'graph/details', nodeId: 'c' });
    expect(posts()).not.toContainEqual({ type: 'shell/selectNode', nodeId: null });

    send({ type: 'graph/debug', op: 'tap', id: 'p' });
    postMessage.mockClear();
    refresh(withoutConfig);
    expect(posts()).toContainEqual({ type: 'shell/selectNode', nodeId: null });
    expect(state().details).toEqual(['Select a node to see its details']);
    expect(drawn()).toEqual(['m', 'mf', 'u']);
  });

  it('(c) a focused node that is gone leaves focus, restoring glob and kinds; no graph/expand for a missing file', () => {
    refresh(withConfig);
    send({ type: 'graph/debug', op: 'tap', id: 'p' });
    send({ type: 'graph/debug', op: 'focus' });
    send({ type: 'graph/debug', op: 'path', text: 'main.go' });
    send({ type: 'graph/debug', op: 'kind', kind: 'function', on: false });
    expect(state().narrowing.focused).toBe(true);
    postMessage.mockClear();
    refresh(withoutConfig);
    expect(posts().filter((msg) => msg.type === 'graph/expand')).toEqual([]);
    const after = state();
    expect(after.narrowing).toMatchObject({ focused: false, pathText: '' });
    expect(after.narrowing.kinds.function).toBe(true);
    expect(document.getElementById('nar-focus')!.getAttribute('aria-pressed')).toBe('false');
  });

  it('(d) references toggled on stays on and the new payload references edges are drawn', () => {
    send({ type: 'graph/debug', op: 'kind', kind: 'references', on: true });
    refresh(withConfig);
    const s = state();
    expect(s.narrowing.kinds.references).toBe(true);
    expect(s.edges).toContainEqual({ kind: 'references', fromId: 'mf', toId: 'T', resolved: true });
    expect(s.edges).toContainEqual({ kind: 'references', fromId: 'p', toId: 'T', resolved: true });
  });

  it('(e) a search re-applies: halos and the match text follow the new payload', () => {
    send({ type: 'graph/debug', op: 'search', text: 'parseConfig' });
    expect(state().narrowing).toMatchObject({ matchText: '1 matches', halos: ['p'] });
    refresh(withoutConfig);
    expect(state().narrowing).toMatchObject({ matchText: "No matches for 'parseConfig'", halos: [] });
    refresh(withConfig);
    expect(state().narrowing).toMatchObject({ matchText: '1 matches', halos: ['p'] });
  });
});
