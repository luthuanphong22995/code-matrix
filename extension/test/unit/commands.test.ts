import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import { openGraph, registerCommands, restartServer, showLog } from '../../src/commands';
import type { FlowController } from '../../src/flow/controller';
import { GraphController } from '../../src/graph/controller';
import { IndexController } from '../../src/index/controller';
import { nodes } from '../../src/nodes/registry';
import { getOutputChannel } from '../../src/output';
import { GraphPanel } from '../../src/panel/graphPanel';
import { SidecarManager } from '../../src/sidecar/manager';
import { FakeChildProcess } from './fakes/fakeProcess';
import { Uri, commands, window, workspace } from './mocks/vscode';

const index = { attach: vi.fn(), hasGraph: false } as unknown as IndexController;
const flow = { attach: vi.fn(), trace: vi.fn() } as unknown as FlowController;

const folder = (p: string, index: number) => ({ uri: Uri.file(p), name: p, index });

describe('openGraph', () => {
  let manager: SidecarManager;
  let graph: GraphController;
  const context = { extensionUri: Uri.file('/ext'), extensionPath: '/ext', subscriptions: [] } as unknown as vscode.ExtensionContext;
  const panel = () => window.createWebviewPanel.mock.results[0].value;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CODE_MATRIX_SERVER_PATH = __filename;
    manager = new SidecarManager('/ext', vi.fn(() => new FakeChildProcess()), () => 0);
    vi.spyOn(manager, 'start');
    graph = new GraphController(manager, nodes, index, flow);
    vi.spyOn(graph, 'attach');
    workspace.workspaceFolders = undefined;
  });

  afterEach(async () => {
    GraphPanel.current?.dispose();
    await manager.stop();
    delete process.env.CODE_MATRIX_SERVER_PATH;
  });

  it('with no folder shows the toast and does nothing else (R2)', () => {
    openGraph(context, manager, graph);
    expect(window.showInformationMessage).toHaveBeenCalledWith('Open a folder to analyze');
    expect(window.createWebviewPanel).not.toHaveBeenCalled();
    expect(manager.start).not.toHaveBeenCalled();
    expect(graph.attach).not.toHaveBeenCalled();
    expect(manager.state).toEqual({ kind: 'not-started' });
  });

  it('attaches the graph controller to the panel it opens', () => {
    workspace.workspaceFolders = [folder('/proj', 0)];
    openGraph(context, manager, graph);
    expect(graph.attach).toHaveBeenCalledWith(GraphPanel.current);
  });

  it('with an empty folder list also guards (R2)', () => {
    workspace.workspaceFolders = [];
    openGraph(context, manager, graph);
    expect(window.showInformationMessage).toHaveBeenCalledWith('Open a folder to analyze');
    expect(manager.start).not.toHaveBeenCalled();
  });

  it('opens one panel and starts the sidecar with the folder (R1, R4)', () => {
    workspace.workspaceFolders = [folder('/proj', 0)];
    openGraph(context, manager, graph);
    expect(window.createWebviewPanel).toHaveBeenCalledWith(
      'codeMatrix.graph',
      'Code Matrix',
      1,
      expect.objectContaining({ enableScripts: true, retainContextWhenHidden: true }),
    );
    expect(manager.start).toHaveBeenCalledOnce();
    expect(manager.start).toHaveBeenCalledWith(['/proj']);
    expect(GraphPanel.current).toBeDefined();
    expect(panel().webview.postMessage).toHaveBeenCalledWith({ type: 'shell/state', state: 'starting' });
  });

  it('a second call reveals the same panel and never restarts (R1, R4)', () => {
    workspace.workspaceFolders = [folder('/proj', 0)];
    openGraph(context, manager, graph);
    const first = GraphPanel.current;
    openGraph(context, manager, graph);
    expect(GraphPanel.current).toBe(first);
    expect(window.createWebviewPanel).toHaveBeenCalledOnce();
    expect(panel().reveal).toHaveBeenCalledOnce();
    expect(manager.start).toHaveBeenCalledOnce();
  });

  it('passes every root in one start call (R3)', () => {
    workspace.workspaceFolders = [folder('/api', 0), folder('/web', 1)];
    openGraph(context, manager, graph);
    expect(manager.start).toHaveBeenCalledOnce();
    expect(manager.start).toHaveBeenCalledWith(['/api', '/web']);
  });

  it('does not start when the sidecar is already ready (R4)', () => {
    workspace.workspaceFolders = [folder('/proj', 0)];
    manager.state = { kind: 'ready' };
    openGraph(context, manager, graph);
    expect(window.createWebviewPanel).toHaveBeenCalledOnce();
    expect(manager.start).not.toHaveBeenCalled();
    expect(panel().webview.postMessage).toHaveBeenCalledWith({ type: 'shell/state', state: 'ready' });
  });

  it('closing the panel clears the singleton and leaves the sidecar alone', () => {
    workspace.workspaceFolders = [folder('/proj', 0)];
    openGraph(context, manager, graph);
    const stop = vi.spyOn(manager, 'stop');
    GraphPanel.current!.dispose();
    expect(GraphPanel.current).toBeUndefined();
    expect(stop).not.toHaveBeenCalled();
    expect(manager.state).toEqual({ kind: 'starting' });
  });

  it('routes webview messages: retry → manager, restart / showLog → commands; unknown ignored (R6)', () => {
    workspace.workspaceFolders = [folder('/proj', 0)];
    openGraph(context, manager, graph);
    const retry = vi.spyOn(manager, 'retry').mockImplementation(() => undefined);
    const restart = vi.spyOn(manager, 'restart');
    const receive = panel().webview.messageListener!;

    receive({ type: 'shell/retry' });
    expect(retry).toHaveBeenCalledOnce();
    expect(commands.executeCommand).not.toHaveBeenCalled();

    receive({ type: 'shell/restart' });
    expect(commands.executeCommand).toHaveBeenLastCalledWith('codeMatrix.restartServer');
    receive({ type: 'shell/showLog' });
    expect(commands.executeCommand).toHaveBeenLastCalledWith('codeMatrix.showLog');

    receive({ type: 'shell/bogus' });
    expect(commands.executeCommand).toHaveBeenCalledTimes(2);
    expect(retry).toHaveBeenCalledOnce();
    expect(restart).not.toHaveBeenCalled();
  });

  it('shell/selectNode records the selection and replies shell/selection (R8)', () => {
    workspace.workspaceFolders = [folder('/proj', 0)];
    workspace.root = '/proj';
    nodes.register([
      { id: 'parseConfig', kind: 'function', name: 'parseConfig', path: '/proj/src/config.go', range: { startLine: 11, startCol: 0, endLine: 39, endCol: 1 } },
    ]);
    openGraph(context, manager, graph);
    const receive = panel().webview.messageListener!;
    const post = panel().webview.postMessage;
    expect(GraphPanel.current!.selectedNodeId).toBeNull();

    receive({ type: 'shell/selectNode', nodeId: 'parseConfig' });
    expect(post).toHaveBeenLastCalledWith({
      type: 'shell/selection',
      node: { kind: 'function', name: 'parseConfig', location: 'src/config.go:12' },
    });
    expect(GraphPanel.current!.selectedNodeId).toBe('parseConfig');

    receive({ type: 'shell/selectNode', nodeId: 'unknown' });
    expect(post).toHaveBeenLastCalledWith({ type: 'shell/selection', node: null });
    receive({ type: 'shell/selectNode', nodeId: null });
    expect(post).toHaveBeenLastCalledWith({ type: 'shell/selection', node: null });
    expect(GraphPanel.current!.selectedNodeId).toBeNull();
    nodes.clear();
  });

  it('shell/openNode for an unregistered id does nothing and keeps the selection (R9)', () => {
    workspace.workspaceFolders = [folder('/proj', 0)];
    openGraph(context, manager, graph);
    const receive = panel().webview.messageListener!;
    receive({ type: 'shell/selectNode', nodeId: 'gone' });
    receive({ type: 'shell/openNode', nodeId: 'gone' });
    expect(window.showWarningMessage).not.toHaveBeenCalled();
    expect(window.showTextDocument).not.toHaveBeenCalled();
    expect(workspace.openTextDocument).not.toHaveBeenCalled();
    expect(GraphPanel.current!.selectedNodeId).toBe('gone');
  });

  it('disposing the panel drops the message subscription and calls no stop / restart / retry', () => {
    workspace.workspaceFolders = [folder('/proj', 0)];
    openGraph(context, manager, graph);
    const spies = [vi.spyOn(manager, 'stop'), vi.spyOn(manager, 'restart'), vi.spyOn(manager, 'retry')];
    GraphPanel.current!.dispose();
    expect(panel().webview.messageListener).toBeUndefined();
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});

