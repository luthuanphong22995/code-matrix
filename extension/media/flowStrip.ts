import type { Trace } from '../src/sidecar/protocol';
import type { FlowView } from './flow';

// Status parts in order; `code` parts are identifiers, rendered monospace.
export interface FlowStripView {
  status: Array<{ text: string; code?: boolean }>;
  prev: boolean;
  next: boolean;
}

// Pure mapping from a shown trace and its current hop to the strip (data-flow ui.md § trace strip). Never wraps.
export function flowStripView(trace: Trace, hop: number): FlowStripView {
  const x = { text: trace.variable, code: true };
  const line = (ordinal: number) => trace.occurrences.find((o) => o.ordinal === ordinal)!.line;
  const h = trace.hops[hop - 1];
  if (trace.status === 'hops' && h) {
    return {
      status: [{ text: `Hop ${hop} of ${trace.hops.length}: ` }, x, { text: ` defined at line ${line(h.defOrdinal)} → used at line ${line(h.useOrdinal)}` }],
      prev: hop > 1,
      next: hop < trace.hops.length,
    };
  }
  const status =
    trace.status === 'noReachingDef'
      ? [{ text: 'No definition of ' }, x, { text: ' reaches this read' }]
      : [{ text: 'No uses of ' }, x, { text: ' in ' }, { text: trace.functionName, code: true }];
  return { status, prev: false, next: false };
}

export interface FlowStrip {
  // Shows the strip for the trace the canvas holds, or hides it.
  render(): void;
  state(): { status: string; prev: boolean; next: boolean };
}

// Wires the static #flow-strip markup (getHtml): Prev / Next step the trace, `Clear trace` ends it.
export function mountFlowStrip(flow: FlowView): FlowStrip {
  const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const strip = byId('flow-strip');
  const status = byId('text-trace-status');
  const prev = byId<HTMLButtonElement>('btn-trace-prev');
  const next = byId<HTMLButtonElement>('btn-trace-next');
  prev.addEventListener('click', () => flow.step(-1));
  next.addEventListener('click', () => flow.step(1));
  byId('btn-trace-clear').addEventListener('click', () => flow.clear(true));
  return {
    render() {
      const active = flow.active();
      strip.hidden = active === undefined;
      if (!active) return;
      const view = flowStripView(active.trace, active.hop);
      status.replaceChildren(
        ...view.status.map(({ text, code }) => {
          if (!code) return document.createTextNode(text);
          const el = document.createElement('code');
          el.textContent = text;
          return el;
        }),
      );
      prev.disabled = !view.prev;
      next.disabled = !view.next;
    },
    state: () => ({ status: status.textContent ?? '', prev: !prev.disabled, next: !next.disabled }),
  };
}
