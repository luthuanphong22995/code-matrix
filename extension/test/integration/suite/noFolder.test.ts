import * as assert from 'node:assert';
import * as vscode from 'vscode';
import { activateShell, codeMatrixTabs } from './shell';

suite('Open Graph with no workspace folder', () => {
  test('shows the toast and does nothing else (R2)', async () => {
    const shell = await activateShell();
    assert.strictEqual(vscode.workspace.workspaceFolders, undefined);

    const toasts: string[] = [];
    const original = vscode.window.showInformationMessage;
    (vscode.window as { showInformationMessage: unknown }).showInformationMessage = (message: string) => {
      toasts.push(message);
      return Promise.resolve(undefined);
    };
    try {
      await vscode.commands.executeCommand('codeMatrix.openGraph');
    } finally {
      (vscode.window as { showInformationMessage: unknown }).showInformationMessage = original;
    }

    assert.deepStrictEqual(toasts, ['Open a folder to analyze']);
    assert.strictEqual(codeMatrixTabs().length, 0);
    assert.strictEqual(shell.panel(), undefined);
    assert.strictEqual(shell.manager.state.kind, 'not-started');
  });
});
