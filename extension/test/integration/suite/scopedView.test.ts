import * as assert from 'node:assert';
import * as vscode from 'vscode';
import type { Shell } from '../../../src/extension';
import type { DebugState } from '../../../src/graph/messages';
import { activateShell, canvasState, waitFor } from './shell';

// Scoped view over `<repo>/fixtures/go` with `codeMatrix.graph.scopeThreshold` set to 1 (code-graph R13–R21,
// node-tree R16). Tests run in order on one panel; the threshold is restored at the end.
suite('scoped view over fixtures/go', () => {
  let shell: Shell;
  const ids: Record<string, string> = {};
  const threshold = () => vscode.workspace.getConfiguration('codeMatrix.graph');
  const names = (s: DebugState) => s.nodes.map((n) => n.name).sort();
  const prompt = /^Large graph \(\d+ nodes\)\. Select a node in the tree to show its graph\.$/;

  suiteSetup(async () => {
    shell = await activateShell();
    await vscode.commands.executeCommand('codeMatrix.openGraph');
    await waitFor(() => shell.manager.state.kind === 'ready', 'sidecar ready', 15_000);
    const s = await canvasState(shell, (x) => x.nodes.some((n) => n.name === 'config.go'), 'the file layer');
    for (const n of s.nodes) ids[n.name] = n.id;
    await shell.graph.debug({ op: 'escape' });
  });

  suiteTeardown(async () => {
    await threshold().update('scopeThreshold', undefined, vscode.ConfigurationTarget.Global);
    shell?.panel()?.dispose();
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  test('a threshold below the node count switches to the scoped prompt without re-indexing (R13, R16, R19)', async () => {
    await threshold().update('scopeThreshold', 1, vscode.ConfigurationTarget.Global);
    const s = await canvasState(shell, (x) => prompt.test(x.narrowing.canvasText), 'the scoped prompt');
    assert.deepStrictEqual(s.nodes, []);
    assert.strictEqual(s.narrowing.focusEnabled, false);
  });

  test('a tree click on config.go draws its symbols and import, not unrelated files (R14, node-tree R16)', async () => {
    await shell.graph.debug({ op: 'treeClick', id: ids['config.go'] });
    const s = await canvasState(shell, (x) => names(x).includes('parseConfig'), 'config.go neighbourhood');
    assert.ok(names(s).includes('internal/db/conn.go'), JSON.stringify(names(s)));
    assert.ok(!names(s).includes('util.go'), JSON.stringify(names(s)));
    assert.ok(!s.details.includes('Hidden by current filters'));
    assert.strictEqual(shell.graph.expandedFiles.size, 0);
  });

  test('Hops 2 reaches the caller of parseConfig (R14, R20)', async () => {
    await shell.graph.debug({ op: 'hops', n: 2 });
    const s = await canvasState(shell, (x) => names(x).includes('main'), 'main at 2 hops');
    assert.strictEqual(s.narrowing.hops, 2);
  });

  test('a canvas tap on conn.go re-scopes to it and reveals its row (R15)', async () => {
    await shell.graph.debug({ op: 'tap', id: ids['internal/db/conn.go'] });
    const s = await canvasState(shell, (x) => x.tree.selected === '[file] conn.go' && !names(x).includes('main'), 'conn.go scope');
    assert.ok(names(s).includes('config.go'), JSON.stringify(names(s)));
  });

  test('a folder click leaves the scope unchanged (R21)', async () => {
    const before = names(await shell.graph.debug({ op: 'state' }));
    const s = await shell.graph.debug({ op: 'treeClick', id: 'dir:internal' });
    assert.deepStrictEqual(names(s), before);
  });

  test('restoring the threshold returns to the full file layer (R1, R18)', async () => {
    await threshold().update('scopeThreshold', undefined, vscode.ConfigurationTarget.Global);
    const s = await canvasState(shell, (x) => x.narrowing.canvasText === '' && x.nodes.some((n) => n.name === 'util.go'), 'full view');
    assert.ok(s.nodes.every((n) => n.kind === 'file' || n.kind === 'unresolved'), JSON.stringify(s.nodes));
  });
});
