import * as assert from 'node:assert';
import * as vscode from 'vscode';
import type { Shell } from '../../../src/extension';
import type { DebugState } from '../../../src/graph/messages';

// Activates the extension and returns its API (`activate`'s return value).
export async function activateShell(): Promise<Shell> {
  const ext = vscode.extensions.getExtension<Shell>('code-matrix.code-matrix');
  assert.ok(ext, 'extension code-matrix.code-matrix not found');
  return ext.activate();
}

export async function waitFor(check: () => boolean, what: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) assert.fail(`timed out after ${timeoutMs} ms waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

// Records every message any webview posts, including the first post of panels created later, by wrapping the
// shared prototype's `postMessage` (the instance property is not writable). Returns the restore function.
export function capturePosts(webview: vscode.Webview, sink: unknown[]): () => void {
  const proto = Object.getPrototypeOf(webview) as { postMessage(message: unknown): Thenable<boolean> };
  const original = proto.postMessage;
  proto.postMessage = function (this: unknown, message: unknown) {
    sink.push(message);
    return original.call(this, message);
  };
  return () => (proto.postMessage = original);
}

// Polls the canvas through the graph/debug seam until `check` holds; returns that state. A post sent before the
// webview script loaded is lost, so each poll gives up after 1 s and asks again.
export async function canvasState(shell: Shell, check: (s: DebugState) => boolean, what: string, timeoutMs = 15_000): Promise<DebugState> {
  const deadline = Date.now() + timeoutMs;
  let last: DebugState | undefined;
  while (Date.now() < deadline) {
    last = await Promise.race([shell.graph.debug({ op: 'state' }), new Promise<undefined>((r) => setTimeout(r, 1_000))]);
    if (last && check(last)) return last;
    await new Promise((r) => setTimeout(r, 100));
  }
  return assert.fail(`timed out after ${timeoutMs} ms waiting for ${what}; last state ${JSON.stringify(last)}`);
}

export const codeMatrixTabs = () =>
  vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((t) => t.label === 'Code Matrix');
