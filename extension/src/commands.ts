import * as vscode from 'vscode';
import type { FlowController } from './flow/controller';
import type { GraphController } from './graph/controller';
import type { IndexController } from './index/controller';
import { getOutputChannel } from './output';
import { GraphPanel } from './panel/graphPanel';
import type { SidecarManager } from './sidecar/manager';

// `Code Matrix: Open Graph`: guard against no folder (R2), one panel (R1), lazy start with every root (R3, R4),
// the canvas attached to the panel.
export function openGraph(context: vscode.ExtensionContext, manager: SidecarManager, graph: GraphController): void {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders?.length) {
    void vscode.window.showInformationMessage('Open a folder to analyze');
    return;
  }
  graph.attach(GraphPanel.createOrShow(context, manager));
  if (manager.state.kind === 'not-started') manager.start(folders.map((f) => f.uri.fsPath));
}

// `Code Matrix: Restart Server`: never counts toward the restart budget (R5); no roots to restart with before the first start.
export function restartServer(manager: SidecarManager): Promise<void> | undefined {
  if (manager.state.kind === 'not-started') return undefined;
  return manager.restart();
}

// `Code Matrix: Show Log`: reveal the single output channel without stealing focus (R10).
export function showLog(): void {
  getOutputChannel().show(true);
}

export function registerCommands(
  context: vscode.ExtensionContext,
  manager: SidecarManager,
  graph: GraphController,
  index: IndexController,
  flow: FlowController,
): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand('codeMatrix.openGraph', () => openGraph(context, manager, graph)),
    vscode.commands.registerCommand('codeMatrix.restartServer', () => restartServer(manager)),
    vscode.commands.registerCommand('codeMatrix.showLog', showLog),
    // `Code Matrix: Re-index Workspace`: a full run in ready / indexing, else the not-running toast (R1, R10).
    vscode.commands.registerCommand('codeMatrix.reindex', () => index.reindex()),
    // `Code Matrix: Trace Data Flow`: the identifier under the primary cursor (data-flow R1).
    vscode.commands.registerCommand('codeMatrix.traceDataFlow', () => flow.trace()),
  ];
}
