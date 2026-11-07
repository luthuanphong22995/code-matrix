import * as vscode from 'vscode';
import { toWirePath } from '../graph/controller';
import type { IndexController } from '../index/controller';
import { getOutputChannel } from '../output';
import type { GraphPanel } from '../panel/graphPanel';
import { ConnectionClosedError, ResponseError } from '../sidecar/jsonrpc';
import type { SidecarManager } from '../sidecar/manager';
import { FLOW_RETRACE, FLOW_TRACE, NOT_INDEXED } from '../sidecar/protocol';
import type {
  FlowRetraceParams,
  FlowRetraceResult,
  FlowTraceParams,
  FlowTraceResult,
  Trace,
  TraceOccurrence,
} from '../sidecar/protocol';
import type { FlowToWebview, WebviewToFlow } from './messages';

const KINDS = ['def', 'use', 'currentDef', 'currentUse'] as const;
type Kind = (typeof KINDS)[number];
export type Decorated = Record<Kind, vscode.Range[]>;

const none = (): Decorated => ({ def: [], use: [], currentDef: [], currentUse: [] });

// One occurrence, never a whole line: occurrences are 1-based lines, 0-based characters.
const rangeOf = (o: TraceOccurrence) => new vscode.Range(o.line - 1, o.startChar, o.line - 1, o.endChar);

// A trace request: the document and the primary cursor (0-based) it ran on.
interface Request {
  uri: vscode.Uri;
  line: number;
  character: number;
  // For `unsupportedLanguage { language: null }`: VS Code has no display-name API.
  languageId: string;
}

// Extension-host half of a trace: sends flow/trace for the primary cursor, shows every refusal as its message,
// keeps one pending request while no complete graph exists, owns the active trace and its editor decorations,
// and exchanges flow/* with the webview.
export class FlowController {
  private panel: GraphPanel | undefined;
  private active: { uri: vscode.Uri; trace: Trace; hop: number } | undefined;
  private pending: Request | undefined;
  // Bumped per request: only the latest reply applies.
  private seq = 0;
  // Bumped per retrace, separately: a graph/changed must not drop an in-flight user trace.
  private retraceSeq = 0;
  // The ranges last set per traced URI (VS Code has no decoration getter); re-set on every visible editor of it.
  private readonly shown = new Map<string, Decorated>();
  private readonly types: Record<Kind, vscode.TextEditorDecorationType>;

  constructor(
    private readonly manager: SidecarManager,
    private readonly index: IndexController,
    // Opens or focuses the panel as `Open Graph` does (and starts the sidecar on first use).
    private readonly open: () => void,
  ) {
    const lane = vscode.OverviewRulerLane.Center;
    const strong = new vscode.ThemeColor('editorOverviewRuler.wordHighlightStrongForeground');
    const weak = new vscode.ThemeColor('editorOverviewRuler.wordHighlightForeground');
    this.types = {
      def: vscode.window.createTextEditorDecorationType({ textDecoration: 'underline solid', overviewRulerColor: strong, overviewRulerLane: lane }),
      use: vscode.window.createTextEditorDecorationType({ textDecoration: 'underline dotted', overviewRulerColor: weak, overviewRulerLane: lane }),
      currentDef: vscode.window.createTextEditorDecorationType({
        backgroundColor: new vscode.ThemeColor('editor.wordHighlightStrongBackground'),
        overviewRulerColor: strong,
        overviewRulerLane: lane,
      }),
      currentUse: vscode.window.createTextEditorDecorationType({
        backgroundColor: new vscode.ThemeColor('editor.wordHighlightBackground'),
        overviewRulerColor: weak,
        overviewRulerLane: lane,
      }),
    };
    // R16: a completed run re-runs the pending request through the same checks; a cancelled one drops it.
    index.onDidFinish((outcome) => {
      const request = this.pending;
      this.pending = undefined;
      if (request && outcome === 'complete') void this.request(request);
    });
    // Decorations reappear when the traced file is shown again.
    vscode.window.onDidChangeVisibleTextEditors(() => this.paint());
  }

