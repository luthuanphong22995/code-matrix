import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SidecarManager } from '../../src/sidecar/manager';
import type { SidecarState } from '../../src/sidecar/state';
import { StatusBar } from '../../src/statusBar';
import { StatusBarAlignment, ThemeColor, window } from './mocks/vscode';

describe('StatusBar', () => {
  let manager: SidecarManager;
  let bar: StatusBar;
  const item = () => window.createStatusBarItem.mock.results[0].value;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new SidecarManager('/ext', vi.fn(), () => 0);
    bar = new StatusBar(manager);
  });

  it('creates a left item with the openGraph command, hidden until the first start (R4, R7)', () => {
    expect(window.createStatusBarItem).toHaveBeenCalledWith('codeMatrix.status', StatusBarAlignment.Left);
    expect(item().command).toBe('codeMatrix.openGraph');
    expect(item().show).not.toHaveBeenCalled();
    expect(bar.visible).toBe(false);
    bar.update({ kind: 'not-started' });
    expect(item().show).not.toHaveBeenCalled();
  });

  it.each<[SidecarState, string]>([
    [{ kind: 'starting' }, 'Code Matrix: starting'],
    [{ kind: 'ready' }, 'Code Matrix: ready'],
    [{ kind: 'indexing', detail: 'x' }, 'Code Matrix: indexing'],
    [{ kind: 'failed', cause: 'boom' }, 'Code Matrix: failed'],
  ])('shows %j as %s (R7)', (state, text) => {
    bar.update(state);
    expect(item().text).toBe(text);
    expect(item().show).toHaveBeenCalledOnce();
    expect(bar.visible).toBe(true);
  });

  it('failed uses the error background and opens the log; leaving failed restores both (R7)', () => {
    bar.update({ kind: 'failed', cause: 'boom' });
    expect(item().text).toBe('Code Matrix: failed');
    expect(item().backgroundColor).toBeInstanceOf(ThemeColor);
    expect(item().backgroundColor?.id).toBe('statusBarItem.errorBackground');
    expect(item().command).toBe('codeMatrix.showLog');
    bar.update({ kind: 'starting' });
    expect(item().backgroundColor).toBeUndefined();
    expect(item().command).toBe('codeMatrix.openGraph');
  });

  it('follows manager state changes and never hides again', () => {
    process.env.CODE_MATRIX_SERVER_PATH = '/nonexistent';
    manager.start(['/proj']); // starting → failed (missing binary)
    delete process.env.CODE_MATRIX_SERVER_PATH;
    expect(item().text).toBe('Code Matrix: failed');
    bar.update({ kind: 'not-started' });
    expect(item().hide).not.toHaveBeenCalled();
    expect(item().text).toBe('Code Matrix: failed');
  });
});
