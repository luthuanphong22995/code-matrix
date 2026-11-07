import type { IndexToWebview, WebviewToIndex } from '../src/index/messages';
import type { WebviewToShell } from '../src/panel/messages';

export interface StripView {
  text: string;
  cancel: boolean;
  showLog: boolean;
  dismiss: boolean;
}

// Pure mapping from an index/* message to the strip (design/ui.md § Index strip); `undefined` hides it.
export function stripView(msg: IndexToWebview): StripView | undefined {
  if (msg.type === 'index/progress') {
    const text = msg.phase === 'scanning' ? 'Scanning workspace…' : `Indexing ${msg.done} of ${msg.total} files`;
    return { text, cancel: true, showLog: false, dismiss: false };
  }
  if (msg.outcome === 'cancelled') return undefined;
  const text = msg.failed === 0 ? `Indexed ${msg.indexed} files` : `Indexed ${msg.indexed} files, ${msg.failed} failed`;
  return { text, cancel: false, showLog: msg.failed > 0 || msg.skipped > 0, dismiss: true };
}

export interface Strip {
  apply(msg: IndexToWebview): void;
  hide(): void;
  // The visible text followed by the visible controls' labels; '' when hidden (the graph/debug seam).
  text(): string;
}

// Wires the static #index-strip markup (getHtml). `×` only hides: graph, selection and overlay stay as they are.
export function mountStrip(post: (message: WebviewToIndex | WebviewToShell) => void): Strip {
  const byId = (id: string) => document.getElementById(id) as HTMLElement;
  const strip = byId('index-strip');
  const label = byId('text-index-progress');
  const cancel = byId('btn-index-cancel');
  const showLog = byId('link-index-show-log');
  const dismiss = byId('btn-index-dismiss');
  const hide = () => {
    strip.hidden = true;
  };
  cancel.addEventListener('click', () => post({ type: 'index/cancel' }));
  showLog.addEventListener('click', (e) => {
    e.preventDefault();
    post({ type: 'shell/showLog' });
  });
  dismiss.addEventListener('click', hide);
  return {
    apply(msg) {
      const view = stripView(msg);
      if (!view) return hide();
      label.textContent = view.text;
      cancel.hidden = !view.cancel;
      showLog.hidden = !view.showLog;
      dismiss.hidden = !view.dismiss;
      strip.hidden = false;
    },
    hide,
    text: () =>
      strip.hidden ? '' : [label, cancel, showLog, dismiss].filter((el) => !el.hidden).map((el) => el.textContent).join(' '),
  };
}
