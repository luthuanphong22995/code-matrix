import * as vscode from 'vscode';
import { getOutputChannel } from '../output';
import { GraphPanel } from '../panel/graphPanel';
import { ConnectionClosedError } from '../sidecar/jsonrpc';
import type { SidecarManager } from '../sidecar/manager';
import { INDEX_CANCEL, INDEX_DONE, INDEX_PROGRESS, INDEX_RUN } from '../sidecar/protocol';
import type {
  IndexCancelParams,
  IndexCancelResult,
  IndexDoneParams,
  IndexProgressParams,
  IndexRunParams,
  IndexRunResult,
} from '../sidecar/protocol';
import type { SidecarState } from '../sidecar/state';
import type { IndexToWebview, WebviewToIndex } from './messages';

// The `files.exclude` globs that are on. ponytail: `{ when: … }` entries are skipped (sibling-file conditions
// aren't evaluated); evaluate them if users rely on them.
export function excludeGlobs(config: Record<string, unknown> | undefined): string[] {
  return Object.entries(config ?? {})
    .filter(([, on]) => on === true)
    .map(([glob]) => glob);
}

// A rejected index/* request never throws: a closed connection waits for the respawn, anything else is logged.
const logFailure = (method: string) => (err: Error) => {
  if (err instanceof ConnectionClosedError) return;
  getOutputChannel().appendLine(`[error] ${method}: ${err.message}`);
};

// Starts and cancels the sidecar's full index runs — when it becomes ready with the graph panel open, when the
// panel attaches to a ready sidecar that has no graph yet, on Re-index and on a workspace-folder change — and
// forwards their progress and outcome to the panel webview.
export class IndexController {
  // Whether the current sidecar process has completed a run.
  hasGraph = false;
  // The current run, from the last index/run result.
  runId: number | undefined;
  // The last forwarded progress of the run in flight, re-posted to a reopened panel.
  progress: IndexToWebview | undefined;
  // A run was replaced mid-flight: its `cancelled` done is not forwarded (the new run's `scanning` resets the strip).
  private superseded = false;
  private panel: GraphPanel | undefined;
  private readonly finished = new vscode.EventEmitter<'complete' | 'cancelled'>();
  // The outcome of every forwarded index/done (never a swallowed superseded `cancelled`), after `hasGraph` is set.
  readonly onDidFinish = this.finished.event;

  constructor(private readonly manager: SidecarManager) {
    manager.onNotification(INDEX_PROGRESS, ({ phase, done, total }: IndexProgressParams) => {
      this.progress = { type: 'index/progress', phase, done, total };
      this.post(this.progress);
    });
    manager.onNotification(INDEX_DONE, ({ outcome, indexed, failed, skipped }: IndexDoneParams) => {
      const hadGraph = this.hasGraph;
      if (outcome === 'complete') this.hasGraph = true;
      const superseded = this.superseded;
      this.superseded = false;
      if (superseded && outcome === 'cancelled') return;
      this.progress = undefined;
      this.post({ type: 'index/done', outcome, indexed, failed, skipped, hadGraph });
      this.finished.fire(outcome);
    });
    let previous: SidecarState['kind'] = manager.state.kind;
    manager.onDidChangeState((state) => {
      if (state.kind === 'starting') {
        this.hasGraph = false;
        this.progress = undefined;
        this.superseded = false;
        this.runId = undefined;
      }
      if (previous === 'starting' && state.kind === 'ready' && GraphPanel.current) this.run();
      previous = state.kind;
    });
    // Whether or not the panel is open; run() no-ops without a sidecar (R14).
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      getOutputChannel().appendLine('Workspace roots changed, starting full run');
      this.run();
    });
  }

  // Called by GraphController.attach for every newly attached panel. Closing the panel never cancels.
  attach(panel: GraphPanel): void {
    if (this.panel === panel) return;
    this.panel = panel;
    const sub = panel.panel.webview.onDidReceiveMessage((msg: WebviewToIndex) => this.handleMessage(msg));
    panel.panel.onDidDispose(() => {
      sub.dispose();
      if (this.panel === panel) this.panel = undefined;
    });
    if (this.progress) void panel.panel.webview.postMessage(this.progress);
    this.ensureGraph();
  }

  handleMessage(msg: WebviewToIndex): void {
    switch (msg.type) {
      case 'index/run':
        return this.reindex();
      case 'index/cancel':
        return this.cancel();
    }
  }

  ensureGraph(): void {
    if (this.manager.state.kind === 'ready' && !this.hasGraph) this.run();
  }

  // The one guard behind `Code Matrix: Re-index Workspace` and the webview's Re-index buttons.
  reindex(): void {
    const kind = this.manager.state.kind;
    if (kind === 'ready' || kind === 'indexing') this.run();
    else void vscode.window.showInformationMessage('Code Matrix server is not running');
  }

  // One index/run over every workspace root; failures are logged, never thrown. A run in flight is superseded.
  // ponytail: stale progress between this request and its response isn't filtered by runId; one round-trip.
  run(): void {
    const connection = this.manager.connection;
    const roots = vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath) ?? [];
    if (!connection || roots.length === 0) return;
    if (this.progress) this.superseded = true;
    const params: IndexRunParams = {
      roots,
      exclude: excludeGlobs(vscode.workspace.getConfiguration('files').get<Record<string, unknown>>('exclude')),
    };
    connection.request<IndexRunResult>(INDEX_RUN, params).then(({ runId }) => (this.runId = runId), logFailure(INDEX_RUN));
  }

  private cancel(): void {
    const connection = this.manager.connection;
    if (!connection || this.runId === undefined) return;
    const params: IndexCancelParams = { runId: this.runId };
    connection.request<IndexCancelResult>(INDEX_CANCEL, params).catch(logFailure(INDEX_CANCEL));
  }

  private post(message: IndexToWebview): void {
    void GraphPanel.current?.panel.webview.postMessage(message);
  }
}
