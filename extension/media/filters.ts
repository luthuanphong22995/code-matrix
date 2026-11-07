import type { GraphEdge, GraphNode } from '../src/sidecar/protocol';
import type { NarrowingState } from './narrowing';

// Above this many visible nodes nothing is drawn (R9).
export const VISIBLE_CAP = 2000;

export interface Visible {
  nodes: Set<string>;
  edges: Set<string>;
  tooLarge?: number;
}

// The visible set: path glob → kind toggles → expansion → placeholder rule → focus → scope → pinned → cap. `held` is what
// the canvas holds (the file layer plus expanded subtrees), so the expansion stage is "held nodes only".
// An edge is in only while both of its ends are. `pinned` (an active trace's container and blocks) skips the glob
// and kind stages, is added back after focus whether held or not, and counts toward the cap (data-flow R19).
// `scope` (scoped view only, code-graph R14) keeps its node — past the glob and kind stages — its contains subtree
// and what lies within `hops` steps of it; a null node keeps nothing (R16).
export function computeVisible(
  held: { nodes: Iterable<GraphNode>; edges: Iterable<GraphEdge> },
  state: Pick<NarrowingState, 'lastValidGlob' | 'kinds' | 'focus'>,
  pinned: ReadonlySet<string> = new Set(),
  scope?: { nodeId: string | null; hops: number },
): Visible {
  const byId = new Map<string, GraphNode>();
  for (const n of held.nodes) byId.set(n.id, n);
  const fileOf = (n: GraphNode) => {
    let top = n;
    for (let p = n.parentId; p !== undefined; p = byId.get(p)?.parentId) {
      const parent = byId.get(p);
      if (!parent) break;
      top = parent;
    }
    return top;
  };
  const glob = state.lastValidGlob;
  const kinds = state.kinds as Record<string, boolean>;
  const nodes = new Set<string>();
  for (const n of byId.values()) {
    if (n.kind === 'unresolved' || pinned.has(n.id) || n.id === scope?.nodeId) {
      nodes.add(n.id);
      continue;
    }
    if (!kinds[n.kind]) continue;
    const file = fileOf(n);
    if (glob && !(file.kind === 'file' && glob.test(file.path ?? ''))) continue;
    nodes.add(n.id);
  }
  let edges = [...held.edges].filter((e) => kinds[e.kind] && nodes.has(e.fromId) && nodes.has(e.toId));
  // Placeholder rule: a placeholder stays only while a surviving edge touches it.
  const touched = new Set(edges.flatMap((e) => [e.fromId, e.toId]));
  for (const id of nodes) if (byId.get(id)!.kind === 'unresolved' && !touched.has(id)) nodes.delete(id);

  // Focus: undirected BFS up to `hops` steps; a focus node no longer visible leaves the set as it was.
  if (state.focus && nodes.has(state.focus.nodeId)) {
    const near = within(edges, state.focus.nodeId, state.focus.hops);
    for (const id of nodes) if (!near.has(id)) nodes.delete(id);
    edges = edges.filter((e) => nodes.has(e.fromId) && nodes.has(e.toId));
  }
  if (scope) {
    const near = scope.nodeId !== null && nodes.has(scope.nodeId) ? within(edges, scope.nodeId, scope.hops) : new Set<string>();
    const inScope = (n: GraphNode) => {
      for (let p: string | undefined = n.id; p !== undefined; p = byId.get(p)?.parentId) if (p === scope.nodeId) return true;
      return false;
    };
    for (const id of nodes) if (!near.has(id) && !inScope(byId.get(id)!)) nodes.delete(id);
    edges = edges.filter((e) => nodes.has(e.fromId) && nodes.has(e.toId));
  }
  for (const id of pinned) nodes.add(id);

  if (nodes.size > VISIBLE_CAP) return { nodes: new Set(), edges: new Set(), tooLarge: nodes.size };
  return { nodes, edges: new Set(edges.map((e) => e.id)) };
}

// Every node within `hops` undirected steps of `start` over `edges`, `start` included.
function within(edges: GraphEdge[], start: string, hops: number): Set<string> {
  const near = new Set([start]);
  let frontier = new Set(near);
  for (let hop = 0; hop < hops && frontier.size; hop++) {
    const next = new Set<string>();
    for (const e of edges) {
      for (const [a, b] of [[e.fromId, e.toId], [e.toId, e.fromId]]) {
        if (frontier.has(a) && !near.has(b)) {
          near.add(b);
          next.add(b);
        }
      }
    }
    frontier = next;
  }
  return near;
}
