import type { FlowDebugState } from '../src/graph/messages';
import type { WebviewToFlow } from '../src/flow/messages';
import type { Trace, TraceBlock } from '../src/sidecar/protocol';
import { type FlowMarks, type FlowOverlay, type GraphView, HOP_EDGE } from './graph';

const LABEL_MAX = 32;
const blockId = (id: string) => `flow:${id}`;
const unprefixed = (id: string) => id.slice('flow:'.length);

// `entry` / `exit`, else `line A` or `lines A–B`, then the block's first source line trimmed and cut at 32.
export function blockLabel(block: TraceBlock): string {
  if (block.kind !== 'basic') return block.kind;
  const head = block.startLine === block.endLine ? `line ${block.startLine}` : `lines ${block.startLine}–${block.endLine}`;
  const first = block.firstLine.trim();
  if (first === '') return head;
  return `${head}\n${first.length > LABEL_MAX ? `${first.slice(0, LABEL_MAX)}…` : first}`;
}

// The CFG drawn inside the traced function node: one node per block, one edge per branch.
export function flowElements(trace: Trace): FlowOverlay {
  return {
    functionId: trace.functionId,
    blocks: trace.blocks.map((b) => ({ group: 'nodes', data: { id: blockId(b.id), label: blockLabel(b) }, classes: 'block' })),
    branches: trace.branches.map((b, i) => ({
      group: 'edges',
      data: { id: `flow-branch:${i}`, source: blockId(b.from), target: blockId(b.to) },
      classes: 'branch',
    })),
  };
}

// Highlighted = every occurrence's block; hop N (1-based) marks its use block current and draws def → use.
export function flowMarks(trace: Trace, hop: number): FlowMarks {
  const blockOf = (ordinal: number) => blockId(trace.occurrences.find((o) => o.ordinal === ordinal)!.block);
  const h = trace.hops[hop - 1];
  return {
    trace: [...new Set(trace.occurrences.map((o) => blockId(o.block)))],
    current: h ? blockOf(h.useOrdinal) : null,
    hop: h ? { from: blockOf(h.defOrdinal), to: blockOf(h.useOrdinal), label: trace.variable } : null,
  };
}

export interface FlowView {
  // Replaces any shown trace; expands its file (by wire path) if the canvas holds it collapsed.
  show(trace: Trace, path: string, hop: number): void;
  // After graph/refresh / graph/expanded: a trace still waiting for its file retries the expansion.
  retry(): void;
  // ±1: posts flow/hop and re-marks; a step past either end does nothing. Returns whether it stepped.
  step(delta: 1 | -1): boolean;
  // Folds the trace back; `post` tells the extension (a webview-side clear). Nothing shown → nothing happens.
  clear(post: boolean): void;
  active(): { trace: Trace; hop: number } | undefined;
  debug(): Omit<FlowDebugState, 'status' | 'prev' | 'next'>;
}

// The trace on the canvas. `onChange` runs after every show / step / clear (the strip re-renders).
export function mountFlow(graph: GraphView, post: (message: WebviewToFlow) => void, onChange: () => void = () => undefined): FlowView {
  let shown: { trace: Trace; path: string; hop: number } | undefined;
  // The file is expanded once; after that a user collapse keeps the strip and draws nothing.
  let waiting = false;

  const retry = () => {
    if (!shown || !waiting) return;
    const fileId = graph.fileByPath(shown.path);
    if (fileId === undefined) return;
    waiting = false;
    if (!graph.isExpanded(fileId)) graph.toggle(fileId);
  };

  const view: FlowView = {
    show(trace, path, hop) {
      shown = { trace, path, hop };
      waiting = true;
      graph.setFlow(flowElements(trace));
      graph.markFlow(flowMarks(trace, hop));
      retry();
      onChange();
    },
    retry,
    step(delta) {
      if (!shown) return false;
      const hop = shown.hop + delta;
      if (shown.hop === 0 || hop < 1 || hop > shown.trace.hops.length) return false;
      shown.hop = hop;
      graph.markFlow(flowMarks(shown.trace, hop));
      post({ type: 'flow/hop', hop });
      onChange();
      return true;
    },
    clear(postClear) {
      if (!shown) return;
      shown = undefined;
      waiting = false;
      graph.setFlow(undefined);
      if (postClear) post({ type: 'flow/clear' });
      onChange();
    },
    active: () => shown && { trace: shown.trace, hop: shown.hop },
    debug() {
      const cy = graph.cy;
      const fn = shown ? cy.getElementById(shown.trace.functionId) : cy.collection();
      const blocks = cy.nodes('.block').not('.hidden');
      const hop = cy.getElementById(HOP_EDGE);
      return {
        hop: shown?.hop ?? 0,
        container: fn.nonempty() && !fn.hasClass('hidden') && fn.children().nonempty() ? String(fn.data('label')) : null,
        blocks: blocks.map((b) => ({ id: unprefixed(b.id()), label: String(b.data('label')) })),
        highlighted: blocks.filter('.trace').map((b) => unprefixed(b.id())),
        current: blocks.filter('.current').map((b) => unprefixed(b.id()))[0] ?? null,
        hopEdge: hop.nonempty()
          ? { from: unprefixed(hop.data('source')), to: unprefixed(hop.data('target')), label: String(hop.data('label')) }
          : null,
      };
    },
  };
  return view;
}
