import type { FocusSnapshot, NarrowingState } from './narrowing';

// Enters focus on `nodeId` at 1 hop, snapshotting what leaving restores (R8).
export function enterFocus(state: NarrowingState, nodeId: string, parts: Pick<FocusSnapshot, 'expanded' | 'viewport'>): void {
  state.snapshotBeforeFocus = {
    expanded: new Set(parts.expanded),
    pathGlob: state.pathGlob,
    lastValidGlob: state.lastValidGlob,
    kinds: { ...state.kinds },
    viewport: { zoom: parts.viewport.zoom, pan: { ...parts.viewport.pan } },
  };
  state.focus = { nodeId, hops: 1 };
}

// Leaves focus: restores glob and kinds into `state` and returns the snapshot (expansion and viewport are the
// caller's to re-apply).
export function exitFocus(state: NarrowingState): FocusSnapshot | null {
  const snap = state.snapshotBeforeFocus;
  state.focus = null;
  state.snapshotBeforeFocus = null;
  if (snap) {
    state.pathGlob = snap.pathGlob;
    state.lastValidGlob = snap.lastValidGlob;
    state.kinds = { ...snap.kinds };
  }
  return snap;
}
