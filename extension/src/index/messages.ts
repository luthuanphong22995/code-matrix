// Workspace-index's extension ↔ webview postMessage contract. Types only: both bundles import this.

export type IndexToWebview =
  | { type: 'index/progress'; phase: 'scanning' | 'indexing'; done: number; total: number }
  | {
      type: 'index/done';
      outcome: 'complete' | 'cancelled';
      indexed: number;
      failed: number;
      skipped: number;
      // Whether the sidecar had a completed graph before this run finished.
      hadGraph: boolean;
    };

export type WebviewToIndex = { type: 'index/run' } | { type: 'index/cancel' };