  // `Code Matrix: Trace Data Flow`.
  trace(): Promise<void> | undefined {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return undefined;
    const { line, character } = editor.selection.active;
    return this.request({ uri: editor.document.uri, line, character, languageId: editor.document.languageId });
  }

  // Idempotent per panel; the listener goes with the panel, and so do the trace and the pending request (R20).
  attach(panel: GraphPanel): void {
    if (this.panel === panel) return;
    this.panel = panel;
    const sub = panel.panel.webview.onDidReceiveMessage((msg: WebviewToFlow) => this.handleMessage(msg));
    panel.panel.onDidDispose(() => {
      sub.dispose();
      if (this.panel !== panel) return;
      this.panel = undefined;
      this.pending = undefined;
      // A reply still in flight would reopen the panel.
      this.seq++;
      this.end();
    });
  }

  handleMessage(msg: WebviewToFlow): void {
    switch (msg.type) {
      case 'flow/hop': {
        const active = this.active;
        if (!active || !Number.isInteger(msg.hop) || msg.hop < 1 || msg.hop > active.trace.hops.length) return;
        active.hop = msg.hop;
        this.decorate();
        void this.reveal();
        return;
      }
      case 'flow/clear':
        this.end();
        this.post({ type: 'flow/clear' });
        return;
    }
  }

  // R14: recomputes the active trace on graph/changed. Posts only after `refreshed` (that graph/changed's
  // graph/refresh) settles, and never reveals or opens: the user is editing the traced file.
  async retrace(refreshed: Promise<void>): Promise<void> {
    const active = this.active;
    const connection = this.manager.connection;
    if (!active || !connection) return;
    const seq = ++this.retraceSeq;
    const params: FlowRetraceParams = { functionId: active.trace.functionId, variableKey: active.trace.variableKey };
    let result: FlowRetraceResult;
    try {
      [result] = await Promise.all([connection.request<FlowRetraceResult>(FLOW_RETRACE, params), refreshed.catch(() => undefined)]);
    } catch (err) {
      if (err instanceof ConnectionClosedError || (err instanceof ResponseError && err.code === NOT_INDEXED)) return;
      getOutputChannel().appendLine(`[error] ${FLOW_RETRACE}: ${(err as Error).message}`);
      return;
    }
    const now = this.active;
    if (seq !== this.retraceSeq || now?.trace !== active.trace || connection !== this.manager.connection) return;
    switch (result.kind) {
      case 'trace': {
        const trace = result.trace;
        // Keep the current hop (read now: the user may have stepped meanwhile) by its occurrence ordinals, else hop 1.
        const was = active.trace.hops[now.hop - 1];
        const kept = was ? trace.hops.findIndex((h) => h.defOrdinal === was.defOrdinal && h.useOrdinal === was.useOrdinal) + 1 : 0;
        this.active = { uri: active.uri, trace, hop: kept || (trace.hops.length ? 1 : 0) };
        this.postShow();
        this.decorate();
        return;
      }
      case 'functionGone':
        void vscode.window.showInformationMessage(`Trace cleared: \`${result.function ?? active.trace.functionName}\` no longer exists`);
        break;
      case 'variableGone':
        void vscode.window.showInformationMessage(`Trace cleared: \`${result.variable}\` no longer exists in \`${result.function}\``);
        break;
    }
    this.end();
    this.post({ type: 'flow/clear' });
  }

  // Test-only seam: the ranges last set per decoration type for `uri`.
  decorated(uri: vscode.Uri): Decorated {
    return this.shown.get(uri.toString()) ?? none();
  }

  private async request(request: Request): Promise<void> {
    const seq = ++this.seq;
    if (!this.index.hasGraph) return this.pend(request);
    const connection = this.manager.connection;
    if (!connection) return;
    const params: FlowTraceParams = { path: request.uri.fsPath, line: request.line, character: request.character };
    let result: FlowTraceResult;
    try {
      result = await connection.request<FlowTraceResult>(FLOW_TRACE, params);
    } catch (err) {
      if (err instanceof ConnectionClosedError) return;
      if (err instanceof ResponseError && err.code === NOT_INDEXED) {
        if (seq === this.seq && connection === this.manager.connection) this.pend(request);
        return;
      }
      getOutputChannel().appendLine(`[error] ${FLOW_TRACE}: ${(err as Error).message}`);
      return;
    }
    if (seq !== this.seq || connection !== this.manager.connection) return;
    this.apply(result, request);
  }

