import './main.css';
import type { FlowToWebview, WebviewToFlow } from '../src/flow/messages';
import type { GraphToWebview, WebviewToGraph } from '../src/graph/messages';
import type { IndexToWebview, WebviewToIndex } from '../src/index/messages';
import type { PanelState, SelectionView, ShellToWebview, WebviewToShell } from '../src/panel/messages';
import type { GraphNodeDetail } from '../src/sidecar/protocol';
import { mountFlow } from './flow';
import { mountFlowStrip } from './flowStrip';
import { mountGraph } from './graph';
import { renderGraphDetails } from './graphDetails';
import { mountStrip } from './indexStrip';
import { mountToolbar, type Toolbar } from './toolbar';
import { mountTree } from './tree';

export interface View {
  overlay: string | undefined;
  heading?: string;
  buttonsEnabled: boolean;
  stateText: string;
  // The failed overlay's `Retry` / `Show Log` buttons (and the emptied Details region).
  actions: boolean;
  // The toolbar's `Re-index` (only ready / indexing; buttonsEnabled is also true in failed).
  reindex: boolean;
  // The cancelled overlay's own `Re-index`.
  cancelled?: boolean;
}

// What this webview has seen: a drawn graph (any graph/refresh), a cancelled first run.
export interface ViewFlags {
  drawn: boolean;
  cancelled: boolean;
}

// Pure mapping from sidecar state to what the shell draws (design/ui.md § States).
export function viewFor(state: PanelState, cause?: string, { drawn, cancelled }: ViewFlags = { drawn: false, cancelled: false }): View {
  switch (state) {
    case 'starting':
      return { overlay: 'Starting Code Matrix server…', buttonsEnabled: false, stateText: state, actions: false, reindex: false };
    case 'indexing':
      // A re-run keeps the previous graph drawn and interactive under the strip (R5).
      return { overlay: drawn ? undefined : 'Indexing workspace…', buttonsEnabled: true, stateText: state, actions: false, reindex: true };
    case 'ready':
      return cancelled
        ? { overlay: 'Indexing cancelled', buttonsEnabled: true, stateText: state, actions: false, reindex: true, cancelled: true }
        : { overlay: undefined, buttonsEnabled: true, stateText: state, actions: false, reindex: true };
    case 'failed':
      return {
        overlay: cause ?? '',
        heading: 'Code Matrix server failed',
        buttonsEnabled: true,
        stateText: state,
        actions: true,
        reindex: false,
      };
  }
}

// Button id → the message its click posts (shell/* to GraphPanel.handleMessage, index/* to IndexController).
export const CLICKS: Record<string, WebviewToShell | WebviewToIndex> = {
  'btn-retry': { type: 'shell/retry' },
  'btn-failed-showlog': { type: 'shell/showLog' },
  'btn-showlog': { type: 'shell/showLog' },
  'btn-restart': { type: 'shell/restart' },
  'btn-reindex': { type: 'index/run' },
  'btn-cancelled-reindex': { type: 'index/run' },
};

declare function acquireVsCodeApi(): { postMessage(message: WebviewToShell | WebviewToGraph | WebviewToIndex | WebviewToFlow): void };

