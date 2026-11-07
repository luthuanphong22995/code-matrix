import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphController, toNodeRecord, toWirePath } from '../../../src/graph/controller';
import type { FlowController } from '../../../src/flow/controller';
import type { IndexController } from '../../../src/index/controller';
import { NodeRegistry } from '../../../src/nodes/registry';
import type { GraphPanel } from '../../../src/panel/graphPanel';
import { SidecarManager } from '../../../src/sidecar/manager';
import type { GraphNode, GraphSlice } from '../../../src/sidecar/protocol';
import { FakeChildProcess } from '../fakes/fakeProcess';
import { type FakeWebviewPanel, Uri, ViewColumn, configurationChanged, outputLines, window, workspace } from '../mocks/vscode';

const file: GraphNode = { id: 'f1', kind: 'file', name: 'config.go', path: 'config.go' };
const fn: GraphNode = { id: 'p1', kind: 'function', name: 'parseConfig', path: 'config.go', startLine: 14, endLine: 18, parentId: 'f1' };
const fmt: GraphNode = { id: 'u1', kind: 'unresolved', name: 'fmt' };
const files: GraphSlice = {
  nodes: [file, fmt],
  edges: [{ id: 'e1', kind: 'imports', fromId: 'f1', toId: 'u1', resolved: false }],
};
const roots = [{ name: 'proj', prefix: '' }];

describe('toNodeRecord', () => {
  it('single root: unprefixed, 0-based range; file nodes open at the top; placeholders have none', () => {
    expect(toNodeRecord(fn, ['/proj'])).toEqual({
      id: 'p1',
      kind: 'function',
      name: 'parseConfig',
      path: '/proj/config.go',
      range: { startLine: 13, startCol: 0, endLine: 17, endCol: 0 },
    });
    expect(toNodeRecord(file, ['/proj'])!.range).toEqual({ startLine: 0, startCol: 0, endLine: 0, endCol: 0 });
    expect(toNodeRecord(fmt, ['/proj'])).toBeUndefined();
  });

  it('several roots map by basename prefix, a repeated basename by ~N', () => {
    const roots = ['/a/api', '/b/web', '/c/api'];
    const at = (p: string) => toNodeRecord({ ...file, path: p }, roots)?.path;
    expect(at('api/main.go')).toBe('/a/api/main.go');
    expect(at('web/src/x.ts')).toBe('/b/web/src/x.ts');
    expect(at('api~2/main.go')).toBe('/c/api/main.go');
  });
});

describe('toWirePath', () => {
  const roundTrip = (fsPath: string, roots: string[]) => {
    const wire = toWirePath(fsPath, roots);
    expect(wire).toBeDefined();
    expect(toNodeRecord({ ...file, path: wire }, roots)!.path).toBe(fsPath);
    return wire;
  };

  it('a single root is unprefixed and /-separated', () => {
    expect(roundTrip('/proj/src/config.go', ['/proj'])).toBe('src/config.go');
  });

  it('two roots, and a repeated basename, take the index prefixes', () => {
    const roots = ['/a/api', '/b/web', '/c/api'];
    expect(roundTrip('/a/api/main.go', roots)).toBe('api/main.go');
    expect(roundTrip('/b/web/src/x.ts', roots)).toBe('web/src/x.ts');
    expect(roundTrip('/c/api/main.go', roots)).toBe('api~2/main.go');
  });

  it('a path under no root is undefined', () => {
    expect(toWirePath('/elsewhere/x.go', ['/proj'])).toBeUndefined();
    expect(toWirePath('/proj', ['/proj'])).toBeUndefined();
    expect(toWirePath('/project/x.go', ['/proj'])).toBeUndefined();
  });
});

