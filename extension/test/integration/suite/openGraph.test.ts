import * as assert from 'node:assert';
import * as vscode from 'vscode';
import type { Shell } from '../../../src/extension';
import { activateShell, codeMatrixTabs, waitFor } from './shell';

const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

suite('Open Graph against the real code-matrix-server', () => {
  let shell: Shell;
  const kinds: string[] = [];
  const statusText = () => shell.statusBar.item.text;

  suiteSetup(async () => {
    shell = await activateShell();
    shell.manager.onDidChangeState((s) => kinds.push(s.kind));
  });

  test('bare activation spawns nothing and shows no status (R4)', () => {
    assert.strictEqual(shell.manager.state.kind, 'not-started');
    assert.strictEqual(shell.manager.connection, undefined);
    assert.strictEqual(shell.statusBar.visible, false);
    assert.strictEqual(codeMatrixTabs().length, 0);
  });

  test('Open Graph opens the panel and reaches ready (R1, R4, R7)', async () => {
    await vscode.commands.executeCommand('codeMatrix.openGraph');
    assert.ok(shell.panel(), 'GraphPanel.current set');
    // The tab groups API catches up with createWebviewPanel asynchronously.
    await waitFor(() => vscode.window.tabGroups.activeTabGroup.activeTab?.label === 'Code Matrix', 'panel tab active', 2_000);
    assert.strictEqual(codeMatrixTabs().length, 1);
    // The initialize reply readies the manager; the server's first index run then reports indexing → ready (graph-rpc).
    await waitFor(() => kinds.length === 4, 'indexing then ready', 10_000);
    assert.deepStrictEqual(kinds, ['starting', 'ready', 'indexing', 'ready']);
    assert.strictEqual(statusText(), 'Code Matrix: ready');
    assert.strictEqual(shell.statusBar.visible, true);
  });

  test('rerun reveals the same single tab (R1)', async () => {
    const first = shell.panel();
    const doc = await vscode.workspace.openTextDocument({ content: 'other editor' });
    await vscode.window.showTextDocument(doc);
    assert.notStrictEqual(vscode.window.tabGroups.activeTabGroup.activeTab?.label, 'Code Matrix');

    await vscode.commands.executeCommand('codeMatrix.openGraph');
    assert.strictEqual(shell.panel(), first);
    assert.strictEqual(codeMatrixTabs().length, 1);
    await waitFor(() => vscode.window.tabGroups.activeTabGroup.activeTab?.label === 'Code Matrix', 'panel active', 2_000);
    assert.strictEqual(shell.manager.state.kind, 'ready');
  });

  test('closing and reopening the tab does not respawn (R1, R4)', async () => {
    const connection = shell.manager.connection;
    const first = shell.panel()!;
    first.dispose();
    await waitFor(() => codeMatrixTabs().length === 0, 'tab closed', 2_000);
    assert.strictEqual(shell.panel(), undefined);
    assert.strictEqual(shell.manager.state.kind, 'ready');

    await vscode.commands.executeCommand('codeMatrix.openGraph');
    await waitFor(() => codeMatrixTabs().length === 1, 'new panel tab', 2_000);
    assert.notStrictEqual(shell.panel(), first);
    assert.strictEqual(shell.manager.connection, connection);
    assert.strictEqual(statusText(), 'Code Matrix: ready');
  });

  test('deactivate stops the server process (R4)', async () => {
    // ponytail: the pid lives on the private child; reaching in beats widening the manager's API for one test.
    const pid = (shell.manager as unknown as { child: { pid: number } }).child.pid;
    assert.ok(pid > 0, 'server pid recorded');
    assert.ok(pidAlive(pid));
    await shell.deactivate();
    await waitFor(() => !pidAlive(pid), 'server process to exit', 3_000);
    assert.strictEqual(shell.manager.state.kind, 'not-started');
  });
});
