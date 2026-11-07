import * as assert from 'node:assert';
import * as vscode from 'vscode';
import type { Shell } from '../../../src/extension';
import type { DebugOp, DebugState } from '../../../src/graph/messages';
import { activateShell, canvasState, waitFor } from './shell';

// Search, path glob, kinds and focus over `<repo>/fixtures/go`, driven through the toolbar's real handlers via
// `Shell.graph.debug`. Runs after canvas.test.js in the same launch; each test starts from the file layer.
suite('graph narrowing over fixtures/go', () => {
  let shell: Shell;

  const names = (s: DebugState) => s.nodes.map((n) => n.name).sort();
  const nameOf = (s: DebugState, id: string) => s.nodes.find((n) => n.id === id)?.name;
  const idOf = (s: DebugState, name: string) => {
    const node = s.nodes.find((n) => n.name === name);
    assert.ok(node, `${name} not drawn`);
    return node.id;
  };
  const has = (s: DebugState, name: string) => s.nodes.some((n) => n.name === name);
  const edgeLines = (s: DebugState) => s.edges.map((e) => `${e.kind} ${nameOf(s, e.fromId)} → ${nameOf(s, e.toId)}`);
  const op = (o: DebugOp) => shell.graph.debug(o);
  const state = () => canvasState(shell, () => true, 'state');
  // A file is expanded when one of its symbols is drawn (default kinds, no filter).
  const SYMBOL: Record<string, string> = { 'main.go': 'main', 'config.go': 'parseConfig', 'util.go': 'readFile' };
  const setExpanded = async (file: string, on: boolean) => {
    const s = await state();
    if (has(s, SYMBOL[file]) === on) return s;
    await op({ op: 'toggle', id: idOf(s, file) });
    return canvasState(shell, (x) => has(x, SYMBOL[file]) === on, `${file} ${on ? 'expanded' : 'collapsed'}`);
  };
  const fileLayer = async () => {
    await op({ op: 'escape' });
    for (const f of Object.keys(SYMBOL)) await setExpanded(f, false);
  };

  suiteSetup(async () => {
    shell = await activateShell();
    await vscode.commands.executeCommand('codeMatrix.openGraph');
    await waitFor(() => shell.manager.state.kind === 'ready', 'sidecar ready', 15_000);
    await canvasState(shell, (x) => x.nodes.some((n) => n.kind === 'file'), 'the file layer');
    await fileLayer();
  });

  suiteTeardown(async () => {
    shell?.panel()?.dispose();
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  test('search halos and centres on matches, case-insensitively; Escape in Search keeps the selection (R6)', async () => {
    let s = await setExpanded('config.go', true);
    s = await op({ op: 'search', text: 'parse' });
    assert.deepStrictEqual(s.narrowing.halos.map((id) => nameOf(s, id)).sort(), ['parseConfig', 'parseEnv']);
    assert.strictEqual(s.narrowing.matchText, '2 matches');
    assert.strictEqual(s.narrowing.centredOn, idOf(s, 'parseConfig'));

    s = await op({ op: 'search', text: 'PARSECONFIG' });
    assert.strictEqual(s.narrowing.matchText, '1 matches');
    assert.deepStrictEqual(s.narrowing.halos, [idOf(s, 'parseConfig')]);

    s = await setExpanded('config.go', false);
    s = await op({ op: 'search', text: 'parseConfig' });
    assert.strictEqual(s.narrowing.matchText, "No matches for 'parseConfig'");
    assert.deepStrictEqual(s.narrowing.halos, []);

    await op({ op: 'tap', id: idOf(s, 'main.go') });
    const selected = shell.panel()!.selectedNodeId;
    assert.ok(selected);
    s = await op({ op: 'searchEscape' });
    assert.strictEqual(s.narrowing.matchText, '');
    assert.deepStrictEqual(s.narrowing.halos, []);
    await new Promise((r) => setTimeout(r, 200));
    assert.strictEqual(shell.panel()!.selectedNodeId, selected);
    await fileLayer();
  });

  test('path glob narrows to matching files; an invalid glob keeps the previous one; kinds toggle (R5, R7)', async () => {
    let s = await state();
    assert.deepStrictEqual(s.narrowing.kinds, {
      file: true,
      class: true,
      function: true,
      contains: true,
      imports: true,
      calls: true,
      references: false,
    });

    s = await op({ op: 'path', text: 'internal/**' });
    assert.deepStrictEqual(names(s), ['internal/db/conn.go']);
    assert.strictEqual(s.counts, '1 nodes · 0 edges');

    s = await op({ op: 'path', text: 'src/[api' });
    assert.strictEqual(s.counts, 'Invalid pattern: src/[api');
    assert.deepStrictEqual(names(s), ['internal/db/conn.go']);

    s = await op({ op: 'path', text: 'docs/**' });
    assert.deepStrictEqual(s.nodes, []);
    assert.strictEqual(s.counts, '0 nodes · 0 edges');
    assert.strictEqual(s.emptyText, '');
    assert.strictEqual(s.narrowing.canvasText, '');

    s = await op({ op: 'path', text: '' });
    assert.strictEqual(s.nodes.filter((n) => n.kind === 'file').length, 5);

    await setExpanded('main.go', true);
    s = await setExpanded('config.go', true);
    s = await op({ op: 'kind', kind: 'function', on: false });
    assert.ok(!s.nodes.some((n) => n.kind === 'function'), JSON.stringify(names(s)));
    assert.ok(!s.edges.some((e) => e.kind === 'calls'));
    for (const p of ['fetchData', 'Validate', 'fmt.Println']) assert.ok(!has(s, p), `${p} still drawn`);

    s = await op({ op: 'kind', kind: 'function', on: true });
    assert.ok(has(s, 'main') && has(s, 'fetchData'));
    assert.ok(!s.edges.some((e) => e.kind === 'references'));
    s = await op({ op: 'kind', kind: 'references', on: true });
    assert.ok(edgeLines(s).includes('references main → Config'), JSON.stringify(edgeLines(s)));
    assert.ok(edgeLines(s).includes('references parseConfig → Config'), JSON.stringify(edgeLines(s)));
    await op({ op: 'kind', kind: 'references', on: false });
    await fileLayer();
  });

  test('focus shows the selected node within hops and restores the previous view (R8)', async () => {
    let s = await state();
    assert.strictEqual(s.narrowing.focusEnabled, false);
    assert.strictEqual(s.narrowing.hopsEnabled, false);

    for (const f of ['main.go', 'config.go', 'util.go']) s = await setExpanded(f, true);
    const before = s.nodes.map((n) => n.id).sort();

    await op({ op: 'tap', id: idOf(s, 'main') });
    s = await op({ op: 'focus' });
    assert.strictEqual(s.narrowing.focused, true);
    assert.strictEqual(s.narrowing.hopsEnabled, true);
    const oneHop = ['Validate', 'fetchData', 'fmt.Println', 'main', 'main.go', 'parseConfig', 'readFile'];
    assert.deepStrictEqual(names(s), oneHop.sort());

    s = await op({ op: 'hops', n: 2 });
    assert.deepStrictEqual(names(s), [...oneHop, 'config.go', 'fmt', 'parseEnv', 'util.go'].sort());

    s = await op({ op: 'focus' });
    assert.strictEqual(s.narrowing.focused, false);
    assert.deepStrictEqual(s.nodes.map((n) => n.id).sort(), before);

    await op({ op: 'focus' });
    s = await op({ op: 'escape' });
    assert.strictEqual(s.narrowing.focused, false);
    assert.deepStrictEqual(s.nodes.map((n) => n.id).sort(), before);
    await waitFor(() => shell.panel()!.selectedNodeId === null, 'selection cleared', 5_000);
    await fileLayer();
  });
});