// DOM wiring; skipped where there is no document (node-environment unit tests). Clicks post the CLICKS message; `Details` toggles locally.
if (typeof document !== 'undefined') {
  const vscode = acquireVsCodeApi();
  const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const overlay = byId('overlay');
  const heading = byId('overlay-heading');
  const text = byId('overlay-text');
  const actions = byId('overlay-actions');
  const content = byId('content');
  const stateText = byId('state-text');
  const details = byId('details');
  const buttons = ['btn-restart', 'btn-showlog', 'btn-details'].map((id) => byId<HTMLButtonElement>(id));
  const btnReindex = byId<HTMLButtonElement>('btn-reindex');
  const btnCancelledReindex = byId('btn-cancelled-reindex');

  const apply = (view: View) => {
    overlay.hidden = view.overlay === undefined;
    heading.hidden = view.heading === undefined;
    heading.textContent = view.heading ?? '';
    text.textContent = view.overlay ?? '';
    actions.hidden = !view.actions;
    btnCancelledReindex.hidden = !view.cancelled;
    // CSS hides #details' children under .failed, so their own state survives the failure.
    content.classList.toggle('failed', view.actions);
    stateText.textContent = view.stateText;
    for (const b of buttons) b.disabled = !view.buttonsEnabled;
    btnReindex.disabled = !view.reindex;
  };
  // The last shell/state, and the flags that change its overlay; render() re-applies on each.
  let shellState: { state: PanelState; cause?: string } = { state: 'starting' };
  let drawn = false;
  let cancelled = false;
  const render = () => apply(viewFor(shellState.state, shellState.cause, { drawn, cancelled }));
  const strip = mountStrip((m) => vscode.postMessage(m));

  // Details fields render what the extension sends (shell/selection); own `hidden` flags, so 06's failed CSS still wins.
  const detailsEmpty = byId('details-empty');
  const detailsFields = byId('details-fields');
  const btnOpen = byId('btn-open');
  // Selection model (R8). Escape clears locally at once; the extension's `null` reply is idempotent.
  let selectedId: string | null = null;
  // The empty text keys off the webview's selection: a selected node the shell has no record for shows neither.
  const showSelection = (node: SelectionView | null) => {
    byId('details-kind').textContent = node?.kind ?? '';
    byId('details-name').textContent = node?.name ?? '';
    byId('details-location').textContent = node?.location ?? '';
    detailsEmpty.hidden = selectedId !== null;
    detailsFields.hidden = btnOpen.hidden = node === null;
  };

  // Code-graph: the canvas in #main and its Details section after the shell's fields.
  const detailsGraph = document.createElement('div');
  detailsGraph.id = 'details-graph';
  details.append(detailsGraph);
  let lastDetail: GraphNodeDetail | undefined;
  // A tree selection waiting for its file's expansion to be drawn before centring; any other selection drops it.
  let pending: { id: string; fileId: string } | undefined;
  // `Hidden by current filters`, under Location and above `Open in editor` (R9).
  const detailsHidden = document.createElement('p');
  detailsHidden.id = 'details-hidden';
  detailsHidden.hidden = true;
  detailsHidden.textContent = 'Hidden by current filters';
  btnOpen.before(detailsHidden);
  const isVisible = (id: string) => graph.visibleNodes().some((n) => n.id === id);
  const renderDetails = () => {
    // Scoped view draws the selection by definition: never "hidden" (node-tree R16).
    detailsHidden.hidden = !(selectedId !== null && selectedId !== pending?.id && !graph.isScoped() && !isVisible(selectedId));
    if (lastDetail === undefined || lastDetail.node.id !== selectedId) detailsGraph.replaceChildren();
    else {
      const id = lastDetail.node.id;
      renderGraphDetails(detailsGraph, lastDetail, graph.isExpanded(id), () => graph.toggle(id));
    }
  };
  let toolbar: Toolbar | undefined;
  const graph = mountGraph(
    byId('main'),
    (m) => vscode.postMessage(m),
    () => {
      renderDetails();
      toolbar?.refresh();
    },
  );

  // Data-flow: the trace on the canvas and its strip under the index strip.
  const flow = mountFlow(
    graph,
    (m) => vscode.postMessage(m),
    () => flowStrip.render(),
  );
  const flowStrip = mountFlowStrip(flow);

  // Node tree: shown on every panel open (R1); `Tree` is pressed but disabled until the first graph/refresh (R13).
  // A tree click selects through the canvas's own paths (R9): a symbol of a drawn, collapsed file whose kind is shown
  // expands that file first and is centred once drawn; a node hidden by narrowing leaves the canvas unchanged.
  const tree = mountTree(byId('tree'), {
    post: (m) => vscode.postMessage(m),
    select(node, fileId) {
      // Scoped view: the click makes the node the scope; no file expansion, no centring (node-tree R16).
      if (graph.isScoped()) {
        pending = undefined;
        return graph.tap(node.id);
      }
      if (fileId !== undefined && fileId !== node.id && isVisible(fileId) && !graph.isExpanded(fileId) && toolbar?.state().kinds[node.kind]) {
        graph.toggle(fileId);
        pending = { id: node.id, fileId };
      }
      graph.tap(node.id);
      if (isVisible(node.id)) {
        toolbar?.centre(node.id);
        pending = undefined;
      }
    },
  });
  const btnTree = byId<HTMLButtonElement>('btn-tree');
  btnTree.addEventListener('click', () => {
    tree.setShown(!tree.isShown());
    btnTree.setAttribute('aria-pressed', String(tree.isShown()));
  });

  // Every selection goes through here; one made outside the tree is revealed there (R10).
  const selectNode = (id: string | null) => {
    selectedId = id;
    if (id !== pending?.id) pending = undefined;
    tree.reveal(id);
    if (id === null) {
      showSelection(null);
      graph.clearSelection();
    }
    renderDetails();
    vscode.postMessage({ type: 'shell/selectNode', nodeId: id });
    toolbar?.onSelection(id);
  };
  const openSelected = () => {
    if (selectedId !== null) vscode.postMessage({ type: 'shell/openNode', nodeId: selectedId });
  };
  const nodeIdAt = (target: EventTarget | null) =>
    (target instanceof Element ? target.closest<HTMLElement>('[data-node-id]') : null)?.dataset.nodeId;
  const main = byId('main');
  main.addEventListener('click', (e) => {
    const id = nodeIdAt(e.target);
    if (id !== undefined) selectNode(id);
  });
  main.addEventListener('dblclick', (e) => {
    const id = nodeIdAt(e.target);
    if (id !== undefined) vscode.postMessage({ type: 'shell/openNode', nodeId: id });
  });
  const inside = (target: EventTarget | null, selector: string) => target instanceof Element && target.closest(selector) !== null;
  document.addEventListener('keydown', (e) => {
    // Enter on a button already clicks it; inputs keep Enter for themselves. Escape ends a shown trace (keeping the
    // selection), else clears the selection. Arrows step a shown trace outside text fields.
    if (e.key === 'Escape') {
      if (flow.active()) flow.clear(true);
      else selectNode(null);
    } else if (e.key === 'Enter' && !inside(e.target, 'button, input, textarea, select')) openSelected();
    else if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && flow.active() && !inside(e.target, 'input, textarea, select')) {
      flow.step(e.key === 'ArrowRight' ? 1 : -1);
    }
  });
  // Not a CLICKS entry: its message depends on the selection.
  btnOpen.addEventListener('click', openSelected);
  const codeMatrixShell = { selectNode, getSelectedNodeId: () => selectedId };
  (window as unknown as { codeMatrixShell: unknown }).codeMatrixShell = codeMatrixShell;
  toolbar = mountToolbar(byId('toolbar-slot'), graph, codeMatrixShell);

  for (const [id, message] of Object.entries(CLICKS)) byId(id).addEventListener('click', () => vscode.postMessage(message));
  byId('btn-details').addEventListener('click', () => (details.hidden = !details.hidden));
  // Visible Details text, one entry per line, for the graph/debug seam.
  const detailsLines = () => {
    const lines: string[] = [];
    if (!detailsEmpty.hidden) lines.push(detailsEmpty.textContent ?? '');
    const line = (el: Element) => (el.tagName === 'DT' ? `${el.textContent} ${el.nextElementSibling?.textContent}` : (el.textContent ?? ''));
    if (!detailsFields.hidden) detailsFields.querySelectorAll('dt').forEach((dt) => lines.push(line(dt)));
    if (!detailsHidden.hidden) lines.push(detailsHidden.textContent ?? '');
    if (!btnOpen.hidden) lines.push(btnOpen.textContent ?? '');
    detailsGraph.querySelectorAll('button, dt, li').forEach((el) => lines.push(line(el)));
    return lines;
  };

  window.addEventListener('message', (event: MessageEvent<ShellToWebview | GraphToWebview | IndexToWebview | FlowToWebview>) => {
    const msg = event.data;
    switch (msg.type) {
      case 'shell/state':
        shellState = { state: msg.state, cause: msg.cause };
        if (msg.state === 'starting') cancelled = false;
        // A restarted or failed sidecar sends no index/done for the run it lost.
        if (msg.state === 'starting' || msg.state === 'failed') strip.hide();
        render();
        toolbar?.setEnabled(msg.state === 'ready');
        break;
      case 'index/progress':
        cancelled = false;
        strip.apply(msg);
        render();
        break;
      case 'index/done':
        if (msg.outcome === 'cancelled' && !msg.hadGraph) cancelled = true;
        strip.apply(msg);
        render();
        break;
      case 'shell/selection':
        showSelection(msg.node);
        break;
      case 'graph/refresh':
        graph.applyRefresh(msg);
        // The scoped prompt points at the tree: show it even if it was hidden (node-tree R17).
        if (graph.isScoped() && selectedId === null && !tree.isShown()) {
          tree.setShown(true);
          btnTree.setAttribute('aria-pressed', 'true');
        }
        toolbar?.onRefresh();
        tree.applyRefresh(msg);
        btnTree.disabled = false;
        // Any refresh, empty or too large included, counts as drawn; it never resets (proposal decision 5).
        if (!drawn) {
          drawn = true;
          render();
        }
        flow.retry();
        break;
      case 'graph/expanded':
        graph.addExpanded(msg.fileId, msg);
        tree.addSlice(msg.fileId, msg);
        if (pending?.fileId === msg.fileId) {
          if (isVisible(pending.id)) toolbar?.centre(pending.id);
          pending = undefined;
          renderDetails();
        }
        flow.retry();
        break;
      case 'graph/scoped':
        graph.addScoped(msg.nodeId, msg);
        break;
      case 'tree/fileLoaded':
        tree.addSlice(msg.fileId, msg);
        break;
      case 'tree/links':
        tree.addLinks(msg);
        break;
      case 'tree/loadFailed':
        tree.loadFailed(msg.id);
        break;
      case 'flow/show':
        flow.show(msg.trace, msg.path, msg.hop);
        break;
      case 'flow/clear':
        flow.clear(false);
        break;
      case 'graph/nodeDetails':
        // A reply for a node no longer selected is stale.
        if (msg.node.id !== selectedId) break;
        lastDetail = msg;
        renderDetails();
        break;
      case 'graph/debug':
        if (msg.op === 'tap') graph.tap(msg.id);
        else if (msg.op === 'toggle') graph.toggle(msg.id);
        else if (msg.op === 'click') byId(msg.id).click();
        else if (msg.op === 'key') document.dispatchEvent(new KeyboardEvent('keydown', { key: msg.key }));
        else if (msg.op === 'treeToggle') btnTree.click();
        else if (msg.op === 'treeExpand') tree.expand(msg.id);
        else if (msg.op === 'treeKey') tree.key(msg.key);
        else if (msg.op === 'treeClick') tree.click(msg.id);
        else if (msg.op === 'treeDblClick') tree.dblClick(msg.id);
        else toolbar!.debug(msg);
        vscode.postMessage({
          type: 'graph/debugState',
          ...graph.state(),
          // What the toolbar's counts span shows (the invalid-glob text replaces the counts).
          counts: toolbar!.countsText(),
          details: detailsLines(),
          narrowing: toolbar!.state(),
          strip: strip.text(),
          overlay: overlay.hidden ? '' : (text.textContent ?? ''),
          flow: flow.active() ? { ...flowStrip.state(), ...flow.debug() } : null,
          tree: { ...tree.state(), pressed: btnTree.getAttribute('aria-pressed') === 'true', disabled: btnTree.disabled },
        });
        break;
    }
  });
  render();
}
