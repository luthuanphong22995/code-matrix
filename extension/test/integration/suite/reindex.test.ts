import * as assert from 'node:assert';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Shell } from '../../../src/extension';
import type { DebugState } from '../../../src/graph/messages';
import { activateShell, canvasState, capturePosts, waitFor } from './shell';

// The index strip and Re-index over a `.code-workspace` whose one folder is `<repo>/fixtures/go` (runTest.ts), so a
// folder can be added without reloading the extension host. Tests run in order and share one panel.
suite('index strip and Re-index over fixtures/go', () => {
  let shell: Shell;
  let restorePosts: () => void;
  const posted: Array<{ type: string }> = [];
  // `broken/broken.go` fails to parse in fixtures/go (wave 1 re-pinned the count to 4).
  const SUMMARY = 'Indexed 4 files, 1 failed Show Log ×';
  let before: string[] = [];

  const ids = (s: DebugState) => s.nodes.map((n) => n.id).sort();
  const visibleLog = () =>
    vscode.window.visibleTextEditors.find((e) => e.document.uri.scheme === 'output' && e.document.uri.path.includes('Code Matrix'))
      ?.document.getText();

  suiteSetup(async () => {
    shell = await activateShell();
    await vscode.commands.executeCommand('codeMatrix.openGraph');
    await waitFor(() => shell.panel() !== undefined, 'panel', 5_000);
    restorePosts = capturePosts(shell.panel()!.panel.webview, posted);
  });

  suiteTeardown(async () => {
    restorePosts?.();
    shell?.panel()?.dispose();
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  test('Open Graph: the strip settles on the summary over the drawn file layer', async () => {
    const s = await canvasState(shell, (x) => x.strip === SUMMARY && x.nodes.length === 6, 'summary strip and 6 nodes');
    assert.strictEqual(s.overlay, '');
    before = ids(s);
  });

  test('Re-index keeps the previous graph drawn, no overlay, then the strip shows the summary again (R5, R10)', async () => {
    const mark = posted.length;
    let s = await shell.graph.debug({ op: 'click', id: 'btn-reindex' });
    assert.deepStrictEqual(ids(s), before);
    assert.strictEqual(s.overlay, '');

    await waitFor(() => posted.slice(mark).some((m) => m.type === 'index/progress'), 'index/progress after Re-index', 15_000);
    await waitFor(() => posted.slice(mark).some((m) => m.type === 'index/done'), 'index/done after Re-index', 15_000);
    s = await canvasState(shell, (x) => x.strip === SUMMARY, 'summary after Re-index');
    assert.deepStrictEqual(ids(s), before);
    assert.strictEqual(s.overlay, '');
  });

  test('× hides the strip and leaves the graph alone', async () => {
    const s = await shell.graph.debug({ op: 'click', id: 'btn-index-dismiss' });
    assert.strictEqual(s.strip, '');
    assert.deepStrictEqual(ids(s), before);
  });

  test('adding a workspace folder logs and runs over both roots (R14)', async () => {
    const ext = vscode.extensions.getExtension('code-matrix.code-matrix')!;
    const added = vscode.Uri.file(path.join(ext.extensionPath, 'test/integration/fixtures/workspace'));
    assert.ok(vscode.workspace.updateWorkspaceFolders(1, 0, { uri: added }), 'updateWorkspaceFolders refused');

    // 4 from fixtures/go plus src/config.go from fixtures/workspace; several roots are basename-prefixed.
    const s = await canvasState(
      shell,
      (x) => x.strip === 'Indexed 5 files, 1 failed Show Log ×' && x.nodes.some((n) => n.kind === 'file' && n.name === 'workspace/src/config.go'),
      'summary over both roots',
      20_000,
    );
    assert.strictEqual(s.overlay, '');

    await vscode.commands.executeCommand('codeMatrix.showLog');
    await waitFor(() => (visibleLog() ?? '').includes('Workspace roots changed, starting full run'), 'roots-changed log line', 5_000);
  });
});
