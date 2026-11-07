import { spawn } from 'node:child_process';
import type * as vscode from 'vscode';
import { openGraph, registerCommands } from './commands';
import { FlowController } from './flow/controller';
import { GraphController } from './graph/controller';
import { IndexController } from './index/controller';
import { IndexWatcher } from './index/watcher';
import { type NodeRegistry, nodes } from './nodes/registry';
import { GraphPanel } from './panel/graphPanel';
import { SidecarManager } from './sidecar/manager';
import { StatusBar } from './statusBar';

// The extension's API, returned from `activate`; integration tests reach it via `getExtension().exports`.
export interface Shell {
  readonly manager: SidecarManager;
  readonly statusBar: StatusBar;
  // Where features register nodes before posting payloads that reference them.
  readonly nodes: NodeRegistry;
  // Code-graph's canvas controller.
  readonly graph: GraphController;
  // Workspace-index's run starter.
  readonly index: IndexController;
  // Data-flow's trace controller.
  readonly flow: FlowController;
  panel(): GraphPanel | undefined;
  deactivate(): Promise<void>;
}

export let shell: Shell | undefined;

// Builds the manager without starting it: the sidecar spawns on `Open Graph`, never on activation (R4).
export function activate(context: vscode.ExtensionContext): Shell {
  const manager = new SidecarManager(context.extensionPath, (command, args) => spawn(command, args), Date.now);
  const statusBar = new StatusBar(manager);
  const index = new IndexController(manager);
  // The closure resolves `graph` only when called, so flow/ never imports graph/ or commands.
  const flow = new FlowController(manager, index, () => openGraph(context, manager, graph));
  const graph = new GraphController(manager, nodes, index, flow);
  context.subscriptions.push(statusBar, new IndexWatcher(manager), ...registerCommands(context, manager, graph, index, flow));
  shell = { manager, statusBar, nodes, graph, index, flow, panel: () => GraphPanel.current, deactivate: () => manager.stop() };
  return shell;
}

export function deactivate(): Promise<void> | undefined {
  return shell?.deactivate();
}
