import * as assert from 'node:assert';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Shell } from '../../../src/extension';
import type { DebugState } from '../../../src/graph/messages';
import { activateShell, canvasState, waitFor } from './shell';

// The canvas over `<repo>/fixtures/go`, driven through `Shell.graph.debug` (tap / toggle run the user paths).
// Ids are read from the canvas, never hard-coded. Tests run in order and share one panel.
suite('graph canvas over fixtures/go', () => {
  let shell: Shell;

  const idOf = (s: DebugState, name: string) => {
    const node = s.nodes.find((n) => n.name === name);
    assert.ok(node, `${name} not drawn`);
    return node.id;
  };
  const nameOf = (s: DebugState, id: string) => s.nodes.find((n) => n.id === id)?.name;
  const edgeLines = (s: DebugState) =>
    s.edges.map((e) => `${e.kind} ${nameOf(s, e.fromId)} → ${nameOf(s, e.toId)}${e.resolved ? '' : ' (unresolved)'}`).sort();
  const has = (s: DebugState, name: string) => s.nodes.some((n) => n.name === name);
  const debug = (op: 'tap' | 'toggle', s: DebugState, name: string) => shell.graph.debug({ op, id: idOf(s, name) });

  suiteSetup(async () => {
    shell = await activateShell();
    await vscode.commands.executeCommand('codeMatrix.openGraph');
    await waitFor(() => shell.manager.state.kind === 'ready', 'sidecar ready', 15_000);
  });

  suiteTeardown(async () => {
    shell?.panel()?.dispose();
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  test('the default view is the file layer: files, imports and the import placeholder (R1, R4)', async () => {
    const s = await canvasState(shell, (x) => x.nodes.length === 6, 'the file layer');
    assert.deepStrictEqual(
      s.nodes.filter((n) => n.kind === 'file').map((n) => n.name).sort(),
      ['broken/broken.go', 'config.go', 'internal/db/conn.go', 'main.go', 'util.go'],
    );
    assert.deepStrictEqual(s.nodes.filter((n) => n.kind === 'unresolved').map((n) => n.name), ['fmt']);
    assert.deepStrictEqual(edgeLines(s), ['imports config.go → internal/db/conn.go', 'imports main.go → fmt (unresolved)']);
    assert.strictEqual(s.counts, '6 nodes · 2 edges');
    for (const n of s.nodes.filter((x) => x.kind !== 'unresolved')) assert.ok(shell.nodes.has(n.id), `${n.name} not registered`);
  });

  test('expand draws a subtree and cross-file calls only while both ends are drawn (R2, R4)', async () => {
    let s = await canvasState(shell, () => true, 'state');
    await debug('toggle', s, 'config.go');
    s = await canvasState(shell, (x) => has(x, 'parseConfig'), 'config.go expanded');
    assert.ok(edgeLines(s).includes('contains config.go → parseConfig'));

    await debug('toggle', s, 'main.go');
    s = await canvasState(shell, (x) => has(x, 'main') && has(x, 'fetchData'), 'main.go expanded');
    assert.ok(edgeLines(s).includes('calls main → parseConfig'));
    assert.ok(edgeLines(s).includes('calls main → fetchData (unresolved)'));
    assert.strictEqual(s.nodes.find((n) => n.name === 'fetchData')!.kind, 'unresolved');
    for (const n of s.nodes.filter((x) => x.kind !== 'unresolved')) assert.ok(shell.nodes.has(n.id), `${n.name} not registered`);

    await debug('toggle', s, 'main.go');
    s = await canvasState(shell, (x) => !has(x, 'main'), 'main.go collapsed');
    assert.ok(!has(s, 'fetchData'));
    assert.ok(!edgeLines(s).some((l) => l.startsWith('calls main ')));
    assert.ok(has(s, 'parseConfig'));
  });

  test('tap selects through the shell; Details shows fields and edge counts; open goes beside (R8, R12)', async () => {
    let s = await canvasState(shell, () => true, 'state');
    const id = idOf(s, 'parseConfig');
    await debug('tap', s, 'parseConfig');
    assert.strictEqual(shell.panel()!.selectedNodeId, id);
    s = await canvasState(shell, (x) => x.details.includes('in · calls: 1'), 'parseConfig details');
    for (const line of ['Kind function', 'Name parseConfig', 'Location config.go:14', 'in · contains: 1', 'in · calls: 1']) {
      assert.ok(s.details.includes(line), `missing ${line} in ${JSON.stringify(s.details)}`);
    }

    shell.panel()!.handleMessage({ type: 'shell/openNode', nodeId: id });
    const editor = () =>
      vscode.window.visibleTextEditors.find(
        (e) => path.basename(e.document.uri.fsPath) === 'config.go' && e.viewColumn !== shell.panel()!.panel.viewColumn,
      );
    await waitFor(() => editor()?.selection.active.line === 13, 'config.go open beside at line 14', 5_000);
  });

  test('a file shows Expand / Collapse, which runs the handle path', async () => {
    let s = await canvasState(shell, () => true, 'state');
    await debug('tap', s, 'config.go');
    s = await canvasState(shell, (x) => x.details.includes('Collapse'), 'Collapse button');
    await debug('toggle', s, 'config.go');
    s = await canvasState(shell, (x) => x.details.includes('Expand'), 'Expand button');
    assert.ok(!has(s, 'parseConfig'));
  });

  test('a placeholder shows Kind unresolved and its name, no Location, no Open, no empty text (R4, R12)', async () => {
    let s = await canvasState(shell, () => true, 'state');
    await debug('toggle', s, 'main.go');
    s = await canvasState(shell, (x) => has(x, 'fetchData'), 'main.go expanded');
    await debug('tap', s, 'fetchData');
    s = await canvasState(shell, (x) => x.details.includes('Name fetchData'), 'fetchData details');
    assert.ok(s.details.includes('Kind unresolved'));
    assert.ok(!s.details.some((l) => l.startsWith('Location')));
    assert.ok(!s.details.includes('Open in editor'));
    assert.ok(!s.details.includes('Select a node to see its details'));
  });

  test('Group draws folder boxes without changing the graph; a path glob hides empty boxes', async () => {
    const before = await canvasState(shell, () => true, 'state');
    await shell.graph.debug({ op: 'click', id: 'nar-group' });
    let s = await canvasState(shell, (x) => x.grouped, 'grouped');
    assert.deepStrictEqual(s.folders, [
      { label: 'broken', parent: null },
      { label: 'internal/db', parent: null },
    ]);
    assert.deepStrictEqual(s.nodes, before.nodes);
    assert.strictEqual(s.counts, before.counts);
    await shell.graph.debug({ op: 'path', text: 'internal/**' });
    s = await canvasState(shell, (x) => x.folders.length === 1, 'one folder');
    assert.deepStrictEqual(s.folders, [{ label: 'internal/db', parent: null }]);
    await shell.graph.debug({ op: 'path', text: '' });
    await shell.graph.debug({ op: 'click', id: 'nar-group' });
    s = await canvasState(shell, (x) => !x.grouped, 'ungrouped');
    assert.deepStrictEqual(s.folders, []);
  });
});