describe('restartServer and showLog', () => {
  it('restartServer does nothing while not-started (R5)', () => {
    const manager = new SidecarManager('/ext', vi.fn(), () => 0);
    const restart = vi.spyOn(manager, 'restart');
    expect(restartServer(manager)).toBeUndefined();
    expect(restart).not.toHaveBeenCalled();
  });

  it('restartServer restarts once when ready (R5)', async () => {
    const manager = new SidecarManager('/ext', vi.fn(), () => 0);
    manager.state = { kind: 'ready' };
    const restart = vi.spyOn(manager, 'restart').mockResolvedValue();
    await restartServer(manager);
    expect(restart).toHaveBeenCalledOnce();
  });

  it('showLog reveals the output channel without taking focus (R10)', () => {
    const channel = getOutputChannel();
    showLog();
    expect(channel.show).toHaveBeenCalledWith(true);
  });
});

describe('registerCommands', () => {
  it('registers the five declared commands; traceDataFlow calls flow.trace', () => {
    vi.clearAllMocks();
    const manager = new SidecarManager('/ext', vi.fn(), () => 0);
    const context = { extensionUri: Uri.file('/ext'), subscriptions: [] } as unknown as vscode.ExtensionContext;
    const disposables = registerCommands(context, manager, new GraphController(manager, nodes, index, flow), index, flow);
    expect(disposables).toHaveLength(5);
    expect(commands.registerCommand.mock.calls.map((c) => c[0])).toEqual([
      'codeMatrix.openGraph',
      'codeMatrix.restartServer',
      'codeMatrix.showLog',
      'codeMatrix.reindex',
      'codeMatrix.traceDataFlow',
    ]);
    commands.registerCommand.mock.calls[4][1]();
    expect(flow.trace).toHaveBeenCalledOnce();
  });
});

