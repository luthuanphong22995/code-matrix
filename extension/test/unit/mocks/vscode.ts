// Hand-written stand-in for the `vscode` module, which only exists inside the editor.
// Minimal shapes only; later changes grow what their tests need.

import { vi } from 'vitest';

export class Position {
  constructor(
    readonly line: number,
    readonly character: number,
  ) {}
}

export class Range {
  readonly start: Position;
  readonly end: Position;
  constructor(start: Position, end: Position);
  constructor(startLine: number, startCol: number, endLine: number, endCol: number);
  constructor(a: Position | number, b: Position | number, c?: number, d?: number) {
    this.start = typeof a === 'number' ? new Position(a, b as number) : a;
    this.end = typeof a === 'number' ? new Position(c!, d!) : (b as Position);
  }
}

export class Selection extends Range {
  constructor(
    readonly anchor: Position,
    readonly active: Position,
  ) {
    super(anchor, active);
  }
}

export enum TextEditorRevealType {
  Default = 0,
  InCenter = 1,
  InCenterIfOutsideViewport = 2,
}

export enum OverviewRulerLane {
  Left = 1,
  Center = 2,
  Right = 4,
  Full = 7,
}

export class Uri {
  private constructor(
    readonly scheme: string,
    readonly fsPath: string,
  ) {}
  static file(path: string): Uri {
    return new Uri('file', path);
  }
  static joinPath(base: Uri, ...segments: string[]): Uri {
    return new Uri(base.scheme, [base.fsPath, ...segments].join('/'));
  }
  get path(): string {
    return this.fsPath;
  }
  toString(): string {
    return `${this.scheme}://${this.fsPath}`;
  }
}

export class EventEmitter<T> {
  private listeners: Array<(e: T) => void> = [];
  readonly event = (listener: (e: T) => void) => {
    this.listeners.push(listener);
    return { dispose: () => (this.listeners = this.listeners.filter((l) => l !== listener)) };
  };
  fire(e: T): void {
    for (const l of [...this.listeners]) l(e);
  }
  dispose(): void {
    this.listeners = [];
  }
}

export class ThemeColor {
  constructor(readonly id: string) {}
}

export enum StatusBarAlignment {
  Left = 1,
  Right = 2,
}

export enum ViewColumn {
  Active = -1,
  Beside = -2,
  One = 1,
  Two = 2,
}

// Every line appended to any output channel, in order; tests reset it with `outputLines.length = 0`.
export const outputLines: string[] = [];

export interface FakeStatusBarItem {
  id: string;
  alignment: StatusBarAlignment;
  text: string;
  command: string | undefined;
  backgroundColor: ThemeColor | undefined;
  show: ReturnType<typeof vi.fn>;
  hide: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
}

export interface FakeWebviewPanel {
  viewType: string;
  title: string;
  column: ViewColumn;
  options: unknown;
  webview: {
    html: string;
    cspSource: string;
    asWebviewUri: (uri: Uri) => Uri;
    postMessage: ReturnType<typeof vi.fn>;
    messageListeners: Array<(msg: unknown) => void>;
    // Calls every `onDidReceiveMessage` listener (undefined when none); tests call it to stand in for a webview post.
    readonly messageListener: ((msg: unknown) => void) | undefined;
    onDidReceiveMessage: (listener: (msg: unknown) => void) => { dispose(): void };
  };
  reveal: ReturnType<typeof vi.fn>;
  onDidDispose: (listener: () => void) => { dispose(): void };
  dispose: () => void;
}

export interface FakeTextEditor {
  document: { uri: Uri; languageId: string };
  selection: Selection;
  setDecorations: ReturnType<typeof vi.fn>;
  revealRange: ReturnType<typeof vi.fn>;
}

// A fake editor of `uri` with its primary cursor at the 0-based `line:character`; tests put it in
// `window.activeTextEditor` / `window.visibleTextEditors`.
export function fakeEditor(uri: Uri, languageId = 'go', line = 0, character = 0): FakeTextEditor {
  const at = new Position(line, character);
  return { document: { uri, languageId }, selection: new Selection(at, at), setDecorations: vi.fn(), revealRange: vi.fn() };
}

// Tests fire it after changing `window.visibleTextEditors`.
export const visibleEditorsChanged = new EventEmitter<unknown>();

