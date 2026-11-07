// @vitest-environment jsdom
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import { blockLabel, flowMarks } from '../../../media/flow';
import type { FlowToWebview } from '../../../src/flow/messages';
import type { DebugState, FlowDebugState, GraphToWebview } from '../../../src/graph/messages';
import { getHtml } from '../../../src/panel/graphPanel';
import type { ShellToWebview } from '../../../src/panel/messages';
import type { GraphNode } from '../../../src/sidecar/protocol';
import { FUNCTION_ID, noReachingDef, noUses, parseConfig } from '../fakes/trace';
import { Uri } from '../mocks/vscode';

vi.mock('cytoscape', async (original) => (await import('../fakes/headlessCytoscape')).headlessCytoscape(original));

describe('blockLabel', () => {
  it('entry / exit, line A, lines A–B, then the first line trimmed', () => {
    expect(blockLabel(parseConfig.blocks[0])).toBe('entry');
    expect(blockLabel(parseConfig.blocks[7])).toBe('exit');
    expect(blockLabel(parseConfig.blocks[1])).toBe('line 12\ntotal := 0');
    expect(blockLabel(parseConfig.blocks[4])).toBe('lines 16–17\nunused := defaultPath');
    expect(blockLabel({ id: 'x', kind: 'basic', startLine: 3, endLine: 3, firstLine: '' })).toBe('line 3');
  });

  it('a first line over 32 characters is cut to 32 then …', () => {
    const forty = 'x'.repeat(40);
    expect(blockLabel({ id: 'x', kind: 'basic', startLine: 1, endLine: 1, firstLine: `  ${forty}` })).toBe(`line 1\n${'x'.repeat(32)}…`);
    expect(blockLabel({ id: 'x', kind: 'basic', startLine: 1, endLine: 1, firstLine: 'y'.repeat(32) })).toBe(`line 1\n${'y'.repeat(32)}`);
  });
});

describe('flowMarks', () => {
  it('hop 2 is a self-loop on line 14; hop 0 has no current block and no arrow', () => {
    expect(flowMarks(parseConfig, 2)).toEqual({
      trace: ['flow:b1', 'flow:b3', 'flow:b5'],
      current: 'flow:b3',
      hop: { from: 'flow:b3', to: 'flow:b3', label: 'total' },
    });
    expect(flowMarks(noUses, 0)).toEqual({ trace: ['flow:b4'], current: null, hop: null });
  });
});

const file: GraphNode = { id: 'c', kind: 'file', name: 'config.go', path: 'config.go' };
const fn: GraphNode = { id: FUNCTION_ID, kind: 'function', name: 'parseConfig', path: 'config.go', startLine: 11, endLine: 22, parentId: 'c' };
const files = { nodes: [file], edges: [] };
const slice = { nodes: [fn], edges: [{ id: 'cp', kind: 'contains' as const, fromId: 'c', toId: FUNCTION_ID, resolved: true }] };

