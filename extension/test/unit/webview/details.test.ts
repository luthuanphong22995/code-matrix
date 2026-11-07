// @vitest-environment jsdom
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import type { ShellToWebview } from '../../../src/panel/messages';
import { getHtml } from '../../../src/panel/graphPanel';
import { Uri } from '../mocks/vscode';

vi.mock('cytoscape', async (original) => (await import('../fakes/headlessCytoscape')).headlessCytoscape(original));

// Drives the real media/main.ts against getHtml's markup. Tests run in order and share one page.
describe('webview selection and Details (R8)', () => {
  const postMessage = vi.fn();
  const byId = (id: string) => document.getElementById(id)!;
  const send = (data: ShellToWebview) => window.dispatchEvent(new MessageEvent('message', { data }));
  const key = (k: string) => document.body.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
  const shell = () => (window as unknown as { codeMatrixShell: { getSelectedNodeId(): string | null } }).codeMatrixShell;
  let node: HTMLElement;

  beforeAll(async () => {
    const html = getHtml({ cspSource: 'csp', asWebviewUri: (u) => u }, Uri.file('/ext') as unknown as vscode.Uri, 'n');
    document.body.innerHTML = /<body>([\s\S]*)<\/body>/.exec(html)![1];
    node = document.createElement('div');
    node.dataset.nodeId = 'n1';
    byId('main').append(node);
    (globalThis as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi = () => ({ postMessage });
    await import('../../../media/main');
    send({ type: 'shell/state', state: 'ready' });
  });

  beforeEach(() => postMessage.mockClear());

  it('starts empty with nothing selected', () => {
    expect(byId('details-empty').hidden).toBe(false);
    expect(byId('details-fields').hidden).toBe(true);
    expect(byId('btn-open').hidden).toBe(true);
    expect(shell().getSelectedNodeId()).toBeNull();
  });

  it('a click on a data-node-id element posts shell/selectNode', () => {
    node.click();
    expect(postMessage).toHaveBeenCalledWith({ type: 'shell/selectNode', nodeId: 'n1' });
    expect(shell().getSelectedNodeId()).toBe('n1');
  });

  it('shell/selection renders Kind, Name, Location and Open in editor', () => {
    send({ type: 'shell/selection', node: { kind: 'function', name: 'parseConfig', location: 'src/config.go:12' } });
    expect(byId('details-kind').textContent).toBe('function');
    expect(byId('details-name').textContent).toBe('parseConfig');
    expect(byId('details-location').textContent).toBe('src/config.go:12');
    expect(byId('details-fields').hidden).toBe(false);
    expect(byId('btn-open').hidden).toBe(false);
    expect(byId('btn-open').textContent).toBe('Open in editor');
    expect(byId('details-empty').hidden).toBe(true);
  });

  it('Enter, Open in editor and double-click each post shell/openNode', () => {
    key('Enter');
    expect(postMessage).toHaveBeenLastCalledWith({ type: 'shell/openNode', nodeId: 'n1' });
    byId('btn-open').click();
    expect(postMessage).toHaveBeenLastCalledWith({ type: 'shell/openNode', nodeId: 'n1' });
    node.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(postMessage).toHaveBeenLastCalledWith({ type: 'shell/openNode', nodeId: 'n1' });
  });

  it('Enter on a button does not open', () => {
    byId('btn-open').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(postMessage).not.toHaveBeenCalled();
  });

  it('Escape clears the selection and shows the empty text; Enter then posts nothing', () => {
    key('Escape');
    expect(postMessage).toHaveBeenCalledWith({ type: 'shell/selectNode', nodeId: null });
    expect(byId('details-empty').hidden).toBe(false);
    expect(byId('details-empty').textContent).toBe('Select a node to see its details');
    expect(byId('details-fields').hidden).toBe(true);
    expect(shell().getSelectedNodeId()).toBeNull();
    postMessage.mockClear();
    key('Enter');
    byId('btn-open').click();
    expect(postMessage).not.toHaveBeenCalled();
  });

  it('Escape on a focused button still clears the selection', () => {
    node.click();
    postMessage.mockClear();
    byId('btn-details').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(postMessage).toHaveBeenCalledWith({ type: 'shell/selectNode', nodeId: null });
    expect(shell().getSelectedNodeId()).toBeNull();
  });

  it('shell/selection null renders the empty text', () => {
    send({ type: 'shell/selection', node: { kind: 'function', name: 'x', location: 'a:1' } });
    send({ type: 'shell/selection', node: null });
    expect(byId('details-empty').hidden).toBe(false);
    expect(byId('details-fields').hidden).toBe(true);
    expect(byId('btn-open').hidden).toBe(true);
  });

  it('Details toggles the region', () => {
    byId('btn-details').click();
    expect(byId('details').hidden).toBe(true);
    byId('btn-details').click();
    expect(byId('details').hidden).toBe(false);
  });
});
