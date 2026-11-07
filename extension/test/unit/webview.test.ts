import { describe, expect, it } from 'vitest';
import type * as vscode from 'vscode';
import { CLICKS, viewFor } from '../../media/main';
import { getHtml } from '../../src/panel/graphPanel';
import { Uri } from './mocks/vscode';

const uri = (p: string) => Uri.file(p) as unknown as vscode.Uri;

describe('viewFor', () => {
  it('starting shows the starting overlay with buttons disabled', () => {
    expect(viewFor('starting')).toEqual({
      overlay: 'Starting Code Matrix server…',
      buttonsEnabled: false,
      stateText: 'starting',
      actions: false,
      reindex: false,
    });
  });
  it('indexing with no graph drawn shows the indexing overlay with buttons enabled', () => {
    expect(viewFor('indexing')).toEqual({
      overlay: 'Indexing workspace…',
      buttonsEnabled: true,
      stateText: 'indexing',
      actions: false,
      reindex: true,
    });
  });
  it('indexing once a graph is drawn has no overlay: the previous graph stays under the strip (R5)', () => {
    expect(viewFor('indexing', undefined, { drawn: true, cancelled: false })).toEqual({
      overlay: undefined,
      buttonsEnabled: true,
      stateText: 'indexing',
      actions: false,
      reindex: true,
    });
  });
  it('ready hides the overlay', () => {
    expect(viewFor('ready')).toEqual({ overlay: undefined, buttonsEnabled: true, stateText: 'ready', actions: false, reindex: true });
  });
  it('ready after a cancelled first run shows Indexing cancelled with its own Re-index (R9)', () => {
    expect(viewFor('ready', undefined, { drawn: false, cancelled: true })).toEqual({
      overlay: 'Indexing cancelled',
      buttonsEnabled: true,
      stateText: 'ready',
      actions: false,
      reindex: true,
      cancelled: true,
    });
  });
  it('failed shows the failure heading, the cause and the Retry / Show Log actions (R6, R11)', () => {
    expect(viewFor('failed', 'Process exited with code 101')).toEqual({
      overlay: 'Process exited with code 101',
      heading: 'Code Matrix server failed',
      buttonsEnabled: true,
      stateText: 'failed',
      actions: true,
      reindex: false,
    });
  });
  it('Re-index is enabled only in ready and indexing', () => {
    expect((['starting', 'indexing', 'ready', 'failed'] as const).filter((s) => viewFor(s).reindex)).toEqual(['indexing', 'ready']);
  });
});

describe('CLICKS', () => {
  it('maps each button to exactly its message', () => {
    expect(CLICKS).toEqual({
      'btn-retry': { type: 'shell/retry' },
      'btn-failed-showlog': { type: 'shell/showLog' },
      'btn-showlog': { type: 'shell/showLog' },
      'btn-restart': { type: 'shell/restart' },
      'btn-reindex': { type: 'index/run' },
      'btn-cancelled-reindex': { type: 'index/run' },
    });
  });
});

describe('getHtml', () => {
  const html = getHtml({ cspSource: 'vscode-webview://csp', asWebviewUri: (u) => u }, uri('/ext'), 'abc123');

  it('locks down the CSP to the nonce and cspSource', () => {
    expect(html).toContain(`default-src 'none'; script-src 'nonce-abc123'; style-src vscode-webview://csp;`);
    expect(html).toContain('<script nonce="abc123" src="file:///ext/dist/webview.js"></script>');
    expect(html).toContain('href="file:///ext/dist/webview.css"');
    expect(html).not.toMatch(/ on\w+=/);
  });

  it('draws the stable region ids and the empty details text', () => {
    for (const id of ['toolbar', 'state-text', 'toolbar-slot', 'btn-restart', 'btn-showlog', 'btn-details', 'main', 'overlay', 'details']) {
      expect(html).toContain(`id="${id}"`);
    }
    expect(html).toContain('Select a node to see its details');
  });

  it('draws Re-index left of Restart Server, the hidden index strip and the cancelled overlay Re-index', () => {
    expect(html).toMatch(/<button id="btn-reindex" disabled>Re-index<\/button>\s*<button id="btn-restart"/);
    expect(html).toContain(
      '<div id="index-strip" hidden><span id="text-index-progress"></span><button id="btn-index-cancel">Cancel</button><a id="link-index-show-log" href="#">Show Log</a><button id="btn-index-dismiss" title="Dismiss">×</button></div>',
    );
    expect(html).toMatch(/<\/div>\s*<button id="btn-cancelled-reindex" hidden>Re-index<\/button>/);
  });

  it('stacks #index-strip then a hidden #flow-strip inside #strips, before the overlay', () => {
    expect(html).toMatch(/<div id="strips">\s*<div id="index-strip" hidden>[\s\S]*?<\/div>\s*<div id="flow-strip" hidden>/);
    expect(html).toContain(
      '<div id="flow-strip" hidden><button id="btn-trace-prev">Prev</button><button id="btn-trace-next">Next</button><span id="text-trace-status"></span><button id="btn-trace-clear">Clear trace</button></div>\n      </div>\n      <div id="overlay">',
    );
  });

  it('draws the hidden failed actions: exactly Retry and Show Log', () => {
    expect(html).toContain(
      '<div id="overlay-actions" hidden><button id="btn-retry">Retry</button><button id="btn-failed-showlog">Show Log</button></div>',
    );
  });
});
