// Data-flow's extension ↔ webview postMessage contract (design/api.md § 4). Types only: both bundles import this.

import type { Trace } from '../sidecar/protocol';

// `hop` is 1-based; 0 for a trace with no hops. `path` is the traced file's wire path (its graph file node's `path`).
export type FlowToWebview = { type: 'flow/show'; trace: Trace; path: string; hop: number } | { type: 'flow/clear' };

export type WebviewToFlow = { type: 'flow/hop'; hop: number } | { type: 'flow/clear' };