describe('GraphController', () => {
  let proc: FakeChildProcess;
  let manager: SidecarManager;
  let registry: NodeRegistry;
  let controller: GraphController;
  let fake: FakeWebviewPanel;
  let panel: GraphPanel;
  let index: { attach: ReturnType<typeof vi.fn>; hasGraph: boolean };
  let flow: { attach: ReturnType<typeof vi.fn>; retrace: ReturnType<typeof vi.fn> };
  // Each post with whether every openable node it names was already registered at that moment.
  let posts: Array<{ msg: { type: string }; registered: boolean }>;

  const ready = () => vi.waitFor(() => expect(manager.state).toEqual({ kind: 'ready' }));
  const lastPost = () => posts.at(-1)?.msg;
  // Attach and wait for the first graph/refresh, so a later expand isn't overtaken by it.
  const attached = async () => {
    controller.attach(panel);
    await vi.waitFor(() => expect(posts).toHaveLength(1));
  };

  beforeEach(async () => {
    outputLines.length = 0;
    vi.clearAllMocks();
    process.env.CODE_MATRIX_SERVER_PATH = __filename;
    workspace.workspaceFolders = [{ uri: Uri.file('/proj'), name: 'proj', index: 0 }];
    proc = new FakeChildProcess();
    proc.replies.set('graph/files', () => ({ result: files }));
    manager = new SidecarManager('/ext', () => proc, () => 0);
    registry = new NodeRegistry();
    index = { attach: vi.fn(), hasGraph: false };
    flow = { attach: vi.fn(), retrace: vi.fn() };
    controller = new GraphController(manager, registry, index as unknown as IndexController, flow as unknown as FlowController);
    fake = window.createWebviewPanel('codeMatrix.graph', 'Code Matrix', ViewColumn.One, {});
    posts = [];
    type Posted = { type: string; nodes?: GraphNode[]; node?: GraphNode; files?: GraphSlice; expanded?: GraphSlice[] };
    fake.webview.postMessage.mockImplementation((msg: Posted) => {
      const named = [
        ...(msg.nodes ?? []),
        ...(msg.node ? [msg.node] : []),
        ...(msg.files?.nodes ?? []),
        ...(msg.expanded ?? []).flatMap((s) => s.nodes),
      ].filter((n) => n.kind !== 'unresolved');
      posts.push({ msg, registered: named.every((n) => registry.get(n.id)?.path.startsWith('/proj/')) });
    });
    panel = { panel: fake } as unknown as GraphPanel;
    manager.start(['/proj']);
    await ready();
  });

  afterEach(async () => {
    await manager.stop();
    delete process.env.CODE_MATRIX_SERVER_PATH;
  });

  it('on attach while ready registers the file layer before posting graph/refresh; placeholders stay out', async () => {
    controller.attach(panel);
    await vi.waitFor(() => expect(lastPost()).toEqual({ type: 'graph/refresh', files, expanded: [], roots, scoped: false, total: files.nodes.length }));
    expect(posts[0].registered).toBe(true);
    expect(registry.get('f1')!.path).toBe('/proj/config.go');
    expect(registry.has('u1')).toBe(false);
  });

  it('attach hands the panel to the index controller, then the flow controller', () => {
    controller.attach(panel);
    expect(index.attach).toHaveBeenCalledWith(panel);
    expect(flow.attach).toHaveBeenCalledWith(panel);
    expect(index.attach.mock.invocationCallOrder[0]).toBeLessThan(flow.attach.mock.invocationCallOrder[0]);
  });

  it('attach while indexing fetches the previous graph only when the index controller has one (R5)', async () => {
    const fileRequests = () => proc.received.filter((m) => m.method === 'graph/files');
    manager.state = { kind: 'indexing' };
    controller.attach(panel);
    await new Promise((r) => setTimeout(r, 20));
    expect(fileRequests()).toHaveLength(0);

    index.hasGraph = true;
    const other = { panel: window.createWebviewPanel('codeMatrix.graph', 'Code Matrix', ViewColumn.One, {}) } as unknown as GraphPanel;
    controller.attach(other);
    await vi.waitFor(() => expect(fileRequests()).toHaveLength(1));
  });

  it('a zero-node file layer posts graph/refresh with empty files (no graph/empty)', async () => {
    proc.replies.set('graph/files', () => ({ result: { nodes: [], edges: [] } }));
    controller.attach(panel);
    await vi.waitFor(() => expect(lastPost()).toEqual({ type: 'graph/refresh', files: { nodes: [], edges: [] }, expanded: [], roots, scoped: false, total: 0 }));
  });

  it('graph/expand registers the subtree before posting graph/expanded; graph/details likewise', async () => {
    proc.replies.set('graph/expand', () => ({ result: { nodes: [fn], edges: [] } }));
    proc.replies.set('graph/node', () => ({ result: { node: fn, inbound: [], outbound: [] } }));
    await attached();
    await controller.handleMessage({ type: 'graph/expand', fileId: 'f1' });
    expect(lastPost()).toEqual({ type: 'graph/expanded', fileId: 'f1', nodes: [fn], edges: [] });
    expect(posts.at(-1)!.registered).toBe(true);
    expect(registry.get('p1')!.range.startLine).toBe(13);
    expect(controller.expandedFiles.has('f1')).toBe(true);
    await controller.handleMessage({ type: 'graph/collapse', fileId: 'f1' });
    expect(controller.expandedFiles.has('f1')).toBe(false);
    await controller.handleMessage({ type: 'graph/details', nodeId: 'p1' });
    expect(lastPost()).toEqual({ type: 'graph/nodeDetails', node: fn, inbound: [], outbound: [] });
  });

  it('graph/changed re-expands remembered files into one graph/refresh, registered first', async () => {
    proc.replies.set('graph/expand', () => ({ result: { nodes: [fn], edges: [] } }));
    await attached();
    await controller.handleMessage({ type: 'graph/expand', fileId: 'f1' });
    posts.length = 0;
    proc.notify('graph/changed', { removedNodeIds: [] });
    await vi.waitFor(() =>
      expect(lastPost()).toEqual({ type: 'graph/refresh', files, expanded: [{ fileId: 'f1', nodes: [fn], edges: [] }], roots, scoped: false, total: files.nodes.length }),
    );
    expect(posts).toHaveLength(1);
    expect(posts[0].registered).toBe(true);
    expect(controller.expandedFiles.has('f1')).toBe(true);
  });

  it('graph/changed hands flow.retrace, once, a promise that settles after graph/refresh was posted (R14)', async () => {
    await attached();
    posts.length = 0;
    proc.notify('graph/changed', { removedNodeIds: [] });
    await vi.waitFor(() => expect(flow.retrace).toHaveBeenCalledOnce());
    await flow.retrace.mock.calls[0][0];
    expect(lastPost()).toEqual({ type: 'graph/refresh', files, expanded: [], roots, scoped: false, total: files.nodes.length });
    expect(flow.retrace).toHaveBeenCalledOnce();
  });

  it('a file layer without a remembered file (as after a restart) drops it from expandedFiles and the registry', async () => {
    proc.replies.set('graph/expand', () => ({ result: { nodes: [fn], edges: [] } }));
    await attached();
    await controller.handleMessage({ type: 'graph/expand', fileId: 'f1' });
    expect(registry.has('p1')).toBe(true);
    const at = { startLine: 0, startCol: 0, endLine: 0, endCol: 0 };
    registry.register([{ id: 'f2', kind: 'file', name: 'main.go', path: '/proj/old.go', range: at }]);
    const main: GraphNode = { id: 'f2', kind: 'file', name: 'main.go', path: 'main.go' };
    const expands = () => proc.received.filter((m) => m.method === 'graph/expand').length;
    const before = expands();
    proc.replies.set('graph/files', () => ({ result: { nodes: [main], edges: [] } }));
    posts.length = 0;
    proc.notify('graph/changed', { removedNodeIds: [] });
    await vi.waitFor(() => expect(posts).toHaveLength(1));
    expect(lastPost()).toEqual({ type: 'graph/refresh', files: { nodes: [main], edges: [] }, expanded: [], roots, scoped: false, total: 1 });
    expect(posts[0].registered).toBe(true);
    expect(expands()).toBe(before);
    expect(controller.expandedFiles.size).toBe(0);
    expect([...registry.keys()]).toEqual(['f2']);
    expect(registry.get('f2')!.path).toBe('/proj/main.go');
  });

  it('ids in removedNodeIds leave the registry', async () => {
    controller.attach(panel);
    await vi.waitFor(() => expect(posts).toHaveLength(1));
    const deleted = vi.spyOn(registry, 'delete');
    proc.notify('graph/changed', { removedNodeIds: ['p1'] });
    await vi.waitFor(() => expect(posts).toHaveLength(2));
    expect(deleted).toHaveBeenCalledWith('p1');
  });

  it('overlapping refreshes post once (the later); a refresh whose connection was replaced posts nothing', async () => {
    controller.attach(panel);
    await vi.waitFor(() => expect(posts).toHaveLength(1));
    void controller.refresh();
    await controller.refresh();
    await new Promise((r) => setTimeout(r, 20));
    expect(posts).toHaveLength(2);
    const connection = manager.connection;
    const pending = controller.refresh();
    manager.connection = undefined;
    await pending;
    manager.connection = connection;
    expect(posts).toHaveLength(2);
  });

  it('attach to a new panel clears expandedFiles', () => {
    controller.attach(panel);
    controller.expandedFiles.add('f1');
    const other = { panel: window.createWebviewPanel('codeMatrix.graph', 'Code Matrix', ViewColumn.One, {}) } as unknown as GraphPanel;
    controller.attach(other);
    expect(controller.expandedFiles.size).toBe(0);
  });

  it('-32010 posts and logs nothing; other errors log [error] graph/<method>', async () => {
    proc.replies.set('graph/files', () => ({ error: { code: -32010, message: 'not indexed' } }));
    controller.attach(panel);
    await controller.refresh();
    expect(posts).toEqual([]);
    expect(outputLines).toEqual([]);
    proc.replies.set('graph/node', () => ({ error: { code: -32011, message: 'unknown node' } }));
    await controller.handleMessage({ type: 'graph/details', nodeId: 'gone' });
    expect(posts).toEqual([]);
    expect(outputLines).toEqual(['[error] graph/node: unknown node']);
  });

  it('tree/loadFile registers the slice and posts tree/fileLoaded without touching expandedFiles (node-tree R8)', async () => {
    proc.replies.set('graph/expand', () => ({ result: { nodes: [fn], edges: [] } }));
    await attached();
    await controller.handleMessage({ type: 'tree/loadFile', fileId: 'f1' });
    expect(proc.received.filter((m) => m.method === 'graph/expand')).toHaveLength(1);
    expect(lastPost()).toEqual({ type: 'tree/fileLoaded', fileId: 'f1', nodes: [fn], edges: [] });
    expect(posts.at(-1)!.registered).toBe(true);
    expect(controller.expandedFiles.size).toBe(0);
  });

  it('tree/loadFile on an UnknownNode posts tree/loadFailed and logs nothing', async () => {
    proc.replies.set('graph/expand', () => ({ error: { code: -32011, message: 'UnknownNode' } }));
    await attached();
    await controller.handleMessage({ type: 'tree/loadFile', fileId: 'gone' });
    expect(lastPost()).toEqual({ type: 'tree/loadFailed', id: 'gone' });
    expect(outputLines).toEqual([]);
    expect(controller.expandedFiles.size).toBe(0);
  });

  it('tree/loadLinks registers the node and its non-placeholder linked nodes before posting tree/links (node-tree R7, R8)', async () => {
    const callee: GraphNode = { id: 'p2', kind: 'function', name: 'readFile', path: 'util.go', startLine: 3, endLine: 5, parentId: 'f2' };
    const outbound = [
      { id: 'c1', kind: 'calls' as const, fromId: 'p1', toId: 'p2', resolved: true },
      { id: 'c2', kind: 'calls' as const, fromId: 'p1', toId: 'u1', resolved: false },
    ];
    proc.replies.set('graph/node', () => ({ result: { node: fn, inbound: [], outbound, linked: [callee, fmt] } }));
    await attached();
    fake.webview.postMessage.mockImplementationOnce((msg: { type: string }) => {
      posts.push({ msg, registered: registry.has('p1') && registry.has('p2') && !registry.has('u1') });
    });
    await controller.handleMessage({ type: 'tree/loadLinks', nodeId: 'p1' });
    expect(proc.received.filter((m) => m.method === 'graph/node').at(-1)!.params).toEqual({ nodeId: 'p1' });
    expect(lastPost()).toEqual({ type: 'tree/links', node: fn, inbound: [], outbound, linked: [callee, fmt] });
    expect(posts.at(-1)!.registered).toBe(true);
    expect(registry.get('p2')!.path).toBe('/proj/util.go');
    expect(controller.expandedFiles.size).toBe(0);
    proc.replies.set('graph/node', () => ({ result: { node: fn, inbound: [], outbound: [] } }));
    await controller.handleMessage({ type: 'tree/loadLinks', nodeId: 'p1' });
    expect(lastPost()).toEqual({ type: 'tree/links', node: fn, inbound: [], outbound: [], linked: [] });
  });

  it('tree/loadLinks on an UnknownNode posts tree/loadFailed and logs nothing', async () => {
    proc.replies.set('graph/node', () => ({ error: { code: -32011, message: 'UnknownNode' } }));
    await attached();
    await controller.handleMessage({ type: 'tree/loadLinks', nodeId: 'gone' });
    expect(lastPost()).toEqual({ type: 'tree/loadFailed', id: 'gone' });
    expect(outputLines).toEqual([]);
  });

  it('graph/refresh carries every workspace folder with its root prefix, in order', async () => {
    workspace.workspaceFolders = [
      { uri: Uri.file('/a/api'), name: 'api', index: 0 },
      { uri: Uri.file('/b/web'), name: 'web', index: 1 },
      { uri: Uri.file('/c/api'), name: 'api', index: 2 },
    ];
    controller.attach(panel);
    await vi.waitFor(() => expect(posts).toHaveLength(1));
    expect((lastPost() as unknown as { roots: unknown }).roots).toEqual([
      { name: 'api', prefix: 'api/' },
      { name: 'web', prefix: 'web/' },
      { name: 'api', prefix: 'api~2/' },
    ]);
  });

  it('attach twice adds one listener; the listener goes with the panel', async () => {
    controller.attach(panel);
    controller.attach(panel);
    expect(fake.webview.messageListeners).toHaveLength(1);
    await vi.waitFor(() => expect(posts).toHaveLength(1));
    fake.dispose();
    expect(fake.webview.messageListeners).toHaveLength(0);
    proc.notify('graph/changed', { removedNodeIds: [] });
    await new Promise((r) => setTimeout(r, 20));
    expect(proc.received.filter((m) => m.method === 'graph/files')).toHaveLength(1);
  });
  describe('scoped view (code-graph R13, R14, R18, R19)', () => {
    const fn: GraphNode = { id: 'fn1', kind: 'function', name: 'parseConfig', path: 'config.go', startLine: 3, endLine: 9, parentId: 'f1' };
    const refreshOf = (msg: { type: string }) => msg as unknown as { scoped: boolean; total: number };
    afterEach(() => delete workspace.settings['codeMatrix.graph.scopeThreshold']);

    it('graph/refresh is scoped only when total exceeds the threshold (default 2,000)', async () => {
      proc.replies.set('graph/files', () => ({ result: { ...files, total: 2001 } }));
      await attached();
      expect(refreshOf(lastPost()!)).toMatchObject({ scoped: true, total: 2001 });
      workspace.settings['codeMatrix.graph.scopeThreshold'] = 2001;
      proc.notify('graph/changed', { removedNodeIds: [] });
      await vi.waitFor(() => expect(posts).toHaveLength(2));
      expect(refreshOf(lastPost()!)).toMatchObject({ scoped: false, total: 2001 });
    });

    it('a threshold change refreshes from the snapshot without an index run', async () => {
      proc.replies.set('graph/files', () => ({ result: { ...files, total: 50 } }));
      await attached();
      workspace.settings['codeMatrix.graph.scopeThreshold'] = 10;
      configurationChanged.fire('codeMatrix.graph.scopeThreshold');
      await vi.waitFor(() => expect(posts).toHaveLength(2));
      expect(refreshOf(lastPost()!)).toMatchObject({ scoped: true, total: 50 });
      configurationChanged.fire('editor.fontSize');
      await new Promise((r) => setTimeout(r, 20));
      expect(posts).toHaveLength(2);
      expect(proc.received.some((m) => m.method === 'index/run')).toBe(false);
    });

    it('graph/scope asks graph/neighbourhood and posts graph/scoped, registered first', async () => {
      proc.replies.set('graph/neighbourhood', () => ({ result: { nodes: [fn], edges: [] } }));
      await attached();
      await controller.handleMessage({ type: 'graph/scope', nodeId: 'fn1', hops: 2 });
      expect(proc.received.find((m) => m.method === 'graph/neighbourhood')?.params).toEqual({ nodeId: 'fn1', hops: 2 });
      expect(lastPost()).toEqual({ type: 'graph/scoped', nodeId: 'fn1', nodes: [fn], edges: [] });
      expect(posts.at(-1)!.registered).toBe(true);
    });

    it('only the latest graph/scope posts; one overtaken by a refresh or a respawn posts nothing', async () => {
      proc.replies.set('graph/neighbourhood', () => ({ result: { nodes: [fn], edges: [] } }));
      await attached();
      void controller.handleMessage({ type: 'graph/scope', nodeId: 'f1', hops: 1 });
      await controller.handleMessage({ type: 'graph/scope', nodeId: 'fn1', hops: 1 });
      await new Promise((r) => setTimeout(r, 20));
      expect(posts.filter((p) => p.msg.type === 'graph/scoped').map((p) => (p.msg as unknown as { nodeId: string }).nodeId)).toEqual(['fn1']);
      const before = posts.length;
      const overtaken = controller.handleMessage({ type: 'graph/scope', nodeId: 'fn1', hops: 1 });
      await controller.refresh();
      await overtaken;
      expect(posts.slice(before).map((p) => p.msg.type)).toEqual(['graph/refresh']);
      const connection = manager.connection;
      const pending = controller.handleMessage({ type: 'graph/scope', nodeId: 'fn1', hops: 1 });
      manager.connection = undefined;
      await pending;
      manager.connection = connection;
      expect(posts.slice(before).map((p) => p.msg.type)).toEqual(['graph/refresh']);
    });

    it('graph/scope on an UnknownNode posts an empty graph/scoped and logs nothing', async () => {
      proc.replies.set('graph/neighbourhood', () => ({ error: { code: -32011, message: 'unknown node' } }));
      await attached();
      await controller.handleMessage({ type: 'graph/scope', nodeId: 'gone', hops: 1 });
      expect(lastPost()).toEqual({ type: 'graph/scoped', nodeId: 'gone', nodes: [], edges: [] });
      expect(outputLines).toEqual([]);
    });
  });
});
