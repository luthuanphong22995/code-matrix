import { describe, expect, it } from 'vitest';
import { type NodeRecord, NodeRegistry } from '../../../src/nodes/registry';

const record = (id: string, name = id): NodeRecord => ({
  id,
  kind: 'function',
  name,
  path: '/proj/src/config.go',
  range: { startLine: 11, startCol: 0, endLine: 39, endCol: 1 },
});

describe('NodeRegistry', () => {
  it('register then get returns the record; delete drops it', () => {
    const nodes = new NodeRegistry();
    nodes.register([record('a'), record('b')]);
    expect(nodes.get('a')).toEqual(record('a'));
    expect(nodes.delete('a')).toBe(true);
    expect(nodes.get('a')).toBeUndefined();
    expect(nodes.get('b')).toEqual(record('b'));
  });

  it('register with an existing id overwrites it', () => {
    const nodes = new NodeRegistry();
    nodes.register([record('a', 'old')]);
    nodes.register([record('a', 'new')]);
    expect(nodes.size).toBe(1);
    expect(nodes.get('a')?.name).toBe('new');
  });
});
