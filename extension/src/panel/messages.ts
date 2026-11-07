// Extension ↔ webview postMessage contract (design/api.md § 2). Types only: both bundles import this.

export type PanelState = 'starting' | 'indexing' | 'ready' | 'failed';

// What the Details region shows for the selected node; `location` is workspace-relative `path:line` (1-based).
export type SelectionView = { kind: string; name: string; location: string };

export type ShellToWebview =
  | { type: 'shell/state'; state: PanelState; cause?: string }
  | { type: 'shell/selection'; node: SelectionView | null };

export type WebviewToShell =
  | { type: 'shell/selectNode'; nodeId: string | null }
  | { type: 'shell/openNode'; nodeId: string }
  | { type: 'shell/retry' }
  | { type: 'shell/restart' }
  | { type: 'shell/showLog' };
