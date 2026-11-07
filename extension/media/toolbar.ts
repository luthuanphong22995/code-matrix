import type { DebugOp, NarrowingDebugState } from '../src/graph/messages';
import { enterFocus, exitFocus } from './focus';
import { globToRegExp, InvalidGlob } from './glob';
import type { GraphView } from './graph';
import { defaultNarrowing, type Kind, KINDS } from './narrowing';
import { findMatches } from './search';

// The shell's selection seam (window.codeMatrixShell); narrowing keeps no copy of the selection.
interface Selection {
  getSelectedNodeId(): string | null;
}

export interface Toolbar {
  // Every control is disabled unless the last shell/state was `ready`.
  setEnabled(ready: boolean): void;
  // main.ts calls this after every selection change.
  onSelection(id: string | null): void;
  // The canvas changed: counts, halos and Focus availability follow.
  refresh(): void;
  // A graph/refresh swapped the graph: the match text follows the new visible set.
  onRefresh(): void;
  // What the counts span shows: `N nodes · M edges`, or the invalid-glob text in their place.
  countsText(): string;
  // Runs a narrowing debug op through the real control handlers; other ops are not the toolbar's.
  debug(op: DebugOp): void;
  state(): NarrowingDebugState;
  // Centres the view on a drawn node and records it as `centredOn` (search, focus and a tree selection).
  centre(id: string): void;
}

