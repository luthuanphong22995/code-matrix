import * as assert from 'node:assert';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { SidecarManager } from '../../../src/sidecar/manager';
import { waitFor } from './shell';

const hostKey = `${process.platform}-${process.arch}`;
const exe = process.platform === 'win32' ? 'code-matrix-server.exe' : 'code-matrix-server';

// The installed layout: bin/<host-key>/code-matrix-server inside the extension, no env override (R11).
suite('bundled server binary', () => {
  let extensionPath: string;
  let savedOverride: string | undefined;
  let manager: SidecarManager | undefined;

  suiteSetup(() => {
    savedOverride = process.env.CODE_MATRIX_SERVER_PATH;
    delete process.env.CODE_MATRIX_SERVER_PATH;
    const ext = vscode.extensions.getExtension('code-matrix.code-matrix');
    assert.ok(ext, 'extension code-matrix.code-matrix not found');
    extensionPath = ext.extensionPath;
    assert.ok(fs.existsSync(path.join(extensionPath, 'bin', hostKey, exe)), 'run npm run bundle-server first');
  });

  suiteTeardown(() => {
    if (savedOverride !== undefined) process.env.CODE_MATRIX_SERVER_PATH = savedOverride;
  });

  teardown(async () => {
    await manager?.stop();
    manager = undefined;
  });

  test('resolves and reaches ready from bin/<host-key>/ with no env override', async () => {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    assert.ok(root, 'a workspace folder is open');
    manager = new SidecarManager(extensionPath, (cmd, args) => spawn(cmd, args), Date.now);
    manager.start([root]);
    await waitFor(() => manager!.state.kind === 'ready', `ready (state: ${JSON.stringify(manager.state)})`, 10_000);
  });

  test('an empty layout fails with the exact R11 cause and never spawns', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-empty-'));
    let spawned = 0;
    manager = new SidecarManager(
      empty,
      () => {
        spawned++;
        throw new Error('spawn must not be called');
      },
      Date.now,
    );
    manager.start([empty]);
    assert.deepStrictEqual(manager.state, {
      kind: 'failed',
      cause: `Server binary not found for ${hostKey}: ${path.join(empty, 'bin', hostKey, exe)}`,
    });
    assert.strictEqual(spawned, 0);
  });
});
