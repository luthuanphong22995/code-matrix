import type { GraphNode } from '../src/sidecar/protocol';

// Visible nodes whose name contains `query`, case-insensitively, lowest `(name, id)` first (R6).
export function findMatches(visibleNodes: Iterable<GraphNode>, query: string): string[] {
  const q = query.toLowerCase();
  if (q === '') return [];
  return [...visibleNodes]
    .filter((n) => n.name.toLowerCase().includes(q))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((n) => n.id);
}
