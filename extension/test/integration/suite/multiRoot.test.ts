import * as assert from 'node:assert';
import * as vscode from 'vscode';
import { activateShell, codeMatrixTabs, waitFor } from './shell';

suite('Open Graph in a multi-root workspace', () => {
  test('starts once with every root (R3)', async () => {
    const shell = await activateShell();
    const roots = vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath) ?? [];
    assert.strictEqual(roots.length, 2, 'two fixture roots open');

    const calls: string[][] = [];
    const start = shell.manager.start.bind(shell.manager);
    shell.manager.start = (r: string[]) => {
      calls.push(r);
      start(r);
    };

    await vscode.commands.executeCommand('codeMatrix.openGraph');
    await waitFor(() => codeMatrixTabs().length === 1, 'panel tab', 2_000);
    assert.deepStrictEqual(calls, [roots]);
    await waitFor(() => shell.manager.state.kind === 'ready', 'ready', 5_000);
    assert.deepStrictEqual(calls, [roots]);
  });
});
