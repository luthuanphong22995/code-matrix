import * as assert from 'node:assert';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Shell } from '../../../src/extension';
import type { DebugState } from '../../../src/graph/messages';
import { activateShell, canvasState, capturePosts, waitFor } from './shell';

// The tree pane over `<repo>/fixtures/go` (root `go`), driven through `Shell.graph.debug`. Tests run in order and
// share one panel until the last reopens it.
suite('node tree over fixtures/go', () => {
  let shell: Shell;
  let restorePosts: (() => void) | undefined;
  const posted: Array<{ type: string }> = [];

  const fileId = (s: DebugState, name: string) => {
    const node = s.nodes.find((n) => n.kind === 'file' && n.name === name);
    assert.ok(node, `${name} not drawn`);
    return node.id;
  };
  const ids = (s: DebugState) => s.nodes.map((n) => n.id).sort();
  // A symbol the tree or canvas loaded, by name and file (the registry holds every node either one received).
  const symbolId = (name: string, file: string) => {
    const rec = [...shell.nodes.values()].find((r) => r.name === name && path.basename(r.path) === file);
    assert.ok(rec, `${name} in ${file} not registered`);
    return rec.id;
  };

  suiteSetup(async () => {
    shell = await activateShell();
    await vscode.commands.executeCommand('codeMatrix.openGraph');
    await waitFor(() => shell.manager.state.kind === 'ready', 'sidecar ready', 15_000);
  });

  suiteTeardown(async () => {
    restorePosts?.();
    shell?.panel()?.dispose();
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  test('on open the pane is shown with the root row and Tree pressed (R1, R2)', async () => {
    const s = await canvasState(shell, (x) => x.tree.rows.includes('[root] go'), 'the root row');
    assert.deepStrictEqual({ shown: s.tree.shown, pressed: s.tree.pressed, disabled: s.tree.disabled }, { shown: true, pressed: true, disabled: false });
    assert.ok(s.tree.rows.includes('  [file] main.go'), JSON.stringify(s.tree.rows));
    assert.ok(s.tree.rows.includes('  [dir] internal'), JSON.stringify(s.tree.rows));
  });

  test('expanding main.go in the tree lists its functions and leaves the canvas alone (R8)', async () => {
    const before = await canvasState(shell, (x) => x.nodes.length === 6, 'the file layer');
    await shell.graph.debug({ op: 'treeExpand', id: fileId(before, 'main.go') });
    const s = await canvasState(shell, (x) => x.tree.rows.includes('    [fn] main'), 'main.go symbols in the tree');
    assert.deepStrictEqual(ids(s), ids(before));
    assert.strictEqual(shell.graph.expandedFiles.size, 0);
    assert.ok(s.tree.rows.some((r) => r.startsWith('Unresolved (')), JSON.stringify(s.tree.rows));
  });

  test('a tree click on main expands main.go on the canvas, selects and centres it; a filtered node only gets the note (R9)', async () => {
    const main = symbolId('main', 'main.go');
    await shell.graph.debug({ op: 'treeClick', id: main });
    let s = await canvasState(shell, (x) => x.narrowing.centredOn === main && x.details.includes('Name main'), 'main selected and centred');
    const mainGo = fileId(s, 'main.go');
    assert.ok(shell.graph.expandedFiles.has(mainGo));
    assert.strictEqual(shell.panel()!.selectedNodeId, main);
    assert.strictEqual(s.tree.selected, '[fn] main');

    await shell.graph.debug({ op: 'toggle', id: mainGo });
    await shell.graph.debug({ op: 'kind', kind: 'function', on: false });
    s = await shell.graph.debug({ op: 'treeExpand', id: fileId(s, 'util.go') });
    s = await canvasState(shell, (x) => x.tree.rows.includes('    [fn] readFile'), 'util.go symbols in the tree');
    const before = ids(s);
    await shell.graph.debug({ op: 'treeClick', id: symbolId('readFile', 'util.go') });
    s = await canvasState(shell, (x) => x.details.includes('Hidden by current filters'), 'the hidden note');
    assert.deepStrictEqual(ids(s), before);
    assert.strictEqual(shell.graph.expandedFiles.size, 0);
    assert.ok(s.details.includes('Name readFile'), JSON.stringify(s.details));
    await shell.graph.debug({ op: 'kind', kind: 'function', on: true });
    await shell.graph.debug({ op: 'treeExpand', id: fileId(s, 'util.go') });
  });

  test('a canvas tap reveals the row while the pane is shown, not while hidden (R10)', async () => {
    let s = await canvasState(shell, () => true, 'state');
    const configGo = fileId(s, 'config.go');
    await shell.graph.debug({ op: 'toggle', id: configGo });
    s = await canvasState(shell, (x) => x.nodes.some((n) => n.name === 'parseConfig'), 'config.go expanded');
    assert.ok(!s.tree.rows.includes('    [fn] parseConfig'), 'config.go starts collapsed in the tree');
    s = await shell.graph.debug({ op: 'tap', id: symbolId('parseConfig', 'config.go') });
    assert.strictEqual(s.tree.selected, '[fn] parseConfig');
    assert.ok(s.tree.rows.includes('    [fn] parseConfig'), JSON.stringify(s.tree.rows));

    await shell.graph.debug({ op: 'treeToggle' });
    await shell.graph.debug({ op: 'tap', id: configGo });
    s = await shell.graph.debug({ op: 'treeToggle' });
    assert.strictEqual(s.tree.selected, null);
    await shell.graph.debug({ op: 'toggle', id: configGo });
  });

  test('Enter on a tree row opens its source beside the graph; on a placeholder it opens nothing (R11)', async () => {
    const main = symbolId('main', 'main.go');
    await shell.graph.debug({ op: 'treeClick', id: main });
    await shell.graph.debug({ op: 'treeKey', key: 'Enter' });
    const editor = () =>
      vscode.window.visibleTextEditors.find((e) => path.basename(e.document.uri.fsPath) === 'main.go' && e.viewColumn !== shell.panel()!.panel.viewColumn);
    await waitFor(() => editor()?.selection.active.line === shell.nodes.get(main)!.range.startLine, 'main.go open beside at main', 5_000);

    await shell.graph.debug({ op: 'treeExpand', id: 'group:unresolved' });
    const listed = (x: DebugState) => x.nodes.find((n) => n.kind === 'unresolved' && x.tree.rows.includes(`  [?] ${n.name}`));
    let s = await canvasState(shell, (x) => listed(x) !== undefined, 'a placeholder row');
    const placeholder = listed(s);
    assert.ok(placeholder, JSON.stringify(s.tree.rows));
    const open = () => vscode.window.visibleTextEditors.map((e) => e.document.uri.toString()).sort();
    const before = open();
    await shell.graph.debug({ op: 'treeClick', id: placeholder.id });
    s = await shell.graph.debug({ op: 'treeKey', key: 'Enter' });
    assert.strictEqual(s.tree.selected, `[?] ${placeholder.name}`);
    await new Promise((r) => setTimeout(r, 500));
    assert.deepStrictEqual(open(), before);
    await shell.graph.debug({ op: 'treeExpand', id: 'group:unresolved' });
    await shell.graph.debug({ op: 'toggle', id: fileId(s, 'main.go') });
  });

  test('expanding main lists Calls (N); a linked row selects its node on the canvas and in Details, Enter opens it (R7, R9, R11)', async () => {
    const main = symbolId('main', 'main.go');
    await shell.graph.debug({ op: 'treeExpand', id: main });
    await canvasState(shell, (x) => x.tree.rows.some((r) => /^ {6}Calls \(\d+\)$/.test(r)), 'main’s Calls group');
    // Links load through the registry only: the canvas expansion is untouched (R8).
    assert.strictEqual(shell.graph.expandedFiles.size, 0);
    const parseConfig = symbolId('parseConfig', 'config.go');
    await shell.graph.debug({ op: 'treeExpand', id: `links:${main}:calls` });
    let s = await canvasState(shell, (x) => x.tree.rows.includes('        [fn] parseConfig  config.go:14'), 'main’s callees');
    assert.ok(s.tree.rows.includes('        [fn] readFile  util.go:3'), JSON.stringify(s.tree.rows));
    assert.ok(s.tree.rows.includes('        [?] fetchData  unresolved'), JSON.stringify(s.tree.rows));

    await shell.graph.debug({ op: 'treeClick', id: `link:${main}:calls:${parseConfig}` });
    s = await canvasState(shell, (x) => x.details.includes('Name parseConfig') && x.nodes.some((n) => n.id === parseConfig), 'parseConfig selected');
    const configGo = fileId(s, 'config.go');
    assert.deepStrictEqual([...shell.graph.expandedFiles], [configGo]);
    assert.strictEqual(shell.panel()!.selectedNodeId, parseConfig);
    assert.strictEqual(s.tree.selected, '[fn] parseConfig  config.go:14');

    await shell.graph.debug({ op: 'treeKey', key: 'Enter' });
    const editor = () =>
      vscode.window.visibleTextEditors.find((e) => path.basename(e.document.uri.fsPath) === 'config.go' && e.viewColumn !== shell.panel()!.panel.viewColumn);
    await waitFor(() => editor()?.selection.active.line === shell.nodes.get(parseConfig)!.range.startLine, 'config.go open beside at parseConfig', 5_000);
    await shell.graph.debug({ op: 'toggle', id: configGo });
    await shell.graph.debug({ op: 'treeExpand', id: main });
  });

  test('Tree hides the pane, and a re-index keeps it hidden (R1)', async () => {
    restorePosts = capturePosts(shell.panel()!.panel.webview, posted);
    let s = await shell.graph.debug({ op: 'treeToggle' });
    assert.deepStrictEqual({ shown: s.tree.shown, pressed: s.tree.pressed }, { shown: false, pressed: false });

    const mark = posted.length;
    await vscode.commands.executeCommand('codeMatrix.reindex');
    await waitFor(() => posted.slice(mark).some((m) => m.type === 'graph/refresh'), 'graph/refresh after re-index', 15_000);
    s = await canvasState(shell, () => true, 'state');
    assert.deepStrictEqual({ shown: s.tree.shown, pressed: s.tree.pressed }, { shown: false, pressed: false });
  });

  test('closing and reopening the panel shows the pane again (R1)', async () => {
    shell.panel()!.dispose();
    await vscode.commands.executeCommand('codeMatrix.openGraph');
    const s = await canvasState(shell, (x) => x.tree.rows.includes('[root] go'), 'the reopened tree');
    assert.deepStrictEqual({ shown: s.tree.shown, pressed: s.tree.pressed }, { shown: true, pressed: true });
  });
});
