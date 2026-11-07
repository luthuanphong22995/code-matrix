import { describe, expect, it } from 'vitest';
import { computeVisible, VISIBLE_CAP } from '../../../media/filters';
import { globToRegExp } from '../../../media/glob';
import { defaultNarrowing, type NarrowingState } from '../../../media/narrowing';
import type { GraphEdge, GraphNode } from '../../../src/sidecar/protocol';

const file = (id: string): GraphNode => ({ id, kind: 'file', name: id, path: id });
const fn = (id: string, parentId: string): GraphNode => ({ id, kind: 'function', name: id, parentId });
const ph = (id: string): GraphNode => ({ id, kind: 'unresolved', name: id });
const e = (id: string, kind: GraphEdge['kind'], fromId: string, toId: string, resolved = true): GraphEdge => ({ id, kind, fromId, toId, resolved });
const sorted = (s: Set<string>) => [...s].sort();
const with_ = (patch: Partial<NarrowingState>) => ({ ...defaultNarrowing(), ...patch });

// Three files: two under src/api, one under src/db, each with a function; calls across, a references edge, a placeholder.
const nodes = [
  file('src/api/handler.go'),
  file('src/api/router.go'),
  file('src/db/conn.go'),
  fn('handle', 'src/api/handler.go'),
  fn('route', 'src/api/router.go'),
  fn('open', 'src/db/conn.go'),
  ph('fmt'),
  ph('missing'),
];
const edges = [
  e('c1', 'contains', 'src/api/handler.go', 'handle'),
  e('c2', 'contains', 'src/api/router.go', 'route'),
  e('c3', 'contains', 'src/db/conn.go', 'open'),
  e('i1', 'imports', 'src/api/handler.go', 'src/db/conn.go'),
  e('i2', 'imports', 'src/api/router.go', 'fmt', false),
  e('k1', 'calls', 'route', 'handle'),
  e('k2', 'calls', 'handle', 'open'),
  e('k3', 'calls', 'handle', 'missing', false),
  e('r1', 'references', 'route', 'open'),
];
const held = { nodes, edges };

