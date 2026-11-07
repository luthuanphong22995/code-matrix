import { describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { activate, deactivate } from '../../src/extension';

describe('unit harness', () => {
  it('resolves vscode to the mock', () => {
    expect(new vscode.Position(1, 2).line).toBe(1);
  });

  it('activate builds the shell without starting the sidecar; deactivate stops it (R4)', async () => {
    const context = { extensionPath: '/ext', extensionUri: vscode.Uri.file('/ext'), subscriptions: [] };
    const shell = activate(context as unknown as vscode.ExtensionContext);
    expect(shell.manager.state).toEqual({ kind: 'not-started' });
    expect(shell.panel()).toBeUndefined();
    expect(context.subscriptions.length).toBeGreaterThan(0);
    await expect(deactivate()).resolves.toBeUndefined();
    expect(shell.manager.state).toEqual({ kind: 'not-started' });
  });
});
