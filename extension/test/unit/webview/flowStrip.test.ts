import { describe, expect, it } from 'vitest';
import { flowStripView } from '../../../media/flowStrip';
import { noReachingDef, noUses, parseConfig } from '../fakes/trace';

const text = (hop: number, trace = parseConfig) => flowStripView(trace, hop).status.map((p) => p.text).join('');

describe('flowStripView', () => {
  it('hops: Hop N of M with the def and use lines; identifiers are code parts', () => {
    expect(flowStripView(parseConfig, 1)).toEqual({
      status: [{ text: 'Hop 1 of 4: ' }, { text: 'total', code: true }, { text: ' defined at line 12 → used at line 14' }],
      prev: false,
      next: true,
    });
    expect(text(2)).toBe('Hop 2 of 4: total defined at line 14 → used at line 14');
    expect(text(3)).toBe('Hop 3 of 4: total defined at line 12 → used at line 18');
  });

  it('never wraps: Prev only after hop 1, Next only before the last', () => {
    expect([1, 2, 3, 4].map((hop) => [flowStripView(parseConfig, hop).prev, flowStripView(parseConfig, hop).next])).toEqual([
      [false, true],
      [true, true],
      [true, true],
      [true, false],
    ]);
  });

  it('noUses and noReachingDef have their texts and both buttons disabled', () => {
    expect(flowStripView(noUses, 0)).toEqual({
      status: [{ text: 'No uses of ' }, { text: 'unused', code: true }, { text: ' in ' }, { text: 'parseConfig', code: true }],
      prev: false,
      next: false,
    });
    expect(flowStripView(noReachingDef, 0)).toEqual({
      status: [{ text: 'No definition of ' }, { text: 'n', code: true }, { text: ' reaches this read' }],
      prev: false,
      next: false,
    });
  });
});
