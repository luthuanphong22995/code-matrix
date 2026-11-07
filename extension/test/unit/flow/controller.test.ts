import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import { FlowController } from '../../../src/flow/controller';
import type { IndexController } from '../../../src/index/controller';
import type { GraphPanel } from '../../../src/panel/graphPanel';
import { SidecarManager } from '../../../src/sidecar/manager';
import type { FlowRetraceResult, FlowTraceResult, Trace } from '../../../src/sidecar/protocol';
import { FakeChildProcess } from '../fakes/fakeProcess';
import {
  EventEmitter,
  type FakeTextEditor,
  type FakeWebviewPanel,
  OverviewRulerLane,
  Range,
  TextEditorRevealType,
  Uri,
  ViewColumn,
  fakeEditor,
  outputLines,
  visibleEditorsChanged,
  window,
  workspace,
} from '../mocks/vscode';

// `total` in config.go's parseConfig: defs at 12 and 14, uses at 14 and 18; hop 1 is 12 → 14.
const trace: Trace = {
  functionId: 'f:parseConfig',
  functionName: 'parseConfig',
  variable: 'total',
  variableKey: 'total#1',
  status: 'hops',
  blocks: [],
  branches: [],
  occurrences: [
    { ordinal: 0, role: 'def', block: 'b2', line: 12, startChar: 1, endChar: 6, capture: false },
    { ordinal: 1, role: 'def', block: 'b3', line: 14, startChar: 2, endChar: 7, capture: false },
    { ordinal: 2, role: 'use', block: 'b3', line: 14, startChar: 10, endChar: 15, capture: false },
    { ordinal: 3, role: 'use', block: 'b4', line: 18, startChar: 9, endChar: 14, capture: true },
  ],
  hops: [
    { index: 1, defOrdinal: 0, useOrdinal: 2 },
    { index: 2, defOrdinal: 1, useOrdinal: 2 },
    { index: 3, defOrdinal: 0, useOrdinal: 3 },
    { index: 4, defOrdinal: 1, useOrdinal: 3 },
  ],
};
const noUses: Trace = { ...trace, status: 'noUses', occurrences: [trace.occurrences[0]], hops: [] };

const line = (l: number, s: number, e: number) => new Range(l - 1, s, l - 1, e);
const DECORATED = {
  def: [line(12, 1, 6), line(14, 2, 7)],
  use: [line(14, 10, 15), line(18, 9, 14)],
  currentDef: [line(12, 1, 6)],
  currentUse: [line(14, 10, 15)],
};
const EMPTY = { def: [], use: [], currentDef: [], currentUse: [] };

