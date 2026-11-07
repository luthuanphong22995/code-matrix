import { describe, expect, it } from 'vitest';
import { enterFocus, exitFocus } from '../../../media/focus';
import { globToRegExp } from '../../../media/glob';
import { defaultNarrowing } from '../../../media/narrowing';

describe('enterFocus / exitFocus', () => {
  it('exit returns a snapshot deep-equal to the pre-focus state and restores glob and kinds', () => {
    const state = defaultNarrowing();
    state.pathGlob = 'src/**';
    state.lastValidGlob = globToRegExp('src/**');
    const expanded = new Set(['a.go']);
    const viewport = { zoom: 1.5, pan: { x: 10, y: -4 } };
    const before = { expanded: new Set(expanded), pathGlob: 'src/**', lastValidGlob: state.lastValidGlob, kinds: { ...state.kinds }, viewport: structuredClone(viewport) };

    enterFocus(state, 'main', { expanded, viewport });
    expect(state.focus).toEqual({ nodeId: 'main', hops: 1 });
    // Change everything while focused.
    expanded.add('b.go');
    viewport.zoom = 3;
    viewport.pan.x = 99;
    state.pathGlob = 'docs/**';
    state.lastValidGlob = globToRegExp('docs/**');
    state.kinds.function = false;
    state.kinds.references = true;
    state.focus!.hops = 3;

    const snap = exitFocus(state);
    expect(snap).toEqual(before);
    expect(state.focus).toBeNull();
    expect(state.pathGlob).toBe('src/**');
    expect(state.kinds).toEqual(before.kinds);
  });

  it('exit without focus returns null', () => {
    expect(exitFocus(defaultNarrowing())).toBeNull();
  });
});
