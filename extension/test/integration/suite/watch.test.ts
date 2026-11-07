import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Shell } from '../../../src/extension';
import type { DebugState } from '../../../src/graph/messages';
import type { IndexFilesChangedParams } from '../../../src/sidecar/protocol';
import { activateShell, canvasState, capturePosts, waitFor } from './shell';

// The file watcher over a throwaway copy of `fixtures/typescript` under the real tmpdir (runTest.ts): edits on disk
// reach the canvas through index/filesChanged with no full run. Tests run in order and share one panel.
suite('file watcher over a copy of fixtures/typescript', () => {
  let shell: Shell;
  let root: string;
  let restorePosts: () => void;
  const posted: Array<{ type: string }> = [];
  const sent: IndexFilesChangedParams[] = [];

  const fileId = (s: DebugState, rel: string) => {
    const node = s.nodes.find((n) => n.kind === 'file' && shell.nodes.get(n.id)?.path === path.join(root, rel));
    assert.ok(node, `${rel} not drawn: ${JSON.stringify(s.nodes.map((n) => n.name))}`);
    return node.id;
  };

  suiteSetup(async () => {
    shell = await activateShell();
    root = vscode.workspace.workspaceFolders![0].uri.fsPath;
    await vscode.commands.executeCommand('codeMatrix.openGraph');
    await waitFor(() => shell.manager.state.kind === 'ready', 'sidecar ready', 15_000);
    await canvasState(shell, (x) => x.nodes.some((n) => n.kind === 'file'), 'the file layer');
    restorePosts = capturePosts(shell.panel()!.panel.webview, posted);
    const connection = shell.manager.connection!;
    const notify = connection.notify.bind(connection);
    connection.notify = (method, params) => {
      if (method === 'index/filesChanged') sent.push(params as IndexFilesChangedParams);
      notify(method, params);
    };
  });

  suiteTeardown(async () => {
    restorePosts?.();
    shell?.panel()?.dispose();
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  test('a function written to disk appears on the canvas with no full run (R7)', async () => {
    const file = path.join(root, 'src/util/index.ts');
    let s = await canvasState(shell, () => true, 'state');
    await shell.graph.debug({ op: 'toggle', id: fileId(s, 'src/util/index.ts') });
    await canvasState(shell, (x) => x.nodes.some((n) => n.name === 'readFile'), 'src/util/index.ts expanded');

    const mark = posted.length;
    fs.appendFileSync(file, '\nexport function addedByWatcher(): void {}\n');
    s = await canvasState(shell, (x) => x.nodes.some((n) => n.kind === 'function' && n.name === 'addedByWatcher'), 'addedByWatcher drawn');
    assert.ok(
      sent.some((p) => p.changes.some((c) => c.path === file && c.type === 'changed')),
      JSON.stringify(sent),
    );
    assert.ok(!posted.slice(mark).some((m) => m.type === 'index/progress'), 'a full run was started');
  });

  test('a deleted file leaves the canvas', async () => {
    const s = await canvasState(shell, () => true, 'state');
    const config = fileId(s, 'src/config.ts');
    fs.rmSync(path.join(root, 'src/config.ts'));
    await canvasState(shell, (x) => !x.nodes.some((n) => n.id === config), 'src/config.ts gone');
  });

  test('writing README.md sends nothing (R15)', async () => {
    const [markSent, markPosted] = [sent.length, posted.length];
    fs.writeFileSync(path.join(root, 'README.md'), '# changed\n');
    await new Promise((r) => setTimeout(r, 1_000));
    assert.deepStrictEqual(sent.slice(markSent), []);
    assert.ok(!posted.slice(markPosted).some((m) => m.type === 'graph/refresh'), 'graph/refresh after README.md');
  });
});