export const window = {
  activeTextEditor: undefined as FakeTextEditor | undefined,
  visibleTextEditors: [] as FakeTextEditor[],
  onDidChangeVisibleTextEditors: visibleEditorsChanged.event,
  createTextEditorDecorationType: vi.fn((options: unknown) => ({ options, dispose: vi.fn() })),
  createOutputChannel: vi.fn((name: string) => ({
    name,
    append: (value: string) => outputLines.push(value),
    appendLine: (value: string) => outputLines.push(value),
    show: vi.fn(),
    dispose: vi.fn(),
  })),
  createStatusBarItem: vi.fn(
    (id: string, alignment: StatusBarAlignment): FakeStatusBarItem => ({
      id,
      alignment,
      text: '',
      command: undefined,
      backgroundColor: undefined,
      show: vi.fn(),
      hide: vi.fn(),
      dispose: vi.fn(),
    }),
  ),
  createWebviewPanel: vi.fn((viewType: string, title: string, column: ViewColumn, options: unknown): FakeWebviewPanel => {
    const disposeListeners: Array<() => void> = [];
    return {
      viewType,
      title,
      column,
      options,
      webview: {
        html: '',
        cspSource: 'vscode-webview://csp',
        asWebviewUri: (uri: Uri) => uri,
        postMessage: vi.fn(),
        messageListeners: [],
        get messageListener() {
          const ls = this.messageListeners;
          return ls.length ? (msg: unknown) => ls.forEach((l) => l(msg)) : undefined;
        },
        onDidReceiveMessage(listener) {
          this.messageListeners.push(listener);
          return { dispose: () => this.messageListeners.splice(this.messageListeners.indexOf(listener), 1) };
        },
      },
      reveal: vi.fn(),
      onDidDispose: (listener) => {
        disposeListeners.push(listener);
        return { dispose: () => undefined };
      },
      dispose: () => {
        for (const l of disposeListeners) l();
      },
    };
  }),
  showInformationMessage: vi.fn(),
  showWarningMessage: vi.fn(),
  showErrorMessage: vi.fn(),
  // Resolves a fake editor whose `revealRange` is a spy.
  showTextDocument: vi.fn((_doc: unknown, _options?: unknown) => Promise.resolve({ revealRange: vi.fn() })),
};

export class RelativePattern {
  constructor(
    readonly base: unknown,
    readonly pattern: string,
  ) {}
}

export interface FakeFileSystemWatcher {
  pattern: RelativePattern;
  created: EventEmitter<Uri>;
  changed: EventEmitter<Uri>;
  deleted: EventEmitter<Uri>;
  onDidCreate: EventEmitter<Uri>['event'];
  onDidChange: EventEmitter<Uri>['event'];
  onDidDelete: EventEmitter<Uri>['event'];
  dispose: ReturnType<typeof vi.fn>;
}

// Every watcher `createFileSystemWatcher` returned, in order; tests fire its emitters and reset it with `length = 0`.
export const watchers: FakeFileSystemWatcher[] = [];

// Tests fire it to stand in for adding or removing a workspace folder.
export const workspaceFoldersChanged = new EventEmitter<unknown>();

// Tests fire it with the changed setting's key to stand in for a settings edit.
export const configurationChanged = new EventEmitter<string>();

export const workspace = {
  onDidChangeConfiguration: (listener: (e: { affectsConfiguration(key: string): boolean }) => void) =>
    configurationChanged.event((key) => listener({ affectsConfiguration: (k) => k === key })),
  workspaceFolders: undefined as Array<{ uri: Uri; name: string; index: number }> | undefined,
  onDidChangeWorkspaceFolders: workspaceFoldersChanged.event,
  // `asRelativePath` strips this prefix plus `/`; tests set it.
  root: '/proj',
  openTextDocument: vi.fn((uri: Uri) => Promise.resolve({ uri })),
  createFileSystemWatcher(pattern: RelativePattern): FakeFileSystemWatcher {
    const [created, changed, deleted] = [new EventEmitter<Uri>(), new EventEmitter<Uri>(), new EventEmitter<Uri>()];
    const watcher = {
      pattern,
      created,
      changed,
      deleted,
      onDidCreate: created.event,
      onDidChange: changed.event,
      onDidDelete: deleted.event,
      dispose: vi.fn(),
    };
    watchers.push(watcher);
    return watcher;
  },
  // `getConfiguration(section).get(key)` reads `settings['section.key']`; tests set it.
  settings: {} as Record<string, unknown>,
  getConfiguration(section: string) {
    return { get: <T>(key: string): T | undefined => this.settings[`${section}.${key}`] as T | undefined };
  },
  asRelativePath(pathOrUri: string | Uri): string {
    const path = typeof pathOrUri === 'string' ? pathOrUri : pathOrUri.fsPath;
    return path.startsWith(`${this.root}/`) ? path.slice(this.root.length + 1) : path;
  },
};

export const commands = {
  registerCommand: vi.fn((_command: string, _callback: (...args: unknown[]) => unknown) => ({ dispose: vi.fn() })),
  executeCommand: vi.fn((_command: string, ..._args: unknown[]) => Promise.resolve(undefined)),
};
