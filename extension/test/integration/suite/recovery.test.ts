import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Shell } from '../../../src/extension';
import type { ShellToWebview } from '../../../src/panel/messages';
import { activateShell, capturePosts, waitFor } from './shell';

const CAUSE_101 = 'Process exited with code 101';

// Crash scenarios against the scripted fake server (fixtures/fake-server). The manager re-reads process.env on
// every start, so the suite points CODE_MATRIX_SERVER_PATH at the fake at runtime. Tests run in order and share state.
suite('failure recovery against a crash-on-demand fake server', function () {
  let shell: Shell;
  let crashFile: string;
  const saved = { path: process.env.CODE_MATRIX_SERVER_PATH, crashes: process.env.FAKE_SERVER_CRASHES };
  const kinds: string[] = [];
  const statusTexts: string[] = [];
  const posted: ShellToWebview[] = [];
  let restorePosts: (() => void) | undefined;

  const crash = (n: number) => fs.writeFileSync(crashFile, String(n));
  // ponytail: the pid lives on the private child, as in openGraph.test.ts.
  const child = () => (shell.manager as unknown as { child: { pid: number } | undefined }).child;
  const pid = () => child()?.pid;
  const item = () => shell.statusBar.item;
  const since = (mark: number) => kinds.slice(mark);
  const failedPosted = (cause: string, from = 0) =>
    posted.slice(from).some((m) => m.type === 'shell/state' && m.state === 'failed' && m.cause === cause);

  // Text of the `Code Matrix` output channel's editor, if VS Code lists it among the visible editors.
  const visibleLog = () =>
    vscode.window.visibleTextEditors.find((e) => e.document.uri.scheme === 'output' && e.document.uri.path.includes('Code Matrix'))
      ?.document.getText();

  suiteSetup(async function () {
    // No wrapper for a shebang script on Windows; CI integration runs on ubuntu only. 03's unit tests cover the logic.
    if (process.platform === 'win32') this.skip();
    shell = await activateShell();
    const ext = vscode.extensions.getExtension('code-matrix.code-matrix')!;
    const fake = path.join(ext.extensionPath, 'test/integration/fixtures/fake-server/fake-server.js');
    fs.chmodSync(fake, 0o755);
    crashFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cm-crash-')), 'crashes');
    crash(0);
    process.env.CODE_MATRIX_SERVER_PATH = fake;
    process.env.FAKE_SERVER_CRASHES = crashFile;

    shell.manager.onDidChangeState((s) => {
      kinds.push(s.kind);
      statusTexts.push(item().text); // StatusBar subscribed first, so its text is already updated.
    });
    shell.panel()?.dispose();
    await vscode.commands.executeCommand('codeMatrix.openGraph');
    restorePosts = capturePosts(shell.panel()!.panel.webview, posted);
    await waitFor(() => shell.manager.state.kind === 'ready', `ready (state: ${JSON.stringify(shell.manager.state)})`, 10_000);
  });

  suiteTeardown(async () => {
    restorePosts?.();
    if (!shell) return;
    await shell.deactivate();
    shell.panel()?.dispose();
    for (const [key, value] of [
      ['CODE_MATRIX_SERVER_PATH', saved.path],
      ['FAKE_SERVER_CRASHES', saved.crashes],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  test('Restart Server never counts toward the budget (R5, R7)', async () => {
    const before = pid();
    assert.ok(before, 'fake server running');
    const mark = kinds.length;
    await vscode.commands.executeCommand('codeMatrix.restartServer');
    await waitFor(() => shell.manager.state.kind === 'ready', 'ready after restart', 5_000);
    assert.deepStrictEqual(since(mark), ['starting', 'ready']);
    assert.deepStrictEqual(statusTexts.slice(mark), ['Code Matrix: starting', 'Code Matrix: ready']);
    assert.notStrictEqual(pid(), before);

    // The restart did not use up the budget: the next crash is still the silent one.
    const crashMark = kinds.length;
    crash(1);
    await waitFor(() => since(crashMark).includes('ready'), 'silent restart to ready', 5_000);
    assert.deepStrictEqual(since(crashMark), ['starting', 'ready']);
  });

  test('one crash restarts silently, visible only in the log (R5, R10)', async () => {
    await vscode.commands.executeCommand('codeMatrix.showLog');
    await waitFor(
      () => {
        const text = visibleLog() ?? '';
        return text.includes('server exited with code 101, restarting') && text.includes('fake-server: crashing');
      },
      'restart lines in the Code Matrix output channel',
      5_000,
    );
    await vscode.commands.executeCommand('workbench.action.closePanel');
  });

  test('a second crash within 60 s fails (R5, R6, R7)', async () => {
    const from = posted.length;
    crash(1);
    await waitFor(() => shell.manager.state.kind === 'failed', 'failed', 5_000);
    assert.deepStrictEqual(shell.manager.state, { kind: 'failed', cause: CAUSE_101 });
    await waitFor(() => failedPosted(CAUSE_101, from), 'failed shell/state posted', 2_000);
    assert.strictEqual(item().text, 'Code Matrix: failed');
    assert.deepStrictEqual(item().backgroundColor, new vscode.ThemeColor('statusBarItem.errorBackground'));
    assert.strictEqual(item().command, 'codeMatrix.showLog');
  });

  test('Show Log from the panel and from the palette reveals the log (R6, R10)', async () => {
    shell.panel()!.handleMessage({ type: 'shell/showLog' });
    await waitFor(() => (visibleLog() ?? '').includes('fake-server: started'), 'log visible via panel Show Log', 5_000);

    await vscode.commands.executeCommand('workbench.action.closePanel');
    await waitFor(() => visibleLog() === undefined, 'output panel closed', 5_000);

    await vscode.commands.executeCommand('codeMatrix.showLog');
    await waitFor(() => (visibleLog() ?? '').includes('fake-server: started'), 'log visible via the command', 5_000);
    await vscode.commands.executeCommand('workbench.action.closePanel');
  });

  test('closing the panel while failed retries nothing; reopening stays failed (flows.md abandonment)', async () => {
    const mark = kinds.length;
    shell.panel()!.dispose();
    await new Promise((r) => setTimeout(r, 5_000));
    assert.strictEqual(item().text, 'Code Matrix: failed');
    assert.deepStrictEqual(since(mark), []);
    assert.strictEqual(child(), undefined);

    const from = posted.length;
    await vscode.commands.executeCommand('codeMatrix.openGraph');
    assert.ok(shell.panel(), 'panel reopened');
    await waitFor(() => failedPosted(CAUSE_101, from), 'reopened panel shows failed', 2_000);
    assert.deepStrictEqual(since(mark), []);
    assert.strictEqual(child(), undefined);
  });

  test('Retry resets the budget (R6)', async () => {
    const mark = kinds.length;
    shell.panel()!.handleMessage({ type: 'shell/retry' });
    await waitFor(() => shell.manager.state.kind === 'ready', 'ready after retry', 5_000);
    assert.deepStrictEqual(statusTexts.slice(mark), ['Code Matrix: starting', 'Code Matrix: ready']);

    const crashMark = kinds.length;
    crash(1);
    await waitFor(() => since(crashMark).includes('ready'), 'silent restart after retry', 5_000);
    assert.deepStrictEqual(since(crashMark), ['starting', 'ready']);
  });

  test('a missing binary fails with the R11 cause (R11)', async () => {
    await shell.deactivate();
    shell.panel()?.dispose();
    const missing = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cm-missing-')), 'code-matrix-server');
    process.env.CODE_MATRIX_SERVER_PATH = missing;
    const cause = `Server binary not found for ${process.platform}-${process.arch}: ${missing}`;

    const from = posted.length;
    await vscode.commands.executeCommand('codeMatrix.openGraph');
    assert.ok(shell.panel(), 'panel open');
    assert.deepStrictEqual(shell.manager.state, { kind: 'failed', cause });
    await waitFor(() => failedPosted(cause, from), 'failed shell/state with the R11 cause', 2_000);
  });
});
