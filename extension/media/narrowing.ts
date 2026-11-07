import type { GraphEdgeKind } from '../src/sidecar/protocol';

export type ToggleNodeKind = 'file' | 'class' | 'function';
export type Kind = ToggleNodeKind | GraphEdgeKind;
export type Kinds = Record<Kind, boolean>;

// The Kinds popover's checkboxes, in design/ui.md order. Placeholders (`unresolved`) have no toggle.
export const KINDS: { nodes: ToggleNodeKind[]; edges: GraphEdgeKind[] } = {
  nodes: ['file', 'class', 'function'],
  edges: ['contains', 'imports', 'calls', 'references'],
};

export interface Viewport {
  zoom: number;
  pan: { x: number; y: number };
}

// What leaving focus restores (R8). Search is not part of it.
export interface FocusSnapshot {
  expanded: Set<string>;
  pathGlob: string;
  lastValidGlob: RegExp | null;
  kinds: Kinds;
  viewport: Viewport;
}

// The toolbar's narrowing state, held in the webview only. `pathGlob` is the text in force; `lastValidGlob` its regex.
export interface NarrowingState {
  search: string;
  pathGlob: string;
  lastValidGlob: RegExp | null;
  kinds: Kinds;
  focus: { nodeId: string; hops: number } | null;
  snapshotBeforeFocus: FocusSnapshot | null;
  // Scoped view's depth (code-graph R14, R20): `Hops` drives this instead of focus while scoped.
  scopeHops: number;
}

export function defaultNarrowing(): NarrowingState {
  return {
    search: '',
    pathGlob: '',
    lastValidGlob: null,
    kinds: { file: true, class: true, function: true, contains: true, imports: true, calls: true, references: false },
    focus: null,
    snapshotBeforeFocus: null,
    scopeHops: 1,
  };
}