  // R16: one pending request, the latest; nothing pends without a folder (`open` shows why).
  private pend(request: Request): void {
    if (!vscode.workspace.workspaceFolders?.length) return this.open();
    this.pending = request;
    void vscode.window.showInformationMessage('Trace will start when indexing finishes');
    this.open();
  }

  // Each refusal is exactly its design/ui.md § Messages text and touches nothing else.
  private apply(result: FlowTraceResult, request: Request): void {
    const info = (text: string) => void vscode.window.showInformationMessage(text);
    const file = () => vscode.workspace.asRelativePath(request.uri);
    switch (result.kind) {
      case 'trace':
        return this.show(request.uri, result.trace);
      case 'noIdentifier':
        return info('Place the cursor on a variable or parameter');
      case 'notLocal':
        return info(`\`${result.name}\` is not a local variable or parameter of \`${result.function}\``);
      case 'notInFunction':
        return info(`\`${result.name}\` is not inside a function`);
      case 'unsupportedLanguage':
        return info(`Data flow is not supported for ${result.language ?? request.languageId} yet`);
      case 'fileNotIndexed':
        return info(`\`${file()}\` is not indexed`);
      case 'fileFailed':
        void vscode.window.showWarningMessage(`\`${file()}\` failed to index — see the Code Matrix output`);
        return;
    }
  }

  // Replaces any active trace (R11): old decorations off, panel opened, trace posted, decorated, hop 1 revealed.
  private show(uri: vscode.Uri, trace: Trace): void {
    this.end();
    this.open();
    const hop = trace.hops.length ? 1 : 0;
    this.active = { uri, trace, hop };
    this.postShow();
    this.decorate();
    if (hop) void this.reveal();
  }

  private postShow(): void {
    if (!this.active) return;
    const { uri, trace, hop } = this.active;
    const roots = vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath) ?? [];
    // A traced file is indexed, so it lies under a root.
    this.post({ type: 'flow/show', trace, path: toWirePath(uri.fsPath, roots) ?? '', hop });
  }

  // Removes every decoration and forgets the trace.
  private end(): void {
    if (!this.active) return;
    this.shown.set(this.active.uri.toString(), none());
    this.active = undefined;
    this.paint();
  }

  private decorate(): void {
    if (!this.active) return;
    const { uri, trace, hop } = this.active;
    const current = trace.hops[hop - 1];
    const at = (ordinal: number) => [rangeOf(trace.occurrences.find((o) => o.ordinal === ordinal)!)];
    this.shown.set(uri.toString(), {
      def: trace.occurrences.filter((o) => o.role === 'def').map(rangeOf),
      // A capture is a use.
      use: trace.occurrences.filter((o) => o.role !== 'def').map(rangeOf),
      currentDef: current ? at(current.defOrdinal) : [],
      currentUse: current ? at(current.useOrdinal) : [],
    });
    this.paint();
  }

  private paint(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      const ranges = this.shown.get(editor.document.uri.toString());
      if (ranges) for (const kind of KINDS) editor.setDecorations(this.types[kind], ranges[kind]);
    }
  }

  // Shows the current hop's use beside the graph; focus stays in the panel (R7).
  private async reveal(): Promise<void> {
    if (!this.active) return;
    const { uri, trace, hop } = this.active;
    const use = trace.occurrences.find((o) => o.ordinal === trace.hops[hop - 1].useOrdinal)!;
    try {
      const editor = await vscode.window.showTextDocument(uri, { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true });
      editor.revealRange(rangeOf(use), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    } catch (err) {
      getOutputChannel().appendLine(`[error] ${FLOW_TRACE}: ${(err as Error).message}`);
    }
  }

  private post(message: FlowToWebview): void {
    void this.panel?.panel.webview.postMessage(message);
  }
}