// Drives the real media/main.ts.
describe('a trace in the webview', () => {
  const postMessage = vi.fn();
  const send = (data: ShellToWebview | GraphToWebview | FlowToWebview) => window.dispatchEvent(new MessageEvent('message', { data }));
  const posts = () => postMessage.mock.calls.map(([msg]) => msg as { type: string });
  const state = (): DebugState => {
    send({ type: 'graph/debug', op: 'state' });
    return postMessage.mock.calls.at(-1)![0] as DebugState;
  };
  const flow = () => state().flow!;
  const key = (k: string, target: EventTarget = document.body) => target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
  const byId = (id: string) => document.getElementById(id)!;
  const show = (trace = parseConfig, hop = 1) => send({ type: 'flow/show', trace, path: 'config.go', hop });
  const drawn = () => {
    send({ type: 'graph/refresh', files, expanded: [{ fileId: 'c', ...slice }], roots: [] });
    show();
  };

  beforeAll(async () => {
    const html = getHtml({ cspSource: 'csp', asWebviewUri: (u) => u }, Uri.file('/ext') as unknown as vscode.Uri, 'n');
    document.body.innerHTML = /<body>([\s\S]*)<\/body>/.exec(html)![1];
    (globalThis as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi = () => ({ postMessage });
    await import('../../../media/main');
    send({ type: 'shell/state', state: 'ready' });
  });

  beforeEach(() => {
    send({ type: 'flow/clear' });
    postMessage.mockClear();
  });

  it('the strip is hidden on load and no flow is reported', () => {
    expect(byId('flow-strip').hidden).toBe(true);
    expect(state().flow).toBeNull();
  });

  it('a flow/show before any refresh keeps the strip, then unfolds after graph/refresh + graph/expanded with one graph/expand', () => {
    show();
    expect(byId('flow-strip').hidden).toBe(false);
    expect(flow()).toMatchObject({ container: null, blocks: [] });
    send({ type: 'graph/refresh', files, expanded: [], roots: [] });
    expect(posts().filter((m) => m.type === 'graph/expand')).toEqual([{ type: 'graph/expand', fileId: 'c' }]);
    send({ type: 'graph/expanded', fileId: 'c', ...slice });
    expect(posts().filter((m) => m.type === 'graph/expand')).toHaveLength(1);
    expect(flow()).toMatchObject({ container: 'parseConfig', current: 'b3' });
    expect(flow().blocks.map((b) => b.label)).toEqual([
      'entry',
      'line 12\ntotal := 0',
      'line 13\nfor _, n := range open(path) {',
      'line 14\ntotal = total + n',
      'lines 16–17\nunused := defaultPath',
      'line 18\nreturn total',
      'lines 20–21\nlog(path)',
      'exit',
    ]);
  });

  it('hop 1: 12/14/18 highlighted, 14 current, arrow 12 → 14, Prev disabled', () => {
    drawn();
    expect(flow()).toEqual<FlowDebugState>({
      status: 'Hop 1 of 4: total defined at line 12 → used at line 14',
      prev: false,
      next: true,
      hop: 1,
      container: 'parseConfig',
      blocks: expect.any(Array),
      highlighted: ['b1', 'b3', 'b5'],
      current: 'b3',
      hopEdge: { from: 'b1', to: 'b3', label: 'total' },
    });
    expect(byId('text-trace-status').querySelector('code')!.textContent).toBe('total');
    expect(byId('text-trace-status').textContent).not.toContain('`');
  });

  it('Right steps to hop 2 (a self-loop on 14) and on to hop 4; a further Right posts nothing', () => {
    drawn();
    key('ArrowRight');
    expect(flow()).toMatchObject({ hop: 2, current: 'b3', hopEdge: { from: 'b3', to: 'b3', label: 'total' }, prev: true });
    key('ArrowRight');
    key('ArrowRight');
    expect(flow()).toMatchObject({ hop: 4, status: 'Hop 4 of 4: total defined at line 14 → used at line 18', next: false, current: 'b5' });
    expect(posts().filter((m) => m.type === 'flow/hop')).toEqual([2, 3, 4].map((hop) => ({ type: 'flow/hop', hop })));
    postMessage.mockClear();
    key('ArrowRight');
    byId('btn-trace-next').click();
    expect(posts()).toEqual([]);
    key('ArrowLeft');
    byId('btn-trace-prev').click();
    expect(posts()).toEqual([
      { type: 'flow/hop', hop: 3 },
      { type: 'flow/hop', hop: 2 },
    ]);
  });

  it('noUses and noReachingDef: their status, both buttons disabled, no current block, no arrow', () => {
    send({ type: 'graph/refresh', files, expanded: [{ fileId: 'c', ...slice }], roots: [] });
    show(noUses, 0);
    expect(flow()).toMatchObject({ status: 'No uses of unused in parseConfig', prev: false, next: false, current: null, hopEdge: null, highlighted: ['b4'] });
    expect(Array.from(byId('text-trace-status').querySelectorAll('code'), (c) => c.textContent)).toEqual(['unused', 'parseConfig']);
    show(noReachingDef, 0);
    expect(flow()).toMatchObject({ status: 'No definition of n reaches this read', prev: false, next: false, current: null, hopEdge: null });
    postMessage.mockClear();
    key('ArrowRight');
    expect(posts()).toEqual([]);
  });

  it('over the cap the canvas shows too-large while the strip stays and Next still posts flow/hop', () => {
    const many = Array.from({ length: 1995 }, (_, i): GraphNode => ({ id: `f${i}`, kind: 'file', name: `f${i}.go`, path: `f${i}.go` }));
    // Shown first, so the 1,997 graph nodes are never laid out on their own.
    show();
    send({ type: 'graph/refresh', files: { nodes: [...many, file], edges: [] }, expanded: [{ fileId: 'c', ...slice }], roots: [] });
    const s = state();
    expect(s.narrowing.canvasText).toBe('Graph too large to render (2005 nodes). Narrow it with a filter.');
    expect(s.flow).toMatchObject({ container: null, blocks: [], status: 'Hop 1 of 4: total defined at line 12 → used at line 14' });
    expect(byId('flow-strip').hidden).toBe(false);
    postMessage.mockClear();
    byId('btn-trace-next').click();
    expect(posts()).toEqual([{ type: 'flow/hop', hop: 2 }]);
    // Back to a small graph before the trace is cleared, so the 1,997 nodes are never laid out.
    send({ type: 'graph/refresh', files, expanded: [], roots: [] });
  });

  it('Escape with a trace posts flow/clear, folds it and keeps the selection; without one it clears the selection', () => {
    drawn();
    send({ type: 'graph/debug', op: 'tap', id: FUNCTION_ID });
    postMessage.mockClear();
    key('Escape');
    expect(posts()).toEqual([{ type: 'flow/clear' }]);
    expect(byId('flow-strip').hidden).toBe(true);
    const s = state();
    expect(s.flow).toBeNull();
    expect(s.nodes.map((n) => n.id).sort()).toEqual(['c', FUNCTION_ID]);
    expect(s.counts).toBe('2 nodes · 1 edges');
    expect((window as unknown as { codeMatrixShell: { getSelectedNodeId(): string | null } }).codeMatrixShell.getSelectedNodeId()).toBe(FUNCTION_ID);
    postMessage.mockClear();
    key('Escape');
    expect(posts()).toEqual([{ type: 'shell/selectNode', nodeId: null }]);
  });

  it('Clear trace posts flow/clear; flow/clear from the extension folds and posts nothing', () => {
    drawn();
    byId('btn-trace-clear').click();
    expect(posts().filter((m) => m.type.startsWith('flow/'))).toEqual([{ type: 'flow/clear' }]);
    drawn();
    postMessage.mockClear();
    send({ type: 'flow/clear' });
    expect(posts()).toEqual([]);
    expect(state().flow).toBeNull();
  });

  it('Search-field Escape touches neither the trace nor the selection; arrows in the path field do not step', () => {
    drawn();
    postMessage.mockClear();
    const search = byId('toolbar-slot').querySelector('input')!;
    key('Escape', search);
    const path = Array.from(byId('toolbar-slot').querySelectorAll('input')).find((i) => i !== search && i.type !== 'checkbox' && i.type !== 'number')!;
    key('ArrowRight', path);
    expect(posts()).toEqual([]);
    expect(flow().hop).toBe(1);
  });
});