describe('codeMatrix.reindex', () => {
  it('runs only in ready / indexing; otherwise shows the not-running toast and sends nothing (R1, R10)', async () => {
    vi.clearAllMocks();
    process.env.CODE_MATRIX_SERVER_PATH = __filename;
    workspace.workspaceFolders = [folder('/proj', 0)];
    const proc = new FakeChildProcess();
    proc.replies.set('index/run', () => ({ result: { runId: 1 } }));
    const manager = new SidecarManager('/ext', () => proc, () => 0);
    const realIndex = new IndexController(manager);
    const context = { extensionUri: Uri.file('/ext'), subscriptions: [] } as unknown as vscode.ExtensionContext;
    registerCommands(context, manager, new GraphController(manager, nodes, realIndex, flow), realIndex, flow);
    const reindex = commands.registerCommand.mock.calls.find((c) => c[0] === 'codeMatrix.reindex')![1];
    const runs = () => proc.received.filter((m) => m.method === 'index/run');

    reindex();
    expect(window.showInformationMessage).toHaveBeenLastCalledWith('Code Matrix server is not running');

    manager.start(['/proj']);
    await vi.waitFor(() => expect(manager.state).toEqual({ kind: 'ready' }));
    // A live connection, but the state says failed: still the toast.
    manager.state = { kind: 'failed', cause: 'x' };
    reindex();
    expect(window.showInformationMessage).toHaveBeenCalledTimes(2);
    await new Promise((r) => setTimeout(r, 20));
    expect(runs()).toHaveLength(0);

    manager.state = { kind: 'ready' };
    reindex();
    await vi.waitFor(() => expect(runs()).toHaveLength(1));
    expect(window.showInformationMessage).toHaveBeenCalledTimes(2);
    await manager.stop();
    delete process.env.CODE_MATRIX_SERVER_PATH;
  });
});
