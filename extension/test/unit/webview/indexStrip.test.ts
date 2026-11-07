// @vitest-environment jsdom
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import type { GraphToWebview } from '../../../src/graph/messages';
import type { IndexToWebview } from '../../../src/index/messages';
import type { ShellToWebview } from '../../../src/panel/messages';
import { getHtml } from '../../../src/panel/graphPanel';
import { stripView } from '../../../media/indexStrip';
import { Uri } from '../mocks/vscode';

vi.mock('cytoscape', async (original) => (await import('../fakes/headlessCytoscape')).headlessCytoscape(original));

const done = (indexed: number, failed: number, skipped: number) =>
  ({ type: 'index/done', outcome: 'complete', indexed, failed, skipped, hadGraph: false }) as const;

describe('stripView', () => {
  it('scanning → Scanning workspace… with Cancel only', () => {
    expect(stripView({ type: 'index/progress', phase: 'scanning', done: 0, total: 0 })).toEqual({
      text: 'Scanning workspace…',
      cancel: true,
      showLog: false,
      dismiss: false,
    });
  });

  it('indexing → Indexing N of M files with Cancel only', () => {
    expect(stripView({ type: 'index/progress', phase: 'indexing', done: 3, total: 10 })).toEqual({
      text: 'Indexing 3 of 10 files',
      cancel: true,
      showLog: false,
      dismiss: false,
    });
  });

  it('complete with nothing failed or skipped → Indexed N files with × only', () => {
    expect(stripView(done(5, 0, 0))).toEqual({ text: 'Indexed 5 files', cancel: false, showLog: false, dismiss: true });
  });

  it('complete with failures → the failed count, Show Log and ×', () => {
    expect(stripView(done(4, 1, 0))).toEqual({ text: 'Indexed 4 files, 1 failed', cancel: false, showLog: true, dismiss: true });
  });

  it('complete with only skipped files → Indexed N files, Show Log and ×', () => {
    expect(stripView(done(5, 0, 2))).toEqual({ text: 'Indexed 5 files', cancel: false, showLog: true, dismiss: true });
  });

  it('cancelled → hidden', () => {
    expect(stripView({ type: 'index/done', outcome: 'cancelled', indexed: 2, failed: 0, skipped: 0, hadGraph: true })).toBeUndefined();
  });
});

// Drives the real media/main.ts against getHtml's markup. Tests run in order and share one page.
describe('webview index strip and overlays (R5, R9, R10)', () => {
  const postMessage = vi.fn();
  const byId = (id: string) => document.getElementById(id)!;
  const send = (data: ShellToWebview | GraphToWebview | IndexToWebview) => window.dispatchEvent(new MessageEvent('message', { data }));
  const overlay = () => (byId('overlay').hidden ? '' : byId('overlay-text').textContent);
  const debugState = () => {
    postMessage.mockClear();
    send({ type: 'graph/debug', op: 'state' });
    return postMessage.mock.calls[0][0] as { strip: string; overlay: string };
  };

  beforeAll(async () => {
    const html = getHtml({ cspSource: 'csp', asWebviewUri: (u) => u }, Uri.file('/ext') as unknown as vscode.Uri, 'n');
    document.body.innerHTML = /<body>([\s\S]*)<\/body>/.exec(html)![1];
    (globalThis as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi = () => ({ postMessage });
    await import('../../../media/main');
  });

  beforeEach(() => postMessage.mockClear());

  it('first run: the indexing overlay and the strip; Cancel posts index/cancel', () => {
    expect((byId('btn-reindex') as HTMLButtonElement).disabled).toBe(true);
    send({ type: 'shell/state', state: 'indexing' });
    expect(overlay()).toBe('Indexing workspace…');
    expect((byId('btn-reindex') as HTMLButtonElement).disabled).toBe(false);
    send({ type: 'index/progress', phase: 'scanning', done: 0, total: 0 });
    expect(debugState()).toMatchObject({ strip: 'Scanning workspace… Cancel', overlay: 'Indexing workspace…' });
    byId('btn-index-cancel').click();
    expect(postMessage).toHaveBeenCalledWith({ type: 'index/cancel' });
  });

  it('a cancelled first run shows Indexing cancelled with its own Re-index; a new run clears it', () => {
    send({ type: 'index/done', outcome: 'cancelled', indexed: 0, failed: 0, skipped: 0, hadGraph: false });
    send({ type: 'shell/state', state: 'ready' });
    expect(debugState()).toMatchObject({ strip: '', overlay: 'Indexing cancelled' });
    expect(byId('btn-cancelled-reindex').hidden).toBe(false);
    postMessage.mockClear();
    byId('btn-cancelled-reindex').click();
    expect(postMessage).toHaveBeenCalledWith({ type: 'index/run' });

    send({ type: 'index/progress', phase: 'indexing', done: 1, total: 4 });
    expect(debugState()).toMatchObject({ strip: 'Indexing 1 of 4 files Cancel', overlay: '' });
    expect(byId('btn-cancelled-reindex').hidden).toBe(true);
  });

  it('the summary shows Show Log and ×; Show Log posts shell/showLog, × only hides', () => {
    send({ type: 'index/done', outcome: 'complete', indexed: 4, failed: 1, skipped: 0, hadGraph: false });
    expect(debugState().strip).toBe('Indexed 4 files, 1 failed Show Log ×');
    postMessage.mockClear();
    byId('link-index-show-log').click();
    expect(postMessage).toHaveBeenCalledWith({ type: 'shell/showLog' });
    postMessage.mockClear();
    byId('btn-index-dismiss').click();
    expect(postMessage).not.toHaveBeenCalled();
    expect(debugState().strip).toBe('');
  });

  it('once a graph is drawn, indexing has no overlay; Re-index posts index/run; a restart hides the strip', () => {
    send({ type: 'graph/refresh', files: { nodes: [], edges: [] }, expanded: [], roots: [] });
    send({ type: 'shell/state', state: 'indexing' });
    send({ type: 'index/progress', phase: 'scanning', done: 0, total: 0 });
    expect(debugState()).toMatchObject({ strip: 'Scanning workspace… Cancel', overlay: '' });
    postMessage.mockClear();
    byId('btn-reindex').click();
    expect(postMessage).toHaveBeenCalledWith({ type: 'index/run' });

    send({ type: 'shell/state', state: 'starting' });
    expect(debugState().strip).toBe('');
    expect((byId('btn-reindex') as HTMLButtonElement).disabled).toBe(true);
  });
});
