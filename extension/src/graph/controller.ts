import * as path from 'node:path';
import * as vscode from 'vscode';
import type { FlowController } from '../flow/controller';
import type { IndexController } from '../index/controller';
import type { NodeRecord, NodeRegistry } from '../nodes/registry';
import { getOutputChannel } from '../output';
import type { GraphPanel } from '../panel/graphPanel';
import { ConnectionClosedError, ResponseError } from '../sidecar/jsonrpc';
import type { SidecarManager } from '../sidecar/manager';
import { GRAPH_CHANGED, GRAPH_EXPAND, GRAPH_FILES, GRAPH_NEIGHBOURHOOD, GRAPH_NODE, NOT_INDEXED, UNKNOWN_NODE } from '../sidecar/protocol';
import type {
  GraphChangedParams,
  GraphExpandParams,
  GraphFiles,
  GraphNeighbourhoodParams,
  GraphNode,
  GraphNodeDetail,
  GraphNodeParams,
  GraphSlice,
} from '../sidecar/protocol';
import type { DebugOp, DebugState, GraphToWebview, WebviewToGraph } from './messages';

// The index's root prefixes (`core/crates/index/src/walk.rs` `prefixes`): one root is unprefixed; several are
// `<basename>/`, a repeated basename `<basename>~N/`, in root order.
export function rootPrefixes(roots: string[]): string[] {
  if (roots.length <= 1) return roots.map(() => '');
  const seen = new Map<string, number>();
  return roots.map((root) => {
    const name = path.basename(root) || 'root';
    const n = (seen.get(name) ?? 0) + 1;
    seen.set(name, n);
    return n === 1 ? `${name}/` : `${name}~${n}/`;
  });
}

// The wire path of an absolute path (`toNodeRecord`'s mapping inverted): the first root it lies under, `/`-separated;
// `undefined` under no root.
export function toWirePath(fsPath: string, roots: string[]): string | undefined {
  const prefixes = rootPrefixes(roots);
  for (const [i, root] of roots.entries()) {
    const rel = path.relative(root, fsPath);
    if (rel === '' || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) continue;
    return prefixes[i] + rel.split(path.sep).join('/');
  }
  return undefined;
}

// The registry record for a wire node: absolute path, 0-based range. Placeholders (no path) have none.
export function toNodeRecord(node: GraphNode, roots: string[]): NodeRecord | undefined {
  if (node.kind === 'unresolved' || node.path === undefined) return undefined;
  const wirePath = node.path;
  const prefixes = rootPrefixes(roots);
  const i = prefixes.findIndex((p) => wirePath.startsWith(p));
  if (i < 0) return undefined;
  const rel = wirePath.slice(prefixes[i].length);
  // File nodes carry no lines on the wire: they open at the top.
  const range =
    node.startLine === undefined || node.endLine === undefined
      ? { startLine: 0, startCol: 0, endLine: 0, endCol: 0 }
      : { startLine: node.startLine - 1, startCol: 0, endLine: node.endLine - 1, endCol: 0 };
  return { id: node.id, kind: node.kind, name: node.name, path: path.join(roots[i], ...rel.split('/')), range };
}

const SCOPE_THRESHOLD = 'codeMatrix.graph.scopeThreshold';

// Extension-host half of the canvas: fetches graph/* from the sidecar, registers every openable node with the
// shell before any payload naming it reaches the webview, and relays the webview's graph/* messages.
export class GraphController {
  // Files the webview has expanded since the panel opened; a refresh re-expands those still in the file layer.
  readonly expandedFiles = new Set<string>();
  private panel: GraphPanel | undefined;
  private debugReply: ((state: DebugState) => void) | undefined;
  // Bumped per refresh: only the latest one posts.
  private seq = 0;
  // Bumped per graph/scope: only the latest one posts, and only if no refresh or respawn came in between.
  private scopeSeq = 0;

