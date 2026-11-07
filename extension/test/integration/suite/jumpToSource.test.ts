import * as assert from 'node:assert';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Shell } from '../../../src/extension';
import type { ShellToWebview } from '../../../src/panel/messages';
import { activateShell, canvasState, capturePosts, codeMatrixTabs, waitFor } from './shell';

// Jump to source with nodes injected through the registry (no real nodes until code-graph). handleMessage stands
// in for the webview's posts; the DOM side is covered by test/unit/webview/details.test.ts. Tests run in order.
suite('jump to source', () => {
  let shell: Shell;
  let root: string;
  const posted: ShellToWebview[] = [];
  let restorePosts: (() => void) | undefined;
  const originalWarning = vscode.window.showWarningMessage;
  const warnings: string[] = [];

  const panel = () => shell.panel()!;
  const range = { startLine: 11, startCol: 0, endLine: 39, endCol: 1 };

  suiteSetup(async () => {
    shell = await activateShell();
    root = vscode.workspace.workspaceFolders![0].uri.fsPath;
    await vscode.commands.executeCommand('codeMatrix.openGraph');
    await waitFor(() => shell.panel() !== undefined, 'panel', 2_000);
    restorePosts = capturePosts(panel().panel.webview, posted);
    // A graph refresh keeps the registry equal to the drawn graph, so inject only after the panel's first one.
    await canvasState(shell, (s) => s.nodes.some((n) => n.kind === 'file'), 'the file layer');
    shell.nodes.register([
      { id: 'parseConfig', kind: 'function', name: 'parseConfig', path: path.join(root, 'src/config.go'), range },
      { id: 'oldNode', kind: 'function', name: 'old', path: path.join(root, 'src/old.go'), range },
    ]);
  });

  suiteTeardown(async () => {
    (vscode.window as { showWarningMessage: unknown }).showWarningMessage = originalWarning;
    restorePosts?.();
    shell?.panel()?.dispose();
    shell?.nodes.clear();
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  test('selecting a node replies shell/selection with kind, name and path:line (R8)', async () => {
    panel().handleMessage({ type: 'shell/selectNode', nodeId: 'parseConfig' });
    assert.strictEqual(panel().selectedNodeId, 'parseConfig');
    await waitFor(() => posted.some((m) => m.type === 'shell/selection'), 'shell/selection posted', 2_000);
    assert.deepStrictEqual(posted.filter((m) => m.type === 'shell/selection').at(-1), {
      type: 'shell/selection',
      node: { kind: 'function', name: 'parseConfig', location: 'src/config.go:12' },
    });
  });

  test('opening a node shows its file beside the graph at the range start (R8)', async () => {
    panel().handleMessage({ type: 'shell/openNode', nodeId: 'parseConfig' });
    const editor = () =>
      vscode.window.visibleTextEditors.find(
        (e) => path.basename(e.document.uri.fsPath) === 'config.go' && e.viewColumn !== panel().panel.viewColumn,
      );
    await waitFor(() => editor()?.selection.active.line === 11, 'config.go open beside at line 12', 5_000);
    assert.strictEqual(editor()!.selection.active.character, 0);
    assert.strictEqual(codeMatrixTabs().length, 1);
    assert.strictEqual(panel().selectedNodeId, 'parseConfig');
  });

  test('a missing file warns, opens nothing and keeps the selection (R9)', async () => {
    (vscode.window as { showWarningMessage: unknown }).showWarningMessage = (message: string) => {
      warnings.push(message);
      return Promise.resolve(undefined);
    };
    panel().handleMessage({ type: 'shell/selectNode', nodeId: 'oldNode' });
    panel().handleMessage({ type: 'shell/openNode', nodeId: 'oldNode' });
    await waitFor(() => warnings.includes('File not found: src/old.go'), 'File not found warning', 5_000);
    assert.strictEqual(panel().selectedNodeId, 'oldNode');
    assert.ok(!vscode.window.visibleTextEditors.some((e) => path.basename(e.document.uri.fsPath) === 'old.go'));
    assert.ok(!vscode.workspace.textDocuments.some((d) => path.basename(d.uri.fsPath) === 'old.go'));
  });
});
