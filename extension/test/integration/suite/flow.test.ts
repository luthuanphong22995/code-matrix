import * as assert from 'node:assert';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Shell } from '../../../src/extension';
import type { Decorated } from '../../../src/flow/controller';
import type { DebugState } from '../../../src/graph/messages';
import { activateShell, canvasState, capturePosts, waitFor } from './shell';

// `Code Matrix: Trace Data Flow` against the real server on fixtures/flow, whose config.go is
// core/crates/frontend-go/tests/fixtures/flow/config.go. Tests run in order and share one trace.
suite('Trace Data Flow over fixtures/flow', () => {
  let shell: Shell;
  let restorePosts: (() => void) | undefined;
  const posted: Array<{ type: string }> = [];
  const messages: Array<[kind: 'info' | 'warning', text: string]> = [];
  const original = { info: vscode.window.showInformationMessage, warning: vscode.window.showWarningMessage };
  const root = vscode.workspace.workspaceFolders![0].uri;
  const fileUri = (name: string) => vscode.Uri.file(path.join(root.fsPath, name));
  const config = fileUri('config.go');
  let originalBytes: Uint8Array = new Uint8Array();
  let originalText = '';

  // 1-based lines per decoration type.
  const lines = (d: Decorated) => Object.fromEntries(Object.entries(d).map(([k, rs]) => [k, rs.map((r) => r.start.line + 1)]));
  const TRACED = { def: [12, 14], use: [14, 18], currentDef: [12], currentUse: [14] };

  // Opens `name` with the primary cursor at the 0-based `line:character`, then runs the command.
  const traceAt = async (name: string, line: number, character: number) => {
    const editor = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(fileUri(name)));
    editor.selection = new vscode.Selection(line, character, line, character);
    await vscode.commands.executeCommand('codeMatrix.traceDataFlow');
  };

  suiteSetup(async () => {
    shell = await activateShell();
    originalBytes = await vscode.workspace.fs.readFile(config);
    originalText = Buffer.from(originalBytes).toString('utf8');
    // Global, i.e. the throwaway test profile: the fixture carries no .vscode/settings.json.
    await vscode.workspace.getConfiguration('files').update('exclude', { 'excluded.go': true }, vscode.ConfigurationTarget.Global);
    const w = vscode.window as { showInformationMessage: unknown; showWarningMessage: unknown };
    w.showInformationMessage = (text: string) => (messages.push(['info', text]), Promise.resolve(undefined));
    w.showWarningMessage = (text: string) => (messages.push(['warning', text]), Promise.resolve(undefined));
  });

  suiteTeardown(async () => {
    // An aborted edit test must not leave the fixture modified.
    await vscode.workspace.fs.writeFile(config, originalBytes);
    const w = vscode.window as { showInformationMessage: unknown; showWarningMessage: unknown };
    w.showInformationMessage = original.info;
    w.showWarningMessage = original.warning;
    restorePosts?.();
    shell?.panel()?.dispose();
    await vscode.workspace.getConfiguration('files').update('exclude', undefined, vscode.ConfigurationTarget.Global);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  test('with no graph yet the trace pends, opens the panel, then shows hop 1 beside it with focus kept (R1, R7, R16)', async () => {
    assert.strictEqual(shell.panel(), undefined);
    await traceAt('config.go', 17, 9);
    assert.deepStrictEqual(messages, [['info', 'Trace will start when indexing finishes']]);
    assert.ok(shell.panel(), 'the panel opened');
    restorePosts = capturePosts(shell.panel()!.panel.webview, posted);

    await waitFor(() => shell.flow.decorated(config).currentUse.length > 0, 'trace decorations', 20_000);
    assert.deepStrictEqual(lines(shell.flow.decorated(config)), TRACED);
    const shows = posted.filter((m) => m.type === 'flow/show') as Array<{ type: string; hop: number; trace: { variable: string } }>;
    assert.deepStrictEqual(
      shows.map((m) => [m.hop, m.trace.variable]),
      [[1, 'total']],
    );
    await waitFor(
      () =>
        vscode.window.visibleTextEditors.some(
          (e) => e.document.uri.fsPath === config.fsPath && e.visibleRanges.some((r) => r.start.line <= 13 && r.end.line >= 13),
        ),
      'config.go showing line 14',
      5_000,
    );
    assert.strictEqual(vscode.window.tabGroups.activeTabGroup.activeTab?.label, 'Code Matrix');
    assert.deepStrictEqual(messages, [['info', 'Trace will start when indexing finishes']]);
  });

  const refusals: Array<[string, string, number, number, 'info' | 'warning', string]> = [
    ['whitespace', 'config.go', 11, 0, 'info', 'Place the cursor on a variable or parameter'],
    ['a function name', 'config.go', 12, 20, 'info', '`open` is not a local variable or parameter of `parseConfig`'],
    ['a package-level var', 'config.go', 4, 6, 'info', '`defaultPath` is not inside a function'],
    ['an excluded file', 'excluded.go', 3, 1, 'info', '`excluded.go` is not indexed'],
    ['a file that failed', 'broken.go', 2, 6, 'warning', '`broken.go` failed to index — see the Code Matrix output'],
  ];
  for (const [what, file, line, character, kind, text] of refusals) {
    test(`${what} shows exactly its message and leaves the trace (R2, R3, R18)`, async () => {
      const mark = { messages: messages.length, posted: posted.length };
      await traceAt(file, line, character);
      assert.deepStrictEqual(messages.slice(mark.messages), [[kind, text]]);
      assert.deepStrictEqual(lines(shell.flow.decorated(config)), TRACED);
      assert.deepStrictEqual(posted.slice(mark.posted).filter((m) => m.type.startsWith('flow/')), []);
    });
  }

  // The canvas half (extension/flow-canvas): block ids are the server's, so blocks are named by their label's first line.
  const head = (s: DebugState, id: string | null) => s.flow!.blocks.find((b) => b.id === id)?.label.split('\n')[0];

  test('the panel unfolds parseConfig into its CFG with hop 1 drawn (R6, R7)', async () => {
    const s = await canvasState(shell, (st) => st.flow?.container === 'parseConfig', 'the unfolded parseConfig container');
    const labels = s.flow!.blocks.map((b) => b.label);
    for (const label of ['entry', 'line 12\ntotal := 0', 'exit']) assert.ok(labels.includes(label), `${label} in ${JSON.stringify(labels)}`);
    for (const line of ['line 13', 'line 14', 'line 18']) assert.ok(labels.some((l) => l.startsWith(`${line}\n`)), `${line} in ${JSON.stringify(labels)}`);
    assert.deepStrictEqual(s.flow!.highlighted.map((id) => head(s, id)).sort(), ['line 12', 'line 14', 'line 18']);
    assert.strictEqual(head(s, s.flow!.current), 'line 14');
    const hop = s.flow!.hopEdge!;
    assert.deepStrictEqual([head(s, hop.from), head(s, hop.to), hop.label], ['line 12', 'line 14', 'total']);
    assert.deepStrictEqual([s.flow!.status, s.flow!.prev, s.flow!.next], ['Hop 1 of 4: total defined at line 12 → used at line 14', false, true]);
  });

  test('Right ×3 reaches hop 4 with line 18 current in the editor; a fourth does nothing (R7, R8)', async () => {
    let s: DebugState | undefined;
    for (let i = 0; i < 3; i++) s = await shell.graph.debug({ op: 'key', key: 'ArrowRight' });
    assert.deepStrictEqual([s!.flow!.hop, s!.flow!.next, head(s!, s!.flow!.current)], [4, false, 'line 18']);
    await waitFor(() => shell.flow.decorated(config).currentUse[0]?.start.line === 17, 'hop 4 decorated on line 18', 5_000);
    const mark = posted.length;
    s = await shell.graph.debug({ op: 'key', key: 'ArrowRight' });
    assert.strictEqual(s.flow!.hop, 4);
    assert.deepStrictEqual(lines(shell.flow.decorated(config)).currentUse, [18]);
    assert.strictEqual(posted.length, mark + 1, 'only the debug request was posted');
  });

  test('a path glob that excludes config.go keeps the container and its blocks drawn (R19)', async () => {
    const s = await shell.graph.debug({ op: 'path', text: 'src/api/**' });
    assert.strictEqual(s.flow!.container, 'parseConfig');
    assert.ok(s.flow!.blocks.length >= 6);
    await shell.graph.debug({ op: 'path', text: '' });
  });

  test('Escape with a selection clears the trace and its decorations and keeps config.go selected (R12, R13)', async () => {
    const before = await shell.graph.debug({ op: 'state' });
    const file = before.nodes.find((n) => n.kind === 'file' && n.name === 'config.go')!;
    await shell.graph.debug({ op: 'tap', id: file.id });
    await canvasState(shell, (st) => st.details.includes('Name config.go'), 'config.go selected');
    const s = await shell.graph.debug({ op: 'escape' });
    assert.strictEqual(s.flow, null);
    await waitFor(() => shell.flow.decorated(config).def.length === 0, 'decorations cleared', 5_000);
    assert.deepStrictEqual(lines(shell.flow.decorated(config)), { def: [], use: [], currentDef: [], currentUse: [] });
    assert.ok((await shell.graph.debug({ op: 'state' })).details.includes('Name config.go'), 'config.go still selected');
  });

  test('closing the panel empties every decoration type; reopening posts no flow/show (R20)', async () => {
    shell.panel()!.dispose();
    assert.deepStrictEqual(lines(shell.flow.decorated(config)), { def: [], use: [], currentDef: [], currentUse: [] });

    const mark = posted.length;
    await vscode.commands.executeCommand('codeMatrix.openGraph');
    await waitFor(() => posted.slice(mark).some((m) => m.type === 'graph/refresh'), 'graph/refresh after reopening', 10_000);
    assert.deepStrictEqual(posted.slice(mark).filter((m) => m.type.startsWith('flow/')), []);
  });

  // Retrace on re-index (R14, R17): each edit is saved, so the watcher re-indexes and graph/changed retraces.
  const EMPTY = { def: [], use: [], currentDef: [], currentUse: [] };
  const shiftedBy = (d: Record<string, number[]>, n: number) => Object.fromEntries(Object.entries(d).map(([k, ls]) => [k, ls.map((l) => l + n)]));
  const lastFlowPost = (from: number) => posted.slice(from).filter((m) => m.type.startsWith('flow/')).at(-1);

  // Replaces config.go's text through a WorkspaceEdit and saves it.
  const rewrite = async (edit: (text: string) => string) => {
    const doc = await vscode.workspace.openTextDocument(config);
    const e = new vscode.WorkspaceEdit();
    e.replace(config, new vscode.Range(0, 0, doc.lineCount, 0), edit(doc.getText()));
    assert.ok(await vscode.workspace.applyEdit(e));
    assert.ok(await doc.save());
  };
  const insertBlankLine = async () => {
    const e = new vscode.WorkspaceEdit();
    e.insert(config, new vscode.Position(0, 0), '\n');
    assert.ok(await vscode.workspace.applyEdit(e));
    assert.ok(await (await vscode.workspace.openTextDocument(config)).save());
  };
  // Writes the original bytes back and waits for that change's refresh (and retrace, while a trace is active).
  const restore = async () => {
    const mark = posted.length;
    const traced = shell.flow.decorated(config).def.length > 0;
    await rewrite(() => originalText);
    await waitFor(() => posted.slice(mark).some((m) => m.type === (traced ? 'flow/show' : 'graph/refresh')), 'the restore re-indexed', 20_000);
  };
  // Re-traces `total` at its use on line 18 and waits for hop 1 on the canvas.
  const retraced = async () => {
    await traceAt('config.go', 17, 9);
    await waitFor(() => shell.flow.decorated(config).currentUse.length > 0, 'trace decorations', 20_000);
    assert.deepStrictEqual(lines(shell.flow.decorated(config)), TRACED);
    await canvasState(shell, (s) => s.flow?.container === 'parseConfig' && s.flow.hop === 1, 'hop 1 drawn');
  };

  test('a blank line above parseConfig keeps hop 3 of 4, decorated one line down (R14)', async function () {
    this.timeout(60_000);
    await retraced();
    let s: DebugState | undefined;
    for (let i = 0; i < 2; i++) s = await shell.graph.debug({ op: 'key', key: 'ArrowRight' });
    assert.strictEqual(s!.flow!.hop, 3);
    await waitFor(() => shell.flow.decorated(config).currentDef.length > 0, 'hop 3 decorated', 5_000);
    const atHop3 = lines(shell.flow.decorated(config));

    await insertBlankLine();
    await waitFor(() => lines(shell.flow.decorated(config)).def[0] === 13, 'decorations one line down', 20_000);
    assert.deepStrictEqual(lines(shell.flow.decorated(config)), shiftedBy(atHop3, 1));
    s = await canvasState(shell, (st) => st.flow?.status.startsWith('Hop 3 of 4') === true, 'hop 3 of 4 after the retrace');
    assert.strictEqual(s.flow!.container, 'parseConfig');
    await restore();
    assert.deepStrictEqual(lines(shell.flow.decorated(config)), atHop3);
  });

  test('deleting line 18 at hop 4 lands on hop 1 of the recomputed trace (R14)', async function () {
    this.timeout(60_000);
    const s = await shell.graph.debug({ op: 'key', key: 'ArrowRight' });
    assert.strictEqual(s.flow!.hop, 4);
    const mark = posted.length;
    await rewrite((text) => text.split('\n').filter((_, i) => i !== 17).join('\n'));
    await canvasState(shell, (st) => st.flow?.status.startsWith('Hop 1 of') === true,'hop 1 of the recomputed trace');
    assert.strictEqual((lastFlowPost(mark) as { hop?: number } | undefined)?.hop, 1);
    await waitFor(() => !lines(shell.flow.decorated(config)).use.includes(18), 'line 18 gone from the decorations', 5_000);
    assert.deepStrictEqual(lines(shell.flow.decorated(config)).currentDef, [12]);
    await restore();
  });

  test('deleting parseConfig, then renaming total, clears the trace with its message (R14)', async function () {
    this.timeout(90_000);
    let mark = { messages: messages.length };
    await rewrite((text) => text.split('\n').slice(0, 10).join('\n') + '\n');
    await waitFor(() => messages.length > mark.messages, 'the cleared message', 20_000);
    assert.deepStrictEqual(messages.slice(mark.messages), [['info', 'Trace cleared: `parseConfig` no longer exists']]);
    assert.deepStrictEqual(lines(shell.flow.decorated(config)), EMPTY);
    assert.strictEqual((await shell.graph.debug({ op: 'state' })).flow, null);
    await restore();

    await retraced();
    mark = { messages: messages.length };
    await rewrite((text) => text.replaceAll('total', 'sum'));
    await waitFor(() => messages.length > mark.messages, 'the cleared message', 20_000);
    assert.deepStrictEqual(messages.slice(mark.messages), [['info', 'Trace cleared: `total` no longer exists in `parseConfig`']]);
    assert.deepStrictEqual(lines(shell.flow.decorated(config)), EMPTY);
    await restore();
  });

  test('a trace taken during a re-run answers at once, and the completing run retraces it (R17)', async function () {
    this.timeout(90_000);
    const mark = { messages: messages.length };
    await vscode.commands.executeCommand('codeMatrix.reindex');
    await traceAt('config.go', 17, 9);
    await waitFor(() => shell.flow.decorated(config).currentUse.length > 0, 'trace decorations', 20_000);
    assert.ok(!messages.slice(mark.messages).some(([, text]) => text === 'Trace will start when indexing finishes'));

    await insertBlankLine();
    await waitFor(() => lines(shell.flow.decorated(config)).def[0] === 13, 'decorations one line down', 30_000);
    assert.deepStrictEqual(lines(shell.flow.decorated(config)), shiftedBy(TRACED, 1));
    await restore();
    assert.deepStrictEqual(lines(shell.flow.decorated(config)), TRACED);
  });
});
