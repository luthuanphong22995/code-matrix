// @vitest-environment jsdom
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import type { GraphToWebview } from '../../../src/graph/messages';
import type { ShellToWebview } from '../../../src/panel/messages';
import { getHtml } from '../../../src/panel/graphPanel';
import type { GraphNode } from '../../../src/sidecar/protocol';
import { Uri } from '../mocks/vscode';

vi.mock('cytoscape', async (original) => (await import('../fakes/headlessCytoscape')).headlessCytoscape(original));

const main: GraphNode = { id: 'm', kind: 'file', name: 'main.go', path: 'main.go' };
const conn: GraphNode = { id: 'c', kind: 'file', name: 'internal/db/conn.go', path: 'internal/db/conn.go' };
const fmt: GraphNode = { id: 'u', kind: 'unresolved', name: 'fmt' };

// Drives the real media/main.ts (and so the real toolbar) against getHtml's markup.
describe('toolbar', () => {
  const postMessage = vi.fn();
  const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const send = (data: ShellToWebview | GraphToWebview) => window.dispatchEvent(new MessageEvent('message', { data }));
  const key = (el: Element, k: string) => el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
  const controls = () => ['nar-search', 'nar-path', 'nar-kinds', 'nar-focus', 'nar-hops'].map((id) => byId<HTMLInputElement>(id));
  const posted = () => postMessage.mock.calls.map(([m]) => m.type);

  beforeAll(async () => {
    const html = getHtml({ cspSource: 'csp', asWebviewUri: (u) => u }, Uri.file('/ext') as unknown as vscode.Uri, 'n');
    document.body.innerHTML = /<body>([\s\S]*)<\/body>/.exec(html)![1];
    (globalThis as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi = () => ({ postMessage });
    await import('../../../media/main');
    send({
      type: 'graph/refresh',
      files: { nodes: [main, conn, fmt], edges: [{ id: 'i', kind: 'imports', fromId: 'm', toId: 'u', resolved: false }] },
      expanded: [],
      roots: [],
    });
  });

  it('every control is disabled until shell/state ready; Focus and Hops need a selection / focus', () => {
    expect(controls().every((c) => c.disabled)).toBe(true);
    send({ type: 'shell/state', state: 'ready' });
    expect(controls().map((c) => c.disabled)).toEqual([false, false, false, true, true]);
    send({ type: 'shell/state', state: 'indexing' });
    expect(controls().every((c) => c.disabled)).toBe(true);
    send({ type: 'shell/state', state: 'ready' });
  });

  it('search halos and counts the visible matches; Escape in Search does not reach the shell', () => {
    send({ type: 'graph/debug', op: 'tap', id: 'm' });
    postMessage.mockClear();
    const search = byId<HTMLInputElement>('nar-search');
    search.value = 'GO';
    key(search, 'Enter');
    expect(byId('nar-matches').textContent).toBe('2 matches');
    search.value = 'nope';
    key(search, 'Enter');
    expect(byId('nar-matches').textContent).toBe("No matches for 'nope'");
    key(search, 'Escape');
    expect(search.value).toBe('');
    expect(byId('nar-matches').textContent).toBe('');
    expect(posted()).toEqual([]);
  });

  it('an invalid glob replaces the counts until the field changes, keeping the previous filter', () => {
    const path = byId<HTMLInputElement>('nar-path');
    path.value = 'internal/**';
    key(path, 'Enter');
    expect(byId('graph-counts').textContent).toBe('1 nodes · 0 edges');
    path.value = 'src/[api';
    key(path, 'Enter');
    expect(byId('graph-counts').textContent).toBe('Invalid pattern: src/[api');
    path.dispatchEvent(new Event('input'));
    expect(byId('graph-counts').textContent).toBe('1 nodes · 0 edges');
    path.value = '';
    key(path, 'Enter');
    expect(byId('graph-counts').textContent).toBe('3 nodes · 1 edges');
    expect(posted()).toEqual([]);
  });

  it('Focus enters with Hops enabled; leaving re-applies expansion through graph/expand / graph/collapse only', () => {
    const focus = byId<HTMLButtonElement>('nar-focus');
    expect(focus.disabled).toBe(false);
    focus.click();
    expect(focus.getAttribute('aria-pressed')).toBe('true');
    expect(byId<HTMLInputElement>('nar-hops').disabled).toBe(false);
    // main.go's neighbourhood: itself and fmt.
    expect(byId('graph-counts').textContent).toBe('2 nodes · 1 edges');
    send({ type: 'graph/debug', op: 'toggle', id: 'c' });
    postMessage.mockClear();
    focus.click();
    expect(focus.getAttribute('aria-pressed')).toBe('false');
    expect(byId<HTMLInputElement>('nar-hops').disabled).toBe(true);
    expect(postMessage.mock.calls.map(([m]) => m)).toEqual([{ type: 'graph/collapse', fileId: 'c' }]);
    expect(byId('graph-counts').textContent).toBe('3 nodes · 1 edges');
  });

  it('Escape while focused leaves focus and clears the selection', () => {
    byId<HTMLButtonElement>('nar-focus').click();
    key(document.body, 'Escape');
    expect(byId('nar-focus').getAttribute('aria-pressed')).toBe('false');
    expect(byId<HTMLButtonElement>('nar-focus').disabled).toBe(true);
    expect(postMessage).toHaveBeenLastCalledWith({ type: 'shell/selectNode', nodeId: null });
  });

  it('Group toggles folder boxes and aria-pressed; disabled unless ready; narrowing and refresh leave it alone', () => {
    const group = byId<HTMLButtonElement>('nar-group');
    const debugState = () => {
      send({ type: 'graph/debug', op: 'state' });
      return postMessage.mock.calls.map(([m]) => m).filter((m) => m.type === 'graph/debugState').at(-1);
    };
    send({ type: 'shell/state', state: 'indexing' });
    expect(group.disabled).toBe(true);
    send({ type: 'shell/state', state: 'ready' });
    const counts = byId('graph-counts').textContent;
    group.click();
    expect(group.getAttribute('aria-pressed')).toBe('true');
    expect(debugState()).toMatchObject({ grouped: true, folders: [{ label: 'internal/db', parent: null }] });
    expect(byId('graph-counts').textContent).toBe(counts);
    send({ type: 'graph/debug', op: 'path', text: 'main.go' });
    send({ type: 'graph/debug', op: 'kind', kind: 'imports', on: false });
    send({ type: 'graph/debug', op: 'tap', id: 'm' });
    send({ type: 'graph/debug', op: 'focus' });
    send({ type: 'graph/debug', op: 'focus' });
    send({ type: 'graph/debug', op: 'path', text: '' });
    send({ type: 'graph/debug', op: 'kind', kind: 'imports', on: true });
    send({ type: 'graph/refresh', files: { nodes: [main, conn, fmt], edges: [] }, expanded: [], roots: [] });
    expect(debugState()).toMatchObject({ grouped: true, folders: [{ label: 'internal/db', parent: null }] });
    expect(group.getAttribute('aria-pressed')).toBe('true');
    group.click();
    expect(group.getAttribute('aria-pressed')).toBe('false');
    expect(debugState()).toMatchObject({ grouped: false, folders: [] });
  });
});
