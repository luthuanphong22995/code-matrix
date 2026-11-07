import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import { IndexController, excludeGlobs } from '../../../src/index/controller';
import { GraphPanel } from '../../../src/panel/graphPanel';
import { SidecarManager } from '../../../src/sidecar/manager';
import { FakeChildProcess } from '../fakes/fakeProcess';
import { type FakeWebviewPanel, Uri, outputLines, window, workspace, workspaceFoldersChanged } from '../mocks/vscode';

describe('excludeGlobs', () => {
  it('keeps only the keys whose value is exactly true', () => {
    expect(excludeGlobs({ '**/.git': true, '**/out': false, '**/x': { when: '$(basename).ts' } })).toEqual(['**/.git']);
    expect(excludeGlobs(undefined)).toEqual([]);
  });
});

describe('IndexController', () => {
  let procs: FakeChildProcess[];
  let manager: SidecarManager;
  let index: IndexController;

  const ready = () => vi.waitFor(() => expect(manager.state).toEqual({ kind: 'ready' }));
  const proc = () => procs.at(-1)!;
  const runs = (p = proc()) => p.received.filter((m) => m.method === 'index/run');
  const settle = () => new Promise((r) => setTimeout(r, 20));

  beforeEach(() => {
    outputLines.length = 0;
    vi.clearAllMocks();
    process.env.CODE_MATRIX_SERVER_PATH = __filename;
    workspace.workspaceFolders = [
      { uri: Uri.file('/proj'), name: 'proj', index: 0 },
      { uri: Uri.file('/lib'), name: 'lib', index: 1 },
    ];
    workspace.settings = { 'files.exclude': { '**/.git': true, '**/out': false, '**/x': { when: '$(basename).ts' } } };
    procs = [];
    // Drop earlier tests' controllers' folder listeners.
    workspaceFoldersChanged.dispose();
    manager = new SidecarManager(
      '/ext',
      () => {
        const p = new FakeChildProcess();
        p.replies.set('index/run', () => ({ result: { runId: 1 } }));
        procs.push(p);
        return p;
      },
      () => 0,
    );
    index = new IndexController(manager);
    GraphPanel.current = undefined;
  });

  afterEach(async () => {
    if (GraphPanel.current instanceof GraphPanel) GraphPanel.current.dispose();
    GraphPanel.current = undefined;
    await manager.stop();
    delete process.env.CODE_MATRIX_SERVER_PATH;
  });

  const context = { extensionUri: Uri.file('/ext') } as unknown as vscode.ExtensionContext;
  // Opens a real GraphPanel over the mock webview and attaches the controller, as GraphController.attach does.
  const open = (): FakeWebviewPanel => {
    index.attach(GraphPanel.createOrShow(context, manager));
    return window.createWebviewPanel.mock.results.at(-1)!.value;
  };
  const indexPosts = (fake: FakeWebviewPanel) =>
    fake.webview.postMessage.mock.calls.map((c) => c[0] as { type: string }).filter((m) => m.type.startsWith('index/'));
  const done = (outcome: 'complete' | 'cancelled', indexed = 4) => ({ runId: 1, outcome, indexed, failed: 1, skipped: 0, durationMs: 1 });
  const posted = (outcome: 'complete' | 'cancelled', hadGraph: boolean, indexed = 4) => ({
    type: 'index/done',
    outcome,
    indexed,
    failed: 1,
    skipped: 0,
    hadGraph,
  });
  const scanning = { runId: 1, phase: 'scanning', done: 0, total: 0 };

  it('forwards index/progress as { type, phase, done, total }', async () => {
    manager.start(['/proj']);
    await ready();
    const fake = open();
    proc().notify('index/progress', { runId: 1, phase: 'indexing', done: 3, total: 10 });
    await vi.waitFor(() =>
      expect(indexPosts(fake)).toEqual([{ type: 'index/progress', phase: 'indexing', done: 3, total: 10 }]),
    );
  });

  it('index/done carries hadGraph from before it; webview index/run starts a new run (R9)', async () => {
    manager.start(['/proj']);
    await ready();
    const fake = open();
    await vi.waitFor(() => expect(runs()).toHaveLength(1));
    proc().notify('index/done', done('cancelled', 0));
    await vi.waitFor(() => expect(indexPosts(fake).at(-1)).toEqual(posted('cancelled', false, 0)));

    fake.webview.messageListener!({ type: 'index/run' });
    await vi.waitFor(() => expect(runs()).toHaveLength(2));
    proc().notify('index/done', done('complete'));
    await vi.waitFor(() => expect(indexPosts(fake).at(-1)).toEqual(posted('complete', false)));
    proc().notify('index/done', done('cancelled'));
    await vi.waitFor(() => expect(indexPosts(fake).at(-1)).toEqual(posted('cancelled', true)));
  });

  it('webview index/cancel sends index/cancel with the current runId, nothing before one is known', async () => {
    manager.start(['/proj']);
    await ready();
    proc().replies.set('index/run', () => ({ result: { runId: 7 } }));
    index.hasGraph = true; // no run on attach
    const fake = open();
    const cancels = () => proc().received.filter((m) => m.method === 'index/cancel');
    fake.webview.messageListener!({ type: 'index/cancel' });
    await settle();
    expect(cancels()).toHaveLength(0);

    index.run();
    await vi.waitFor(() => expect(index.runId).toBe(7));
    fake.webview.messageListener!({ type: 'index/cancel' });
    await vi.waitFor(() => expect(cancels().map((m) => m.params)).toEqual([{ runId: 7 }]));
    proc().replies.set('index/cancel', () => ({ error: { code: -32603, message: 'boom' } }));
    fake.webview.messageListener!({ type: 'index/cancel' });
    await vi.waitFor(() => expect(outputLines).toContain('[error] index/cancel: boom'));
  });

  it('Re-index during a run swallows the superseded run’s cancelled done (R10)', async () => {
    manager.start(['/proj']);
    await ready();
    const fake = open();
    await vi.waitFor(() => expect(runs()).toHaveLength(1));
    proc().notify('index/progress', { ...scanning, phase: 'indexing', done: 1, total: 4 });
    await vi.waitFor(() => expect(indexPosts(fake)).toHaveLength(1));

    fake.webview.messageListener!({ type: 'index/run' });
    await vi.waitFor(() => expect(runs()).toHaveLength(2));
    proc().notify('index/done', done('cancelled', 1));
    proc().notify('index/progress', { ...scanning, runId: 2 });
    await vi.waitFor(() => expect(indexPosts(fake)).toHaveLength(2));
    expect(indexPosts(fake).at(-1)).toEqual({ type: 'index/progress', phase: 'scanning', done: 0, total: 0 });
    expect(indexPosts(fake).some((m) => m.type === 'index/done')).toBe(false);
  });

  it('onDidFinish fires every forwarded outcome after hasGraph is set, with or without a panel; never a superseded cancelled', async () => {
    const outcomes: Array<[string, boolean]> = [];
    index.onDidFinish((o) => outcomes.push([o, index.hasGraph]));
    manager.start(['/proj']);
    await ready();
    proc().notify('index/done', done('cancelled', 0));
    proc().notify('index/done', done('complete'));
    await vi.waitFor(() => expect(outcomes).toEqual([['cancelled', false], ['complete', true]]));

    const fake = open();
    index.run();
    await vi.waitFor(() => expect(runs()).toHaveLength(1));
    proc().notify('index/progress', { ...scanning, phase: 'indexing', done: 1, total: 4 });
    await vi.waitFor(() => expect(indexPosts(fake)).toHaveLength(1));
    fake.webview.messageListener!({ type: 'index/run' });
    await vi.waitFor(() => expect(runs()).toHaveLength(2));
    proc().notify('index/done', done('cancelled', 1));
    proc().notify('index/done', done('cancelled', 1));
    await vi.waitFor(() => expect(outcomes).toHaveLength(3));
    await settle();
    expect(outcomes.at(-1)).toEqual(['cancelled', true]);
    expect(outcomes).toHaveLength(3);
  });

  it('a reopened panel gets the in-progress strip, none after a done; starting forgets it; closing never cancels', async () => {
    manager.start(['/proj']);
    await ready();
    let fake = open();
    proc().status('indexing');
    await vi.waitFor(() => expect(manager.state.kind).toBe('indexing'));
    proc().notify('index/progress', { ...scanning, phase: 'indexing', done: 2, total: 4 });
    await vi.waitFor(() => expect(indexPosts(fake)).toHaveLength(1));
    GraphPanel.current!.dispose();
    await settle();
    expect(proc().received.filter((m) => m.method === 'index/cancel')).toHaveLength(0);

    fake = open();
    expect(indexPosts(fake)).toEqual([{ type: 'index/progress', phase: 'indexing', done: 2, total: 4 }]);
    proc().notify('index/done', done('complete'));
    await vi.waitFor(() => expect(index.hasGraph).toBe(true));
    GraphPanel.current!.dispose();
    fake = open();
    expect(indexPosts(fake)).toEqual([]);

    proc().notify('index/progress', scanning);
    await vi.waitFor(() => expect(index.progress).toBeDefined());
    await manager.restart();
    expect(index.progress).toBeUndefined();
  });

  it('a workspace-folder change logs and runs with the new roots (R14)', async () => {
    manager.start(['/proj']);
    await ready();
    workspace.workspaceFolders = [
      { uri: Uri.file('/proj'), name: 'proj', index: 0 },
      { uri: Uri.file('/added'), name: 'added', index: 1 },
    ];
    workspaceFoldersChanged.fire({});
    expect(outputLines).toContain('Workspace roots changed, starting full run');
    await vi.waitFor(() => expect(runs()).toHaveLength(1));
    expect(runs()[0].params).toEqual({ roots: ['/proj', '/added'], exclude: ['**/.git'] });
  });

  it('starting → ready with the panel open sends one index/run with every root and the enabled excludes', async () => {
    GraphPanel.current = {} as GraphPanel;
    manager.start(['/proj', '/lib']);
    await ready();
    await vi.waitFor(() => expect(runs()).toHaveLength(1));
    expect(runs()[0].params).toEqual({ roots: ['/proj', '/lib'], exclude: ['**/.git'] });
  });

  it('starting → ready with no panel sends nothing', async () => {
    manager.start(['/proj']);
    await ready();
    await settle();
    expect(runs()).toHaveLength(0);
  });

  it('ensureGraph runs while ready with no graph, not after index/done complete, again after a restart', async () => {
    manager.start(['/proj']);
    await ready();
    index.ensureGraph();
    await vi.waitFor(() => expect(runs()).toHaveLength(1));
    proc().notify('index/done', { runId: 1, outcome: 'complete', indexed: 1, failed: 0, skipped: 0, durationMs: 1 });
    await vi.waitFor(() => expect(index.hasGraph).toBe(true));
    index.ensureGraph();
    await settle();
    expect(runs()).toHaveLength(1);

    await manager.restart();
    expect(index.hasGraph).toBe(false);
    await ready();
    index.ensureGraph();
    await vi.waitFor(() => expect(runs()).toHaveLength(1));
    expect(procs).toHaveLength(2);
  });

  it('index/done cancelled leaves hasGraph false', async () => {
    manager.start(['/proj']);
    await ready();
    proc().notify('index/done', { runId: 1, outcome: 'cancelled', indexed: 0, failed: 0, skipped: 0, durationMs: 1 });
    await settle();
    expect(index.hasGraph).toBe(false);
  });

  it('a closed connection logs nothing; any other rejection logs [error] index/run', async () => {
    manager.start(['/proj']);
    await ready();
    proc().replies.delete('index/run');
    index.run();
    await vi.waitFor(() => expect(runs()).toHaveLength(1));
    await manager.stop();
    await settle();
    expect(outputLines.filter((l) => l.startsWith('[error]'))).toEqual([]);

    manager.start(['/proj']);
    await ready();
    proc().replies.set('index/run', () => ({ error: { code: -32001, message: 'InvalidRoots' } }));
    index.run();
    await vi.waitFor(() => expect(outputLines).toContain('[error] index/run: InvalidRoots'));
  });
});
