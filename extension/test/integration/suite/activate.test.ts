import * as assert from 'node:assert';
import * as vscode from 'vscode';

suite('activation', () => {
  test('extension activates', async () => {
    const ext = vscode.extensions.getExtension('code-matrix.code-matrix');
    assert.ok(ext, 'extension code-matrix.code-matrix not found');
    await ext.activate();
    assert.ok(ext.isActive);
  });
});
