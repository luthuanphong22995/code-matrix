import * as vscode from 'vscode';
import type { SidecarManager } from './sidecar/manager';
import type { SidecarState } from './sidecar/state';

// Left status bar item `Code Matrix: <state>`; hidden until the sidecar first starts, click opens the panel, or the log when failed (R7).
export class StatusBar {
  readonly item: vscode.StatusBarItem;
  visible = false;
  private readonly subscription: { dispose(): void };

  constructor(manager: SidecarManager) {
    this.item = vscode.window.createStatusBarItem('codeMatrix.status', vscode.StatusBarAlignment.Left);
    this.item.command = 'codeMatrix.openGraph';
    this.subscription = manager.onDidChangeState((state) => this.update(state));
  }

  update(state: SidecarState): void {
    if (state.kind === 'not-started') return;
    const failed = state.kind === 'failed';
    this.item.text = `Code Matrix: ${state.kind}`;
    this.item.backgroundColor = failed ? new vscode.ThemeColor('statusBarItem.errorBackground') : undefined;
    this.item.command = failed ? 'codeMatrix.showLog' : 'codeMatrix.openGraph';
    this.item.show();
    this.visible = true;
  }

  dispose(): void {
    this.subscription.dispose();
    this.item.dispose();
  }
}
