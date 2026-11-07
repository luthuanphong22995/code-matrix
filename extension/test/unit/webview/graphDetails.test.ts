// @vitest-environment jsdom
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import { kindCounts, renderGraphDetails } from '../../../media/graphDetails';
import type { GraphToWebview } from '../../../src/graph/messages';
import type { ShellToWebview } from '../../../src/panel/messages';
import { getHtml } from '../../../src/panel/graphPanel';
import type { GraphEdge, GraphNode, GraphNodeDetail } from '../../../src/sidecar/protocol';
import { Uri } from '../mocks/vscode';

vi.mock('cytoscape', async (original) => (await import('../fakes/headlessCytoscape')).headlessCytoscape(original));

const fn: GraphNode = { id: 'p', kind: 'function', name: 'parseConfig', path: 'config.go', startLine: 14, endLine: 18, parentId: 'f' };
const file: GraphNode = { id: 'f', kind: 'file', name: 'config.go', path: 'config.go' };
const fetchData: GraphNode = { id: 'u', kind: 'unresolved', name: 'fetchData' };
const e = (kind: GraphEdge['kind'], resolved = true): GraphEdge => ({ id: kind, kind, fromId: 'x', toId: 'y', resolved });
const text = (el: HTMLElement) => Array.from(el.querySelectorAll('button, dt, li'), (n) => n.textContent);

describe('renderGraphDetails', () => {
  const section = () => document.createElement('div');

  it('a function: in then out counts, unresolved counted apart, no button', () => {
    const el = section();
    const detail: GraphNodeDetail = { node: fn, inbound: [e('contains'), e('calls')], outbound: [e('calls', false)] };
    renderGraphDetails(el, detail, false, vi.fn());
    expect(text(el)).toEqual(['in · contains: 1', 'in · calls: 1', 'out · unresolved: 1']);
    expect(el.querySelector('h4')!.textContent).toBe('Edges');
  });

  it('a file: Expand / Collapse runs the toggle', () => {
    const el = section();
    const toggle = vi.fn();
    renderGraphDetails(el, { node: file, inbound: [], outbound: [e('contains'), e('contains'), e('imports')] }, false, toggle);
    expect(text(el)).toEqual(['Expand', 'out · contains: 2', 'out · imports: 1']);
    el.querySelector('button')!.click();
    expect(toggle).toHaveBeenCalledOnce();
    renderGraphDetails(el, { node: file, inbound: [], outbound: [] }, true, toggle);
    expect(text(el)).toEqual(['Collapse']);
  });

  it('a placeholder: Kind unresolved and its raw name', () => {
    const el = section();
    renderGraphDetails(el, { node: fetchData, inbound: [e('calls', false)], outbound: [] }, false, vi.fn());
    expect(text(el)).toEqual(['Kind', 'Name', 'in · unresolved: 1']);
    expect(Array.from(el.querySelectorAll('dd'), (n) => n.textContent)).toEqual(['unresolved', 'fetchData']);
    expect(el.querySelector('button')).toBeNull();
  });
});

describe('kindCounts', () => {
  it('kind order, a resolved: false edge as unresolved, zeros omitted', () => {
    expect(kindCounts([e('references'), e('calls', false), e('calls'), e('contains'), e('calls'), e('imports', false)])).toEqual([
      ['contains', 1],
      ['calls', 2],
      ['references', 1],
      ['unresolved', 2],
    ]);
    expect(kindCounts([])).toEqual([]);
  });
});

// Drives the real media/main.ts against getHtml's markup.
describe('main: placeholder selection', () => {
  const postMessage = vi.fn();
  const byId = (id: string) => document.getElementById(id)!;
  const send = (data: ShellToWebview | GraphToWebview) => window.dispatchEvent(new MessageEvent('message', { data }));

  beforeAll(async () => {
    const html = getHtml({ cspSource: 'csp', asWebviewUri: (u) => u }, Uri.file('/ext') as unknown as vscode.Uri, 'n');
    document.body.innerHTML = /<body>([\s\S]*)<\/body>/.exec(html)![1];
    (globalThis as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi = () => ({ postMessage });
    await import('../../../media/main');
    send({ type: 'shell/state', state: 'ready' });
    send({
      type: 'graph/refresh',
      files: { nodes: [file, fetchData], edges: [{ id: 'i', kind: 'imports', fromId: 'f', toId: 'u', resolved: false }] },
      expanded: [],
      roots: [],
    });
  });

  it('mounts #graph after #overlay and the toolbar (counts last) in #toolbar-slot', () => {
    expect(byId('main').lastElementChild!.id).toBe('graph');
    expect(byId('toolbar-slot').lastElementChild!.id).toBe('graph-counts');
    expect(byId('graph-counts').textContent).toBe('2 nodes · 1 edges');
    expect(byId('details').lastElementChild!.id).toBe('details-graph');
  });

  it('a selection the shell answers null for keeps the empty text hidden; details for it render', () => {
    send({ type: 'graph/debug', op: 'tap', id: 'u' });
    expect(postMessage).toHaveBeenCalledWith({ type: 'shell/selectNode', nodeId: 'u' });
    expect(postMessage).toHaveBeenCalledWith({ type: 'graph/details', nodeId: 'u' });
    send({ type: 'shell/selection', node: null });
    expect(byId('details-empty').hidden).toBe(true);
    send({ type: 'graph/nodeDetails', node: fetchData, inbound: [], outbound: [] });
    expect(text(byId('details-graph'))).toEqual(['Kind', 'Name']);
    // A reply for another node is stale.
    send({ type: 'graph/nodeDetails', node: file, inbound: [], outbound: [] });
    expect(text(byId('details-graph'))).toEqual(['Kind', 'Name']);
  });

  it('Escape shows the empty text and empties #details-graph', () => {
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(byId('details-empty').hidden).toBe(false);
    expect(byId('details-graph').childElementCount).toBe(0);
  });

  it('graph/debug state replies with drawn elements and visible Details lines', () => {
    postMessage.mockClear();
    send({ type: 'graph/debug', op: 'state' });
    expect(postMessage).toHaveBeenCalledWith({
      type: 'graph/debugState',
      nodes: [
        { id: 'f', kind: 'file', name: 'config.go' },
        { id: 'u', kind: 'unresolved', name: 'fetchData' },
      ],
      edges: [{ kind: 'imports', fromId: 'f', toId: 'u', resolved: false }],
      counts: '2 nodes · 1 edges',
      emptyText: '',
      details: ['Select a node to see its details'],
      narrowing: expect.objectContaining({ matchText: '', canvasText: '', focused: false }),
      strip: '',
      overlay: '',
      flow: null,
      grouped: false,
      folders: [],
      tree: expect.objectContaining({ shown: true, pressed: true, disabled: false }),
    });
  });

  it('a graph/refresh with zero file nodes shows the empty state', () => {
    send({ type: 'graph/refresh', files: { nodes: [], edges: [] }, expanded: [], roots: [] });
    expect(byId('graph-empty').hidden).toBe(false);
    expect(byId('graph-empty').textContent).toBe('No supported source files found');
    expect(byId('graph-counts').textContent).toBe('0 nodes · 0 edges');
  });
});