  constructor(
    private readonly manager: SidecarManager,
    private readonly nodes: NodeRegistry,
    private readonly index: IndexController,
    private readonly flow: FlowController,
  ) {
    // The only graph/changed handler (the manager keeps one per method): the trace follows the refreshed graph.
    manager.onNotification(GRAPH_CHANGED, (params: GraphChangedParams) => void this.flow.retrace(this.refresh(params?.removedNodeIds ?? [])));
    // A new threshold re-reads the snapshot's file layer: no re-index (code-graph R19).
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(SCOPE_THRESHOLD)) void this.refresh();
    });
  }

  // Idempotent per panel; the listener goes with the panel.
  attach(panel: GraphPanel): void {
    if (this.panel === panel) return;
    this.panel = panel;
    const sub = panel.panel.webview.onDidReceiveMessage((msg: WebviewToGraph) => void this.handleMessage(msg));
    panel.panel.onDidDispose(() => {
      sub.dispose();
      if (this.panel === panel) this.panel = undefined;
    });
    // A new panel is a fresh webview: nothing expanded yet.
    this.expandedFiles.clear();
    // Mid-run the sidecar still serves the last published graph: a reopened panel draws it under the strip (R5).
    const kind = this.manager.state.kind;
    if (kind === 'ready' || (kind === 'indexing' && this.index.hasGraph)) void this.refresh();
    this.index.attach(panel);
    this.flow.attach(panel);
  }

  // Re-fetches the file layer and every remembered expansion still in it, brings the registry in line with that
  // payload, then posts it as one graph/refresh. Survival is keyed off the payload: after a restart
  // removedNodeIds is always [] (the new process has no previous graph).
  async refresh(removedNodeIds: string[] = []): Promise<void> {
    if (!this.panel) return;
    const seq = ++this.seq;
    const connection = this.manager.connection;
    const files = await this.request<GraphFiles>(GRAPH_FILES);
    if (!files || seq !== this.seq || connection !== this.manager.connection) return;
    const fileIds = new Set(files.nodes.map((n) => n.id));
    const wanted = [...this.expandedFiles].filter((id) => fileIds.has(id));
    const slices = await Promise.all(
      wanted.map(async (fileId) => {
        const params: GraphExpandParams = { fileId };
        const slice = await this.request<GraphSlice>(GRAPH_EXPAND, params);
        return slice && { fileId, ...slice };
      }),
    );
    if (seq !== this.seq || connection !== this.manager.connection) return;
    // A re-expand that failed drops only that file.
    const expanded = slices.filter((s) => s !== undefined);
    this.expandedFiles.clear();
    for (const s of expanded) this.expandedFiles.add(s.fileId);
    const payload = [...files.nodes, ...expanded.flatMap((s) => s.nodes)];
    const present = new Set(payload.map((n) => n.id));
    for (const id of removedNodeIds) this.nodes.delete(id);
    for (const id of [...this.nodes.keys()]) if (!present.has(id)) this.nodes.delete(id);
    this.register(payload);
    const folders = vscode.workspace.workspaceFolders ?? [];
    const prefixes = rootPrefixes(folders.map((f) => f.uri.fsPath));
    const roots = folders.map((f, i) => ({ name: f.name, prefix: prefixes[i] }));
    const total = files.total ?? files.nodes.length;
    const scoped = total > (vscode.workspace.getConfiguration('codeMatrix.graph').get<number>('scopeThreshold') ?? 2000);
    this.post({ type: 'graph/refresh', files: { nodes: files.nodes, edges: files.edges }, expanded, roots, scoped, total });
  }

  async handleMessage(msg: WebviewToGraph): Promise<void> {
    switch (msg.type) {
      case 'graph/expand': {
        const params: GraphExpandParams = { fileId: msg.fileId };
        const slice = await this.request<GraphSlice>(GRAPH_EXPAND, params);
        if (!slice) return;
        this.expandedFiles.add(msg.fileId);
        this.register(slice.nodes);
        this.post({ type: 'graph/expanded', fileId: msg.fileId, ...slice });
        return;
      }
      // The tree's own load: never an expansion of the canvas (node-tree R8).
      case 'tree/loadFile': {
        const params: GraphExpandParams = { fileId: msg.fileId };
        const slice = await this.request<GraphSlice>(GRAPH_EXPAND, params, () => this.post({ type: 'tree/loadFailed', id: msg.fileId }));
        if (!slice) return;
        this.register(slice.nodes);
        this.post({ type: 'tree/fileLoaded', fileId: msg.fileId, ...slice });
        return;
      }
      // The tree's edge groups: registers the far ends too, never touches the canvas (node-tree R7, R8).
      case 'tree/loadLinks': {
        const params: GraphNodeParams = { nodeId: msg.nodeId };
        const detail = await this.request<GraphNodeDetail>(GRAPH_NODE, params, () => this.post({ type: 'tree/loadFailed', id: msg.nodeId }));
        if (!detail) return;
        const linked = detail.linked ?? [];
        this.register([detail.node, ...linked]);
        this.post({ type: 'tree/links', node: detail.node, inbound: detail.inbound, outbound: detail.outbound, linked });
        return;
      }
      // Scoped view: the selection's neighbourhood; an UnknownNode answers with no nodes (code-graph R14, R18).
      case 'graph/scope': {
        const params: GraphNeighbourhoodParams = { nodeId: msg.nodeId, hops: msg.hops };
        const [scopeSeq, seq, connection] = [++this.scopeSeq, this.seq, this.manager.connection];
        const stale = () => scopeSeq !== this.scopeSeq || seq !== this.seq || connection !== this.manager.connection;
        const gone = () => stale() || this.post({ type: 'graph/scoped', nodeId: msg.nodeId, nodes: [], edges: [] });
        const slice = await this.request<GraphSlice>(GRAPH_NEIGHBOURHOOD, params, gone);
        if (!slice || stale()) return;
        this.register(slice.nodes);
        this.post({ type: 'graph/scoped', nodeId: msg.nodeId, ...slice });
        return;
      }
      case 'graph/collapse':
        this.expandedFiles.delete(msg.fileId);
        return;
      case 'graph/details': {
        const params: GraphNodeParams = { nodeId: msg.nodeId };
        const detail = await this.request<GraphNodeDetail>(GRAPH_NODE, params);
        if (!detail) return;
        this.register([detail.node]);
        this.post({ type: 'graph/nodeDetails', ...detail });
        return;
      }
      case 'graph/debugState': {
        const { type: _type, ...state } = msg;
        this.debugReply?.(state);
        this.debugReply = undefined;
        return;
      }
    }
  }

  // Test-only seam: asks the webview to run `op` and resolves with what it then draws.
  debug(op: DebugOp): Promise<DebugState> {
    return new Promise((resolve) => {
      this.debugReply = resolve;
      this.post({ type: 'graph/debug', ...op });
    });
  }

  private register(graphNodes: GraphNode[]): void {
    const roots = vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath) ?? [];
    this.nodes.register(graphNodes.flatMap((n) => toNodeRecord(n, roots) ?? []));
  }

  private post(message: GraphToWebview): void {
    void this.panel?.panel.webview.postMessage(message);
  }

  // NotIndexed waits for graph/changed and a closed connection for the respawn; UnknownNode goes to `unknownNode`
  // when the caller gives one; anything else is logged.
  private async request<R>(method: string, params?: unknown, unknownNode?: () => void): Promise<R | undefined> {
    const connection = this.manager.connection;
    if (!connection) return undefined;
    try {
      return await connection.request<R>(method, params);
    } catch (err) {
      if (err instanceof ConnectionClosedError || (err instanceof ResponseError && err.code === NOT_INDEXED)) return undefined;
      if (unknownNode && err instanceof ResponseError && err.code === UNKNOWN_NODE) {
        unknownNode();
        return undefined;
      }
      getOutputChannel().appendLine(`[error] ${method}: ${(err as Error).message}`);
      return undefined;
    }
  }
}