describe('FlowController', () => {
  let proc: FakeChildProcess;
  let manager: SidecarManager;
  let index: { hasGraph: boolean; finished: EventEmitter<'complete' | 'cancelled'>; onDidFinish: unknown };
  let flow: FlowController;
  let fake: FakeWebviewPanel;
  let open: ReturnType<typeof vi.fn>;
  let editor: FakeTextEditor;
  let reply: FlowTraceResult | { error: { code: number; message: string } };
  const uri = Uri.file('/proj/config.go');

  const traces = () => proc.received.filter((m) => m.method === 'flow/trace');
  const flowPosts = () =>
    fake.webview.postMessage.mock.calls.map((c) => c[0] as { type: string }).filter((m) => m.type.startsWith('flow/'));
  const settle = () => new Promise((r) => setTimeout(r, 20));
  // Runs the command and waits for its reply to be handled.
  const run = async () => {
    const n = traces().length;
    await flow.trace();
    expect(traces()).toHaveLength(n + 1);
  };
  let graphPanel: GraphPanel;
  const attachPanel = () => {
    fake = window.createWebviewPanel('codeMatrix.graph', 'Code Matrix', ViewColumn.One, {});
    graphPanel = { panel: fake } as unknown as GraphPanel;
    flow.attach(graphPanel);
  };
  const receive = (msg: unknown) => fake.webview.messageListener!(msg);
  const decorated = (u: Uri) => flow.decorated(u as unknown as vscode.Uri);

  beforeEach(async () => {
    outputLines.length = 0;
    vi.clearAllMocks();
    visibleEditorsChanged.dispose();
    process.env.CODE_MATRIX_SERVER_PATH = __filename;
    workspace.workspaceFolders = [{ uri: Uri.file('/proj'), name: 'proj', index: 0 }];
    workspace.root = '/proj';
    reply = { kind: 'trace', trace };
    proc = new FakeChildProcess();
    proc.replies.set('flow/trace', () => ('error' in reply ? reply : { result: reply }));
    manager = new SidecarManager('/ext', () => proc, () => 0);
    manager.start(['/proj']);
    await vi.waitFor(() => expect(manager.state).toEqual({ kind: 'ready' }));
    const finished = new EventEmitter<'complete' | 'cancelled'>();
    index = { hasGraph: true, finished, onDidFinish: finished.event };
    // openGraph's stand-in: the panel is already open and attached.
    open = vi.fn();
    flow = new FlowController(manager, index as unknown as IndexController, open);
    attachPanel();
    editor = fakeEditor(uri, 'go', 17, 9);
    window.activeTextEditor = editor;
    window.visibleTextEditors = [editor];
  });

  afterEach(async () => {
    window.activeTextEditor = undefined;
    window.visibleTextEditors = [];
    await manager.stop();
    delete process.env.CODE_MATRIX_SERVER_PATH;
  });

  it('creates four decoration types on the overview ruler centre lane', () => {
    const options = window.createTextEditorDecorationType.mock.calls.map((c) => c[0] as Record<string, unknown>);
    expect(options).toHaveLength(4);
    expect(options.map((o) => o.overviewRulerLane)).toEqual(Array(4).fill(OverviewRulerLane.Center));
    expect(options[0].textDecoration).toBe('underline solid');
    expect(options[1].textDecoration).toBe('underline dotted');
    expect(options.slice(2).map((o) => (o.backgroundColor as { id: string }).id)).toEqual([
      'editor.wordHighlightStrongBackground',
      'editor.wordHighlightBackground',
    ]);
  });

  it('no active editor does nothing', async () => {
    window.activeTextEditor = undefined;
    expect(flow.trace()).toBeUndefined();
    await settle();
    expect(traces()).toHaveLength(0);
  });

  describe('trace', () => {
    it('sends the primary cursor, opens the panel, posts flow/show hop 1, decorates and reveals beside (R1, R7)', async () => {
      await run();
      expect(traces()[0].params).toEqual({ path: '/proj/config.go', line: 17, character: 9 });
      expect(open).toHaveBeenCalledOnce();
      expect(flowPosts()).toEqual([{ type: 'flow/show', trace, path: 'config.go', hop: 1 }]);
      expect(decorated(uri)).toEqual(DECORATED);
      expect(editor.setDecorations).toHaveBeenCalledTimes(4);
      await vi.waitFor(() => expect(window.showTextDocument).toHaveBeenCalledOnce());
      expect(window.showTextDocument).toHaveBeenCalledWith(uri, { viewColumn: ViewColumn.Beside, preserveFocus: true });
      const shown = await window.showTextDocument.mock.results[0].value;
      expect(shown.revealRange).toHaveBeenCalledWith(line(14, 10, 15), TextEditorRevealType.InCenterIfOutsideViewport);
    });

    it('a noUses trace posts hop 0 and reveals nothing', async () => {
      reply = { kind: 'trace', trace: noUses };
      await run();
      expect(flowPosts()).toEqual([{ type: 'flow/show', trace: noUses, path: 'config.go', hop: 0 }]);
      expect(decorated(uri)).toEqual({ def: [line(12, 1, 6)], use: [], currentDef: [], currentUse: [] });
      await settle();
      expect(window.showTextDocument).not.toHaveBeenCalled();
    });

    it('a second trace replaces the first: the old file is cleared, one more flow/show (R11)', async () => {
      await run();
      const other = Uri.file('/proj/other.go');
      const otherEditor = fakeEditor(other);
      window.activeTextEditor = otherEditor;
      window.visibleTextEditors = [editor, otherEditor];
      reply = { kind: 'trace', trace: noUses };
      await run();
      expect(decorated(uri)).toEqual(EMPTY);
      expect(editor.setDecorations.mock.calls.slice(-4).map((c) => c[1])).toEqual([[], [], [], []]);
      expect(decorated(other).def).toEqual([line(12, 1, 6)]);
      expect(flowPosts()).toEqual([
        { type: 'flow/show', trace, path: 'config.go', hop: 1 },
        { type: 'flow/show', trace: noUses, path: 'other.go', hop: 0 },
      ]);
    });

    it('a stale reply is dropped', async () => {
      // The first request goes unanswered until the second has been applied.
      proc.replies.delete('flow/trace');
      const first = flow.trace();
      await vi.waitFor(() => expect(traces()).toHaveLength(1));
      const firstId = traces()[0].id;
      reply = { kind: 'trace', trace: noUses };
      proc.replies.set('flow/trace', () => ({ result: reply }));
      await flow.trace();
      expect(flowPosts()).toEqual([{ type: 'flow/show', trace: noUses, path: 'config.go', hop: 0 }]);
      (proc as unknown as { send(m: object): void }).send({ id: firstId, result: { kind: 'trace', trace } });
      await first;
      expect(flowPosts()).toHaveLength(1);
      expect(decorated(uri).currentDef).toEqual([]);
    });

    it('re-applies decorations when the traced file becomes visible again', async () => {
      await run();
      const again = fakeEditor(uri);
      window.visibleTextEditors = [again];
      visibleEditorsChanged.fire([again]);
      expect(again.setDecorations.mock.calls.map((c) => c[1])).toEqual(Object.values(DECORATED));
    });
  });

  describe('messages', () => {
    const cases: Array<[string, FlowTraceResult, 'info' | 'warning', string]> = [
      ['noIdentifier', { kind: 'noIdentifier' }, 'info', 'Place the cursor on a variable or parameter'],
      [
        'notLocal',
        { kind: 'notLocal', name: 'open', function: 'parseConfig' },
        'info',
        '`open` is not a local variable or parameter of `parseConfig`',
      ],
      ['notInFunction', { kind: 'notInFunction', name: 'defaultPath' }, 'info', '`defaultPath` is not inside a function'],
      ['unsupportedLanguage', { kind: 'unsupportedLanguage', language: 'Java' }, 'info', 'Data flow is not supported for Java yet'],
      ['unsupportedLanguage null', { kind: 'unsupportedLanguage', language: null }, 'info', 'Data flow is not supported for go yet'],
      ['fileNotIndexed', { kind: 'fileNotIndexed', file: 'ignored' }, 'info', '`config.go` is not indexed'],
      ['fileFailed', { kind: 'fileFailed', file: 'ignored' }, 'warning', '`config.go` failed to index — see the Code Matrix output'],
    ];

    for (const [name, result, kind, text] of cases) {
      it(`${name} shows exactly its message, posts nothing and keeps the active trace (R2, R3, R15, R18)`, async () => {
        await run();
        const posts = flowPosts().length;
        const decorations = editor.setDecorations.mock.calls.length;
        reply = result;
        await run();
        const [shown, other] = kind === 'info' ? [window.showInformationMessage, window.showWarningMessage] : [window.showWarningMessage, window.showInformationMessage];
        expect(shown.mock.calls).toEqual([[text]]);
        expect(other).not.toHaveBeenCalled();
        expect(flowPosts()).toHaveLength(posts);
        expect(editor.setDecorations).toHaveBeenCalledTimes(decorations);
        expect(decorated(uri)).toEqual(DECORATED);
        expect(open).toHaveBeenCalledOnce();
      });
    }

    it('-32603 logs [error] flow/trace and shows nothing, keeping the trace', async () => {
      await run();
      reply = { error: { code: -32603, message: 'lowering panicked' } };
      await run();
      expect(outputLines).toContain('[error] flow/trace: lowering panicked');
      expect(window.showInformationMessage).not.toHaveBeenCalled();
      expect(window.showWarningMessage).not.toHaveBeenCalled();
      expect(decorated(uri)).toEqual(DECORATED);
    });

    it('a closed connection is ignored', async () => {
      proc.replies.delete('flow/trace');
      const p = flow.trace();
      await vi.waitFor(() => expect(traces()).toHaveLength(1));
      await manager.stop();
      await p;
      expect(outputLines.filter((l) => l.startsWith('[error]'))).toEqual([]);
    });
  });

  describe('pending (R16)', () => {
    const PENDING = 'Trace will start when indexing finishes';

    it('!hasGraph pends without sending, opens the panel; complete sends only the latest position', async () => {
      index.hasGraph = false;
      await flow.trace();
      editor.selection = fakeEditor(uri, 'go', 13, 2).selection;
      await flow.trace();
      expect(window.showInformationMessage.mock.calls).toEqual([[PENDING], [PENDING]]);
      expect(open).toHaveBeenCalledTimes(2);
      expect(traces()).toHaveLength(0);

      index.hasGraph = true;
      index.finished.fire('complete');
      await vi.waitFor(() => expect(flowPosts()).toHaveLength(1));
      expect(traces().map((m) => m.params)).toEqual([{ path: '/proj/config.go', line: 13, character: 2 }]);
      index.finished.fire('complete');
      await settle();
      expect(traces()).toHaveLength(1);
    });

    it('-32010 pends; cancelled drops it silently', async () => {
      reply = { error: { code: -32010, message: 'NotIndexed' } };
      await run();
      expect(window.showInformationMessage).toHaveBeenCalledWith(PENDING);
      expect(open).toHaveBeenCalledOnce();
      expect(outputLines.filter((l) => l.startsWith('[error]'))).toEqual([]);
      reply = { kind: 'trace', trace };
      index.finished.fire('cancelled');
      index.finished.fire('complete');
      await settle();
      expect(traces()).toHaveLength(1);
      expect(window.showInformationMessage).toHaveBeenCalledOnce();
    });

    it('with no workspace folder only open() runs (it shows the folder message) and nothing pends', async () => {
      index.hasGraph = false;
      workspace.workspaceFolders = undefined;
      await flow.trace();
      expect(open).toHaveBeenCalledOnce();
      expect(window.showInformationMessage).not.toHaveBeenCalled();
      workspace.workspaceFolders = [{ uri: Uri.file('/proj'), name: 'proj', index: 0 }];
      index.hasGraph = true;
      index.finished.fire('complete');
      await settle();
      expect(traces()).toHaveLength(0);
    });

    it('closing the panel drops it', async () => {
      index.hasGraph = false;
      await flow.trace();
      fake.dispose();
      index.hasGraph = true;
      index.finished.fire('complete');
      await settle();
      expect(traces()).toHaveLength(0);
    });
  });

  describe('retrace (R14, R17)', () => {
    // The same trace one line down (a blank line inserted above parseConfig).
    const shifted: Trace = { ...trace, occurrences: trace.occurrences.map((o) => ({ ...o, line: o.line + 1 })) };
    let retraceReply: FlowRetraceResult | { error: { code: number; message: string } };
    const retraces = () => proc.received.filter((m) => m.method === 'flow/retrace');
    const answered = (r: typeof retraceReply) => ('error' in r ? r : { result: r });
    const deferred = () => {
      let resolve!: () => void;
      const promise = new Promise<void>((r) => (resolve = r));
      return { promise, resolve };
    };

    beforeEach(() => {
      retraceReply = { kind: 'trace', trace: shifted };
      proc.replies.set('flow/retrace', () => answered(retraceReply));
    });

    it('with no active trace sends nothing', async () => {
      await flow.retrace(Promise.resolve());
      await settle();
      expect(retraces()).toHaveLength(0);
    });

    it('sends functionId and variableKey and posts flow/show only after the refresh settles', async () => {
      await run();
      const refreshed = deferred();
      const done = flow.retrace(refreshed.promise);
      await vi.waitFor(() => expect(retraces()).toHaveLength(1));
      expect(retraces()[0].params).toEqual({ functionId: 'f:parseConfig', variableKey: 'total#1' });
      await settle();
      expect(flowPosts()).toHaveLength(1);
      refreshed.resolve();
      await done;
      expect(flowPosts().at(-1)).toEqual({ type: 'flow/show', trace: shifted, path: 'config.go', hop: 1 });
    });

    it('keeps the hop by ordinals, moves the decorations and never opens or reveals', async () => {
      await run();
      receive({ type: 'flow/hop', hop: 3 });
      await vi.waitFor(() => expect(window.showTextDocument).toHaveBeenCalledTimes(2));
      await flow.retrace(Promise.resolve());
      expect(flowPosts().at(-1)).toEqual({ type: 'flow/show', trace: shifted, path: 'config.go', hop: 3 });
      expect(decorated(uri).currentDef).toEqual([line(13, 1, 6)]);
      expect(decorated(uri).currentUse).toEqual([line(19, 9, 14)]);
      await settle();
      expect(open).toHaveBeenCalledOnce();
      expect(window.showTextDocument).toHaveBeenCalledTimes(2);
    });

    it('a trace without that ordinal pair posts hop 1; a hop-less one hop 0', async () => {
      await run();
      receive({ type: 'flow/hop', hop: 4 });
      retraceReply = { kind: 'trace', trace: { ...shifted, hops: shifted.hops.slice(0, 3) } };
      await flow.retrace(Promise.resolve());
      expect(flowPosts().at(-1)).toMatchObject({ type: 'flow/show', hop: 1 });
      retraceReply = { kind: 'trace', trace: noUses };
      await flow.retrace(Promise.resolve());
      expect(flowPosts().at(-1)).toMatchObject({ type: 'flow/show', hop: 0 });
      expect(decorated(uri)).toEqual({ def: [line(12, 1, 6)], use: [], currentDef: [], currentUse: [] });
    });

    const gone: Array<[string, FlowRetraceResult, string]> = [
      ['functionGone null', { kind: 'functionGone', function: null }, 'Trace cleared: `parseConfig` no longer exists'],
      ['functionGone f', { kind: 'functionGone', function: 'f' }, 'Trace cleared: `f` no longer exists'],
      [
        'variableGone',
        { kind: 'variableGone', variable: 'total', function: 'parseConfig' },
        'Trace cleared: `total` no longer exists in `parseConfig`',
      ],
    ];
    for (const [name, result, text] of gone) {
      it(`${name} shows its message, empties the decorations and posts flow/clear`, async () => {
        await run();
        retraceReply = result;
        await flow.retrace(Promise.resolve());
        expect(window.showInformationMessage.mock.calls).toEqual([[text]]);
        expect(decorated(uri)).toEqual(EMPTY);
        expect(editor.setDecorations.mock.calls.slice(-4).map((c) => c[1])).toEqual([[], [], [], []]);
        expect(flowPosts().at(-1)).toEqual({ type: 'flow/clear' });
      });
    }

    it('a second retrace before the first replies: only the second applies', async () => {
      await run();
      const first = deferred();
      const a = flow.retrace(first.promise);
      const b = flow.retrace(Promise.resolve());
      await b;
      first.resolve();
      await a;
      expect(flowPosts().filter((m) => m.type === 'flow/show')).toHaveLength(2);
    });

    it('a new trace or a flow/clear while a retrace is in flight drops its reply', async () => {
      await run();
      let refreshed = deferred();
      let p = flow.retrace(refreshed.promise);
      await run();
      refreshed.resolve();
      await p;
      expect(flowPosts()).toEqual([
        { type: 'flow/show', trace, path: 'config.go', hop: 1 },
        { type: 'flow/show', trace, path: 'config.go', hop: 1 },
      ]);

      refreshed = deferred();
      p = flow.retrace(refreshed.promise);
      receive({ type: 'flow/clear' });
      refreshed.resolve();
      await p;
      expect(flowPosts().at(-1)).toEqual({ type: 'flow/clear' });
      expect(decorated(uri)).toEqual(EMPTY);
    });

    it('a retrace started while a flow/trace is in flight does not drop that trace', async () => {
      await run();
      proc.replies.delete('flow/trace');
      const t = flow.trace();
      await vi.waitFor(() => expect(traces()).toHaveLength(2));
      await flow.retrace(Promise.resolve());
      reply = { kind: 'trace', trace: noUses };
      (proc as unknown as { send(m: object): void }).send({ id: traces()[1].id, result: reply });
      await t;
      expect(flowPosts().at(-1)).toEqual({ type: 'flow/show', trace: noUses, path: 'config.go', hop: 0 });
    });

    it('-32603 logs [error] flow/retrace and keeps the trace; -32010 is silent', async () => {
      await run();
      retraceReply = { error: { code: -32603, message: 'lowering panicked' } };
      await flow.retrace(Promise.resolve());
      expect(outputLines).toContain('[error] flow/retrace: lowering panicked');
      retraceReply = { error: { code: -32010, message: 'NotIndexed' } };
      await flow.retrace(Promise.resolve());
      expect(outputLines.filter((l) => l.startsWith('[error]'))).toHaveLength(1);
      expect(decorated(uri)).toEqual(DECORATED);
      expect(flowPosts()).toHaveLength(1);
    });

    it('R17: mid-run (hasGraph) a trace is sent at once, and the completing run retraces it', async () => {
      // hasGraph stays true while a re-run is indexing.
      await run();
      expect(window.showInformationMessage).not.toHaveBeenCalled();
      await flow.retrace(Promise.resolve());
      expect(flowPosts().at(-1)).toEqual({ type: 'flow/show', trace: shifted, path: 'config.go', hop: 1 });
    });
  });

  describe('webview', () => {
    it('flow/hop moves the current decorations and reveals its use; out of range is ignored (R7, R8)', async () => {
      await run();
      await vi.waitFor(() => expect(window.showTextDocument).toHaveBeenCalledOnce());
      receive({ type: 'flow/hop', hop: 4 });
      expect(decorated(uri)).toEqual({ ...DECORATED, currentDef: [line(14, 2, 7)], currentUse: [line(18, 9, 14)] });
      await vi.waitFor(() => expect(window.showTextDocument).toHaveBeenCalledTimes(2));
      const shown = await window.showTextDocument.mock.results[1].value;
      expect(shown.revealRange).toHaveBeenCalledWith(line(18, 9, 14), TextEditorRevealType.InCenterIfOutsideViewport);

      for (const hop of [0, 5, 1.5]) receive({ type: 'flow/hop', hop });
      await settle();
      expect(decorated(uri).currentUse).toEqual([line(18, 9, 14)]);
      expect(window.showTextDocument).toHaveBeenCalledTimes(2);
    });

    it('flow/hop with no active trace does nothing', async () => {
      receive({ type: 'flow/hop', hop: 1 });
      await settle();
      expect(editor.setDecorations).not.toHaveBeenCalled();
      expect(window.showTextDocument).not.toHaveBeenCalled();
    });

    it('flow/clear empties all four types, forgets the trace and echoes flow/clear (R12)', async () => {
      await run();
      receive({ type: 'flow/clear' });
      expect(decorated(uri)).toEqual(EMPTY);
      expect(editor.setDecorations.mock.calls.slice(-4).map((c) => c[1])).toEqual([[], [], [], []]);
      expect(flowPosts().at(-1)).toEqual({ type: 'flow/clear' });
      receive({ type: 'flow/hop', hop: 2 });
      expect(decorated(uri)).toEqual(EMPTY);
    });

    it('panel dispose empties all four types and posts nothing; a reattached panel gets no flow/show (R20)', async () => {
      await run();
      const before = fake;
      const sent = proc.received.length;
      fake.dispose();
      expect(decorated(uri)).toEqual(EMPTY);
      expect(editor.setDecorations.mock.calls.slice(-4).map((c) => c[1])).toEqual([[], [], [], []]);
      expect(flowPosts()).toEqual([{ type: 'flow/show', trace, path: 'config.go', hop: 1 }]);
      await settle();
      expect(proc.received).toHaveLength(sent);

      attachPanel();
      expect(fake).not.toBe(before);
      expect(flowPosts()).toEqual([]);
      receive({ type: 'flow/hop', hop: 2 });
      expect(decorated(uri)).toEqual(EMPTY);
    });

    it('attach is idempotent per panel', () => {
      flow.attach(graphPanel);
      flow.attach(graphPanel);
      expect(fake.webview.messageListeners).toHaveLength(1);
    });
  });
});
