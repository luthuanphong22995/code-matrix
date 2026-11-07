import * as assert from 'node:assert';
import * as vscode from 'vscode';
import type { Shell } from '../../../src/extension';
import { activateShell, canvasState, waitFor } from './shell';

// The 2,500-file Go workspace runTest.ts generates: over the default scope threshold it opens scoped (R13, R16);
// with the threshold raised it is too large to draw until a path glob narrows it (R9, R19).
suite('graph too large', () => {
  const threshold = () => vscode.workspace.getConfiguration('codeMatrix.graph');
  let shell: Shell;

  suiteSetup(async function () {
    this.timeout(90_000);
    shell = await activateShell();
    await vscode.commands.executeCommand('codeMatrix.openGraph');
    await waitFor(() => shell.manager.state.kind === 'ready', 'sidecar ready', 60_000);
  });

  suiteTeardown(async () => {
    await threshold().update('scopeThreshold', undefined, vscode.ConfigurationTarget.Global);
    shell?.panel()?.dispose();
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  test('over the default threshold the canvas opens scoped, drawing nothing until a node is picked (R13, R16)', async function () {
    this.timeout(90_000);
    const s = await canvasState(shell, (x) => x.narrowing.canvasText !== '', 'the scoped prompt', 60_000);
    assert.match(s.narrowing.canvasText, /^Large graph \(\d+ nodes\)\. Select a node in the tree to show its graph\.$/);
    assert.deepStrictEqual(s.nodes, []);
    assert.strictEqual(s.counts, '0 nodes · 0 edges');
  });

  test('with the threshold raised, 2,500 files show the too-large text; src/api/** draws its 300 files', async function () {
    this.timeout(90_000);
    await threshold().update('scopeThreshold', 1_000_000, vscode.ConfigurationTarget.Global);
    let s = await canvasState(shell, (x) => x.narrowing.canvasText.startsWith('Graph too large'), 'the too-large text', 60_000);
    assert.strictEqual(s.narrowing.canvasText, 'Graph too large to render (2500 nodes). Narrow it with a filter.');
    assert.deepStrictEqual(s.nodes, []);
    assert.strictEqual(s.counts, '0 nodes · 0 edges');

    // The toolbar stays enabled: the path filter applies.
    s = await shell.graph.debug({ op: 'path', text: 'src/api/**' });
    assert.strictEqual(s.nodes.length, 300);
    assert.strictEqual(s.counts, '300 nodes · 0 edges');
    assert.strictEqual(s.narrowing.canvasText, '');
  });
});
