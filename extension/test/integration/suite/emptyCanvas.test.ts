import * as assert from 'node:assert';
import * as vscode from 'vscode';
import type { Shell } from '../../../src/extension';
import { activateShell, canvasState, waitFor } from './shell';

// A workspace with no supported file (`fixtures/workspace2`, only README.txt) shows the empty state (R10).
suite('graph canvas over an empty workspace', () => {
  let shell: Shell;

  suiteSetup(async () => {
    shell = await activateShell();
    await vscode.commands.executeCommand('codeMatrix.openGraph');
    await waitFor(() => shell.manager.state.kind === 'ready', 'sidecar ready', 15_000);
  });

  suiteTeardown(() => shell?.panel()?.dispose());

  test('no nodes, the empty text and 0 nodes · 0 edges', async () => {
    const s = await canvasState(shell, (x) => x.emptyText !== '', 'the empty state');
    assert.deepStrictEqual(s.nodes, []);
    assert.strictEqual(s.emptyText, 'No supported source files found');
    assert.strictEqual(s.counts, '0 nodes · 0 edges');
  });
});
