import type { GraphEdge, GraphNodeDetail } from '../src/sidecar/protocol';

const KIND_ORDER = ['contains', 'imports', 'calls', 'references', 'unresolved'] as const;

// `[kind, N]` in KIND_ORDER; an unresolved edge counts as `unresolved`; zeros omitted. Shared with the tree's tooltip.
export function kindCounts(edges: GraphEdge[]): Array<[string, number]> {
  return KIND_ORDER.flatMap((kind) => {
    const n = edges.filter((e) => (e.resolved ? e.kind : 'unresolved') === kind).length;
    return n ? [[kind, n] as [string, number]] : [];
  });
}

// `in · <kind>: N` lines then `out · <kind>: N`.
export function edgeCounts(detail: Pick<GraphNodeDetail, 'inbound' | 'outbound'>): string[] {
  const lines = (dir: 'in' | 'out', list: GraphEdge[]) => kindCounts(list).map(([kind, n]) => `${dir} · ${kind}: ${n}`);
  return [...lines('in', detail.inbound), ...lines('out', detail.outbound)];
}

// Fills `#details-graph`: a file's Expand/Collapse button (the handle's code path), a placeholder's Kind and Name
// (the shell has no record for it), then the edge counts.
export function renderGraphDetails(
  section: HTMLElement,
  detail: GraphNodeDetail,
  isExpanded: boolean,
  onToggle: () => void,
): void {
  section.replaceChildren();
  const { node } = detail;
  if (node.kind === 'file') {
    const button = document.createElement('button');
    button.id = 'btn-toggle';
    button.textContent = isExpanded ? 'Collapse' : 'Expand';
    button.addEventListener('click', onToggle);
    section.append(button);
  }
  if (node.kind === 'unresolved') {
    const dl = document.createElement('dl');
    for (const [term, value] of [
      ['Kind', 'unresolved'],
      ['Name', node.name],
    ]) {
      const dt = document.createElement('dt');
      dt.textContent = term;
      const dd = document.createElement('dd');
      dd.textContent = value;
      dl.append(dt, dd);
    }
    section.append(dl);
  }
  const counts = edgeCounts(detail);
  if (counts.length) {
    const heading = document.createElement('h4');
    heading.textContent = 'Edges';
    const ul = document.createElement('ul');
    for (const line of counts) {
      const li = document.createElement('li');
      li.textContent = line;
      ul.append(li);
    }
    section.append(heading, ul);
  }
}
