import { describe, expect, it } from 'vitest';
import { findMatches } from '../../../media/search';
import type { GraphNode } from '../../../src/sidecar/protocol';

const n = (id: string, name: string): GraphNode => ({ id, kind: 'function', name });
const visible = [n('3', 'parseEnv'), n('2', 'parseConfig'), n('1', 'main'), n('0', 'parseConfig')];

describe('findMatches', () => {
  it('matches a substring case-insensitively, ordered by (name, id)', () => {
    expect(findMatches(visible, 'parse')).toEqual(['0', '2', '3']);
    expect(findMatches(visible, 'PARSECONFIG')).toEqual(['0', '2']);
  });

  it('only sees the nodes it is given (hidden nodes never match)', () => {
    expect(findMatches([n('1', 'main')], 'parse')).toEqual([]);
  });

  it('no hit and an empty query give nothing', () => {
    expect(findMatches(visible, 'nope')).toEqual([]);
    expect(findMatches(visible, '')).toEqual([]);
  });
});
