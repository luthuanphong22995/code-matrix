import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { nodeLocation, openNodeInEditor } from '../nodes/openNode';
import { nodes } from '../nodes/registry';
import type { SidecarManager } from '../sidecar/manager';
import type { SidecarState } from '../sidecar/state';
import type { ShellToWebview, WebviewToShell } from './messages';

// The window's single `Code Matrix` editor tab (R1). Closing it leaves the sidecar running.
export class GraphPanel {
  static current: GraphPanel | undefined;

  private readonly subscriptions: Array<{ dispose(): void }>;
  private selected: string | null = null;

  // The node the Details region shows; changed only by `shell/selectNode`.
  get selectedNodeId(): string | null {
    return this.selected;
  }

  static createOrShow(context: vscode.ExtensionContext, manager: SidecarManager): GraphPanel {
    if (GraphPanel.current) {
      GraphPanel.current.panel.reveal();
      return GraphPanel.current;
    }
    const panel = vscode.window.createWebviewPanel('codeMatrix.graph', 'Code Matrix', vscode.ViewColumn.One, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist')],
    });
    return (GraphPanel.current = new GraphPanel(panel, context.extensionUri, manager));
  }

  private constructor(
    readonly panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    private readonly manager: SidecarManager,
  ) {
    panel.webview.html = getHtml(panel.webview, extensionUri, randomBytes(16).toString('hex'));
    this.subscriptions = [
      manager.onDidChangeState((state) => this.post(state)),
      panel.webview.onDidReceiveMessage((msg: WebviewToShell) => this.handleMessage(msg)),
    ];
    // Closing never stops, restarts or retries: a closed failed panel retries nothing.
    panel.onDidDispose(() => {
      for (const s of this.subscriptions) s.dispose();
      if (GraphPanel.current === this) GraphPanel.current = undefined;
    });
    this.post(manager.state);
  }

  dispose(): void {
    this.panel.dispose();
  }

  // Every webview message lands here. restart / showLog run the commands so panel and palette share one path.
  handleMessage(msg: WebviewToShell): void {
    switch (msg.type) {
      case 'shell/retry':
        this.manager.retry();
        break;
      case 'shell/restart':
        void vscode.commands.executeCommand('codeMatrix.restartServer');
        break;
      case 'shell/showLog':
        void vscode.commands.executeCommand('codeMatrix.showLog');
        break;
      case 'shell/selectNode':
        this.selected = msg.nodeId;
        this.postSelection();
        break;
      case 'shell/openNode': {
        // Opening never changes the selection, even when the file is missing (R9).
        const record = nodes.get(msg.nodeId);
        if (record) void openNodeInEditor(record);
        break;
      }
    }
  }

  private postSelection(): void {
    const r = this.selected === null ? undefined : nodes.get(this.selected);
    const message: ShellToWebview = {
      type: 'shell/selection',
      node: r ? { kind: r.kind, name: r.name, location: nodeLocation(r) } : null,
    };
    void this.panel.webview.postMessage(message);
  }

  private post(state: SidecarState): void {
    const message: ShellToWebview =
      state.kind === 'failed'
        ? { type: 'shell/state', state: 'failed', cause: state.cause }
        : { type: 'shell/state', state: state.kind === 'not-started' ? 'starting' : state.kind };
    void this.panel.webview.postMessage(message);
  }
}

type WebviewLike = Pick<vscode.Webview, 'cspSource' | 'asWebviewUri'>;

// Static region markup; ids are the seam other features cite. No inline handlers, no remote resources.
export function getHtml(webview: WebviewLike, extensionUri: vscode.Uri, nonce: string): string {
  const dist = (file: string) => webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', file)).toString();
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src ${webview.cspSource};">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${dist('webview.css')}">
  <title>Code Matrix</title>
</head>
<body>
  <div id="toolbar">
    <span id="label">Code Matrix</span>
    <span id="state-text"></span>
    <span id="toolbar-slot"></span>
    <button id="btn-reindex" disabled>Re-index</button>
    <button id="btn-restart" disabled>Restart Server</button>
    <button id="btn-showlog" disabled>Show Log</button>
    <button id="btn-tree" aria-pressed="true" disabled>Tree</button>
    <button id="btn-details" disabled>Details</button>
  </div>
  <div id="content">
    <div id="tree"></div>
    <div id="main">
      <div id="strips">
        <div id="index-strip" hidden><span id="text-index-progress"></span><button id="btn-index-cancel">Cancel</button><a id="link-index-show-log" href="#">Show Log</a><button id="btn-index-dismiss" title="Dismiss">×</button></div>
        <div id="flow-strip" hidden><button id="btn-trace-prev">Prev</button><button id="btn-trace-next">Next</button><span id="text-trace-status"></span><button id="btn-trace-clear">Clear trace</button></div>
      </div>
      <div id="overlay">
        <h2 id="overlay-heading" hidden></h2>
        <p id="overlay-text"></p>
        <div id="overlay-actions" hidden><button id="btn-retry">Retry</button><button id="btn-failed-showlog">Show Log</button></div>
        <button id="btn-cancelled-reindex" hidden>Re-index</button>
      </div>
    </div>
    <aside id="details">
      <p id="details-empty">Select a node to see its details</p>
      <dl id="details-fields" hidden>
        <dt>Kind</dt><dd id="details-kind"></dd>
        <dt>Name</dt><dd id="details-name"></dd>
        <dt>Location</dt><dd id="details-location"></dd>
      </dl>
      <button id="btn-open" hidden>Open in editor</button>
    </aside>
  </div>
  <script nonce="${nonce}" src="${dist('webview.js')}"></script>
</body>
</html>`;
}