describe('computeVisible', () => {
  it('defaults show everything but references edges', () => {
    const v = computeVisible(held, defaultNarrowing());
    expect(v.nodes.size).toBe(nodes.length);
    expect(sorted(v.edges)).toEqual(['c1', 'c2', 'c3', 'i1', 'i2', 'k1', 'k2', 'k3']);
    expect(v.tooLarge).toBeUndefined();
    expect(computeVisible(held, with_({ kinds: { ...defaultNarrowing().kinds, references: true } })).edges.has('r1')).toBe(true);
  });

  it('glob src/api/** keeps the two api files and their symbols only', () => {
    const v = computeVisible(held, with_({ lastValidGlob: globToRegExp('src/api/**') }));
    expect(sorted(v.nodes)).toEqual(['fmt', 'handle', 'missing', 'route', 'src/api/handler.go', 'src/api/router.go']);
    expect(sorted(v.edges)).toEqual(['c1', 'c2', 'i2', 'k1', 'k3']);
  });

  it('a glob matching nothing leaves nothing (placeholders included)', () => {
    const v = computeVisible(held, with_({ lastValidGlob: globToRegExp('docs/**') }));
    expect(v.nodes.size).toBe(0);
    expect(v.edges.size).toBe(0);
  });

  it('hiding function drops every function, every edge touching one and orphaned placeholders', () => {
    const v = computeVisible(held, with_({ kinds: { ...defaultNarrowing().kinds, function: false } }));
    expect(sorted(v.nodes)).toEqual(['fmt', 'src/api/handler.go', 'src/api/router.go', 'src/db/conn.go']);
    expect(sorted(v.edges)).toEqual(['i1', 'i2']);
  });

  it('hiding an edge kind hides those edges only (and placeholders left without one)', () => {
    const v = computeVisible(held, with_({ kinds: { ...defaultNarrowing().kinds, imports: false } }));
    expect(v.nodes.has('fmt')).toBe(false);
    expect(v.nodes.has('src/db/conn.go')).toBe(true);
    expect(v.edges.has('i1')).toBe(false);
  });

  it('an edge is in only while both ends are held', () => {
    const v = computeVisible({ nodes: nodes.filter((n) => n.id !== 'open'), edges }, defaultNarrowing());
    expect(v.edges.has('k2')).toBe(false);
    expect(v.edges.has('c3')).toBe(false);
  });

  it('focus keeps the nodes within hops undirected steps over surviving edges', () => {
    // A chain a - b - c - d - e (calls, mixed directions).
    const chain = {
      nodes: ['a', 'b', 'c', 'd', 'e'].map((id) => file(id)),
      edges: [e('ab', 'imports', 'a', 'b'), e('cb', 'imports', 'c', 'b'), e('cd', 'imports', 'c', 'd'), e('de', 'imports', 'd', 'e')],
    };
    const at = (hops: number) => sorted(computeVisible(chain, with_({ focus: { nodeId: 'b', hops } })).nodes);
    expect(at(1)).toEqual(['a', 'b', 'c']);
    expect(at(2)).toEqual(['a', 'b', 'c', 'd']);
    expect(at(3)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(sorted(computeVisible(chain, with_({ focus: { nodeId: 'b', hops: 1 } })).edges)).toEqual(['ab', 'cb']);
    // A focus node no longer visible yields the pre-focus set.
    expect(computeVisible(chain, with_({ focus: { nodeId: 'gone', hops: 1 } })).nodes.size).toBe(5);
  });

  it(`renders exactly ${VISIBLE_CAP} nodes; one more is too large and draws nothing`, () => {
    const many = (n: number) => ({ nodes: Array.from({ length: n }, (_, i) => file(`f${i}.go`)), edges: [] });
    expect(computeVisible(many(VISIBLE_CAP), defaultNarrowing()).nodes.size).toBe(2000);
    expect(computeVisible(many(VISIBLE_CAP + 1), defaultNarrowing())).toEqual({ nodes: new Set(), edges: new Set(), tooLarge: 2001 });
  });

  describe('pinned (data-flow R19)', () => {
    // The traced function `open` (under src/db) and two of its blocks, which the canvas does not hold.
    const pinned = new Set(['open', 'flow:b0', 'flow:b1']);

    it('a pinned function under a non-matching glob and with function toggled off stays in, with its blocks', () => {
      const v = computeVisible(
        held,
        with_({ lastValidGlob: globToRegExp('src/api/**'), kinds: { ...defaultNarrowing().kinds, function: false } }),
        pinned,
      );
      expect(sorted(v.nodes)).toEqual(['flow:b0', 'flow:b1', 'fmt', 'open', 'src/api/handler.go', 'src/api/router.go']);
      expect(v.nodes.has('src/db/conn.go')).toBe(false);
    });

    it('focus elsewhere keeps every pinned id', () => {
      const v = computeVisible(held, with_({ focus: { nodeId: 'route', hops: 1 } }), pinned);
      expect(sorted(v.nodes)).toEqual(['flow:b0', 'flow:b1', 'handle', 'open', 'route', 'src/api/router.go']);
    });

    it('pinned ids count toward the cap', () => {
      const many = { nodes: Array.from({ length: 1995 }, (_, i) => file(`f${i}.go`)), edges: [] };
      const six = new Set(Array.from({ length: 6 }, (_, i) => `flow:b${i}`));
      expect(computeVisible(many, defaultNarrowing(), six)).toEqual({ nodes: new Set(), edges: new Set(), tooLarge: 2001 });
    });

    it('an empty pinned set changes nothing', () => {
      for (const state of [defaultNarrowing(), with_({ lastValidGlob: globToRegExp('src/api/**') }), with_({ focus: { nodeId: 'route', hops: 2 } })]) {
        expect(computeVisible(held, state, new Set())).toEqual(computeVisible(held, state));
      }
    });
  });
});

describe('computeVisible scope (code-graph R14, R16, R17)', () => {
  const scope = (nodeId: string | null, hops = 1) => ({ nodeId, hops });

  it('without a scope the result is unchanged', () => {
    expect(computeVisible(held, defaultNarrowing(), new Set(), undefined)).toEqual(computeVisible(held, defaultNarrowing()));
  });

  it('a null scope node keeps nothing', () => {
    const v = computeVisible(held, defaultNarrowing(), new Set(), scope(null));
    expect(v.nodes.size).toBe(0);
    expect(v.edges.size).toBe(0);
  });

  it('a file keeps its subtree and its one-hop neighbours', () => {
    const v = computeVisible(held, defaultNarrowing(), new Set(), scope('src/api/handler.go'));
    expect(sorted(v.nodes)).toEqual(['handle', 'src/api/handler.go', 'src/db/conn.go']);
    expect(sorted(v.edges)).toEqual(['c1', 'i1']);
  });

  it('a function keeps its container, callers and callees; Hops widens it', () => {
    expect(sorted(computeVisible(held, defaultNarrowing(), new Set(), scope('handle')).nodes)).toEqual([
      'handle',
      'missing',
      'open',
      'route',
      'src/api/handler.go',
    ]);
    expect(sorted(computeVisible(held, defaultNarrowing(), new Set(), scope('handle', 2)).nodes)).toEqual([
      'handle',
      'missing',
      'open',
      'route',
      'src/api/handler.go',
      'src/api/router.go',
      'src/db/conn.go',
    ]);
  });

  it('the scope node is kept when its kind is off; its hidden neighbours are not', () => {
    const kinds = { ...defaultNarrowing().kinds, function: false };
    expect(sorted(computeVisible(held, with_({ kinds }), new Set(), scope('handle')).nodes)).toEqual(['handle', 'missing', 'src/api/handler.go']);
  });

  it('the path glob still applies to the neighbours', () => {
    const v = computeVisible(held, with_({ lastValidGlob: globToRegExp('src/api/**') }), new Set(), scope('handle'));
    expect(sorted(v.nodes)).toEqual(['handle', 'missing', 'route', 'src/api/handler.go']);
  });

  it('a hub neighbourhood over the cap is too large', () => {
    const hub = file('util.go');
    const importers = Array.from({ length: VISIBLE_CAP + 1 }, (_, i) => file(`f${i}.go`));
    const v = computeVisible(
      { nodes: [hub, ...importers], edges: importers.map((f) => e(`i-${f.id}`, 'imports', f.id, hub.id)) },
      defaultNarrowing(),
      new Set(),
      scope('util.go'),
    );
    expect(v.tooLarge).toBe(VISIBLE_CAP + 2);
    expect(v.nodes.size).toBe(0);
  });
});
