import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Shell } from '../../../src/extension';
import type { DebugOp, DebugState } from '../../../src/graph/messages';
import { activateShell, canvasState, capturePosts, waitFor } from './shell';

// Refresh after a sidecar restart (R11) over a throwaway copy of `fixtures/go` (runTest.ts): the view survives for
// nodes that still exist; a deleted file takes its symbols, the selection and focus with it. Tests run in order.
suite('graph refresh over a copy of fixtures/go', () => {
  let shell: Shell;
  let restorePosts: () => void;
  const posted: Array<{ type: string }> = [];
  // The drawn node set with util.go expanded and references off, before focus (3.3), for 3.4.
  let n0: string[] = [];

  const names = (s: DebugState) => s.nodes.map((n) => n.name).sort();
  const ids = (s: DebugState) => s.nodes.map((n) => n.id).sort();
  const nameOf = (s: DebugState, id: string) => s.nodes.find((n) => n.id === id)?.name;
  const idOf = (s: DebugState, name: string) => {
    const node = s.nodes.find((n) => n.name === name && n.kind !== 'unresolved');
    assert.ok(node, `${name} not drawn`);
    return node.id;
  };
  const has = (s: DebugState, name: string) => s.nodes.some((n) => n.name === name);
  const edgeLines = (s: DebugState) =>
    s.edges.map((e) => `${e.kind} ${nameOf(s, e.fromId)} → ${nameOf(s, e.toId)}${e.resolved ? '' : ' (unresolved)'}`);
  const op = (o: DebugOp) => shell.graph.debug(o);
  const state = () => canvasState(shell, () => true, 'state');
  const expand = async (file: string, symbol: string) => {
    const s = await state();
    if (has(s, symbol)) return s;
    await op({ op: 'toggle', id: idOf(s, file) });
    return canvasState(shell, (x) => has(x, symbol), `${file} expanded`);
  };
  // Restarts the sidecar and waits for the graph/refresh its re-index sends.
  const restart = async () => {
    const mark = posted.length;
    await vscode.commands.executeCommand('codeMatrix.restartServer');
    await waitFor(
      () => posted.slice(mark).some((m) => m.type === 'graph/refresh') && shell.manager.state.kind === 'ready',
      'graph/refresh after restart',
      20_000,
    );
  };

  suiteSetup(async () => {
    shell = await activateShell();
    await vscode.commands.executeCommand('codeMatrix.openGraph');
    await waitFor(() => shell.manager.state.kind === 'ready', 'sidecar ready', 15_000);
    await canvasState(shell, (x) => x.nodes.some((n) => n.kind === 'file'), 'the file layer');
    restorePosts = capturePosts(shell.panel()!.panel.webview, posted);
  });

  suiteTeardown(async () => {
    restorePosts?.();
    shell?.panel()?.dispose();
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  test('a restart keeps expansion, kinds and the selection; Details counts are current (R11)', async () => {
    await expand('config.go', 'parseConfig');
    let s = await expand('main.go', 'main');
    await op({ op: 'tap', id: idOf(s, 'parseConfig') });
    s = await op({ op: 'kind', kind: 'references', on: true });
    const before = ids(s);
    const parseConfig = idOf(s, 'parseConfig');

    await restart();
    s = await canvasState(shell, (x) => x.details.includes('in · calls: 1'), 'parseConfig details after restart');
    assert.deepStrictEqual(ids(s), before);
    assert.strictEqual(idOf(s, 'parseConfig'), parseConfig);
    assert.ok(s.details.includes('Name parseConfig'), JSON.stringify(s.details));
    assert.strictEqual(s.narrowing.kinds.references, true);
    assert.ok(edgeLines(s).includes('references main → Config'), JSON.stringify(edgeLines(s)));
    assert.ok(edgeLines(s).includes('references parseConfig → Config'), JSON.stringify(edgeLines(s)));
    assert.strictEqual(shell.panel()!.selectedNodeId, parseConfig);
  });

  test('focus survives a restart with its node (R8, R11)', async () => {
    await op({ op: 'kind', kind: 'references', on: false });
    let s = await expand('util.go', 'readFile');
    n0 = ids(s);
    await op({ op: 'tap', id: idOf(s, 'main') });
    s = await op({ op: 'focus' });
    const oneHop = ['Validate', 'fetchData', 'fmt.Println', 'main', 'main.go', 'parseConfig', 'readFile'].sort();
    assert.deepStrictEqual(names(s), oneHop);

    await restart();
    s = await canvasState(shell, (x) => x.narrowing.focused && x.nodes.length === oneHop.length, 'focused after restart');
    assert.strictEqual(s.narrowing.hops, 1);
    assert.deepStrictEqual(names(s), oneHop);
  });

  test('a deleted focused node clears selection and focus; its file and symbols leave canvas and registry (R11)', async () => {
    let s = await state();
    await op({ op: 'tap', id: idOf(s, 'parseConfig') });
    s = await canvasState(shell, (x) => x.narrowing.focused && has(x, 'parseEnv'), 'focus on parseConfig');
    const parseConfig = idOf(s, 'parseConfig');
    assert.strictEqual(s.tree.selected, '[fn] parseConfig');
    const configGo = idOf(s, 'config.go');
    // config.go and its subtree, by registered path (placeholders are never registered).
    const subtree = new Set(n0.filter((id) => path.basename(shell.nodes.get(id)?.path ?? '') === 'config.go'));
    assert.ok(subtree.has(configGo) && subtree.has(parseConfig));

    fs.rmSync(path.join(vscode.workspace.workspaceFolders![0].uri.fsPath, 'config.go'));
    await restart();
    s = await canvasState(shell, (x) => !x.narrowing.focused && !x.nodes.some((n) => n.id === configGo), 'focus left after delete');
    assert.ok(s.details.includes('Select a node to see its details'), JSON.stringify(s.details));
    assert.strictEqual(shell.panel()!.selectedNodeId, null);
    // The tree drops the selection with its node (node-tree R12).
    assert.strictEqual(s.tree.selected, null);
    assert.ok(!s.tree.rows.some((r) => r.trim() === '[fn] parseConfig'), JSON.stringify(s.tree.rows));
    for (const id of [parseConfig, configGo]) {
      assert.ok(!s.nodes.some((n) => n.id === id), `${id} still drawn`);
      assert.ok(!shell.nodes.has(id), `${id} still registered`);
    }
    const placeholder = s.nodes.filter((n) => n.name === 'parseConfig');
    assert.deepStrictEqual(placeholder.map((n) => n.kind), ['unresolved']);
    assert.notStrictEqual(placeholder[0].id, parseConfig);
    assert.deepStrictEqual(ids(s), [...n0.filter((id) => !subtree.has(id)), placeholder[0].id].sort());
    const lines = edgeLines(s);
    assert.ok(lines.includes('calls main → parseConfig (unresolved)'), JSON.stringify(lines));
    assert.ok(!lines.includes('imports config.go → internal/db/conn.go'));
    assert.deepStrictEqual(
      s.nodes.filter((n) => n.kind === 'file').map((n) => n.name).sort(),
      ['broken/broken.go', 'internal/db/conn.go', 'main.go', 'util.go'],
    );
  });
});