// The code-graph toolbar in #toolbar-slot: Search, Path, Kinds, Focus + Hops, counts (design/ui.md § Toolbar
// controls). Everything happens in the webview; the only posts it causes are the canvas's own expand/collapse when
// leaving focus re-applies expansion.
export function mountToolbar(slot: HTMLElement, view: GraphView, shell: Selection): Toolbar {
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}): HTMLElementTagNameMap[K] =>
    Object.assign(document.createElement(tag), props);
  const search = el('input', { id: 'nar-search', type: 'search', placeholder: 'Search nodes' });
  const matches = el('span', { id: 'nar-matches' });
  const path = el('input', { id: 'nar-path', type: 'text', placeholder: 'Path filter, e.g. src/api/**' });
  const kindsBtn = el('button', { id: 'nar-kinds', textContent: 'Kinds' });
  const popover = el('div', { id: 'nar-kinds-popover', hidden: true });
  const boxes = new Map<Kind, HTMLInputElement>();
  for (const [title, kinds] of [['Nodes', KINDS.nodes], ['Edges', KINDS.edges]] as const) {
    const group = el('fieldset');
    group.append(el('legend', { textContent: title }));
    for (const kind of kinds) {
      const box = el('input', { type: 'checkbox' });
      boxes.set(kind, box);
      const label = el('label');
      label.append(box, ` ${kind}`);
      group.append(label);
    }
    popover.append(group);
  }
  const kindsWrap = el('span', { id: 'nar-kinds-wrap' });
  kindsWrap.append(kindsBtn, popover);
  const focusBtn = el('button', { id: 'nar-focus', textContent: 'Focus' });
  const hops = el('input', { id: 'nar-hops', type: 'number', min: '1', max: '3', value: '1', title: 'Hops' });
  const hopsLabel = el('label', { id: 'nar-hops-label' });
  hopsLabel.append('Hops ', hops);
  const groupBtn = el('button', { id: 'nar-group', textContent: 'Group', title: 'Group by folder' });
  const counts = el('span', { id: 'graph-counts' });
  slot.append(search, matches, path, kindsWrap, focusBtn, hopsLabel, groupBtn, counts);

  const state = defaultNarrowing();
  let ready = false;
  let invalid: string | null = null;
  let matchText = '';
  let centredOn: string | null = null;

  const render = () => {
    const halos = findMatches(view.visibleNodes(), state.search);
    view.cy.batch(() => {
      view.cy.$('.search-halo').removeClass('search-halo');
      for (const id of halos) view.cy.getElementById(id).addClass('search-halo');
    });
    matches.textContent = matchText;
    counts.textContent = toolbar.countsText();
    counts.classList.toggle('invalid', invalid !== null);
    for (const [kind, box] of boxes) box.checked = state.kinds[kind];
    for (const c of [search, path, kindsBtn, groupBtn, ...boxes.values()]) c.disabled = !ready;
    groupBtn.setAttribute('aria-pressed', String(view.isGrouped()));
    // Scoped view: Focus is off and Hops is the scope's depth (code-graph R20).
    const scoped = view.isScoped();
    focusBtn.disabled = !ready || scoped || shell.getSelectedNodeId() === null;
    focusBtn.setAttribute('aria-pressed', String(state.focus !== null));
    hops.disabled = !ready || (scoped ? shell.getSelectedNodeId() === null : state.focus === null);
    hops.value = String(scoped ? state.scopeHops : (state.focus?.hops ?? 1));
  };
  const apply = () => {
    view.applyVisibility(state);
    render();
  };

  const leaveFocus = () => {
    const snap = exitFocus(state);
    if (!snap) return;
    path.value = state.pathGlob;
    invalid = null;
    // Expansion goes back through the canvas's own toggle path (graph/expand / graph/collapse).
    const now = view.expandedFiles();
    for (const f of now) if (!snap.expanded.has(f)) view.toggle(f);
    for (const f of snap.expanded) if (!now.has(f)) view.toggle(f);
    apply();
    view.restoreViewport(snap.viewport);
  };
  const focusOn = (id: string) => {
    state.focus = { nodeId: id, hops: state.focus?.hops ?? 1 };
    apply();
    centre(id);
  };
  const centre = (id: string) => {
    view.centerOn(id);
    centredOn = id;
  };

  const matchesFor = (found: string[]) =>
    state.search === '' ? '' : found.length ? `${found.length} matches` : `No matches for '${state.search}'`;

  search.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      state.search = search.value;
      const found = findMatches(view.visibleNodes(), state.search);
      matchText = matchesFor(found);
      if (found.length) centre(found[0]);
      render();
    } else if (e.key === 'Escape') {
      // Consumed here: the shell's document listener would clear the selection.
      e.stopPropagation();
      search.value = state.search = matchText = '';
      render();
    }
  });
  path.addEventListener('input', () => {
    if (invalid === null) return;
    invalid = null;
    render();
  });
  path.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const text = path.value.trim();
    try {
      state.lastValidGlob = text === '' ? null : globToRegExp(text);
      state.pathGlob = text;
      invalid = null;
    } catch (err) {
      if (!(err instanceof InvalidGlob)) throw err;
      // The previous glob stays in force.
      invalid = text;
    }
    apply();
  });
  kindsBtn.addEventListener('click', () => (popover.hidden = !popover.hidden));
  for (const [kind, box] of boxes) {
    box.addEventListener('change', () => {
      state.kinds[kind] = box.checked;
      apply();
    });
  }
  focusBtn.addEventListener('click', () => {
    if (state.focus) return leaveFocus();
    const id = shell.getSelectedNodeId();
    if (id === null) return;
    enterFocus(state, id, { expanded: view.expandedFiles(), viewport: view.viewport() });
    focusOn(id);
  });
  // Grouping is the canvas's, not narrowing state: no filter, focus or refresh touches it.
  groupBtn.addEventListener('click', () => {
    view.setGrouped(!view.isGrouped());
    render();
  });
  hops.addEventListener('input', () => {
    const n = Math.min(3, Math.max(1, Math.round(Number(hops.value)) || 1));
    // Scoped: the canvas re-asks the sidecar for the deeper neighbourhood on its next sync.
    if (view.isScoped()) state.scopeHops = n;
    else if (state.focus) state.focus.hops = n;
    else return;
    apply();
  });

  const key = (target: EventTarget, key: string) => target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  const toolbar: Toolbar = {
    setEnabled(r) {
      ready = r;
      render();
    },
    onSelection(id) {
      if (state.focus && id === null) leaveFocus();
      else if (state.focus && id !== null) focusOn(id);
      render();
    },
    refresh: render,
    onRefresh() {
      // Focus never runs in scoped view: a refresh that turned it on leaves focus first (R8).
      if (view.isScoped() && state.focus) leaveFocus();
      // Over the new visible set, without re-centring.
      matchText = matchesFor(findMatches(view.visibleNodes(), state.search));
      render();
    },
    centre,
    countsText: () => (invalid !== null ? `Invalid pattern: ${invalid}` : view.counts()),
    debug(op) {
      switch (op.op) {
        case 'search':
          search.value = op.text;
          return void key(search, 'Enter');
        case 'searchEscape':
          return void key(search, 'Escape');
        case 'path':
          path.value = op.text;
          path.dispatchEvent(new Event('input'));
          return void key(path, 'Enter');
        case 'kind': {
          const box = boxes.get(op.kind as Kind);
          if (!box) return;
          box.checked = op.on;
          return void box.dispatchEvent(new Event('change'));
        }
        case 'focus':
          return focusBtn.click();
        case 'hops':
          hops.value = String(op.n);
          return void hops.dispatchEvent(new Event('input'));
        case 'escape':
          return void key(document.body, 'Escape');
      }
    },
    state: () => ({
      matchText,
      pathText: path.value,
      canvasText: view.canvasText(),
      halos: view.cy.$('.search-halo').map((n) => n.id()),
      centredOn,
      focusEnabled: !focusBtn.disabled,
      hopsEnabled: !hops.disabled,
      focused: state.focus !== null,
      hops: view.isScoped() ? state.scopeHops : (state.focus?.hops ?? 1),
      kinds: { ...state.kinds },
    }),
  };
  render();
  return toolbar;
}
