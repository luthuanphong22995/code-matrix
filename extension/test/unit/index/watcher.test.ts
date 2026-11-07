import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IndexWatcher, WATCH_GLOB, isExcluded } from '../../../src/index/watcher';
import { SidecarManager } from '../../../src/sidecar/manager';
import { FakeChildProcess } from '../fakes/fakeProcess';
import { Uri, watchers, workspace, workspaceFoldersChanged } from '../mocks/vscode';

describe('isExcluded', () => {
  it('matches the path or any ancestor directory; skips invalid globs', () => {
    expect(isExcluded('node_modules/x/a.ts', ['**/node_modules'])).toBe(true);
    expect(isExcluded('src/node_modules/a.ts', ['**/node_modules'])).toBe(true);
    expect(isExcluded('src/a.ts', ['**/node_modules'])).toBe(false);
    expect(isExcluded('src/a.gen.ts', ['**/*.gen.ts'])).toBe(true);
    expect(isExcluded('src/a.ts', ['[a'])).toBe(false);
    expect(isExcluded('src/a.ts', [])).toBe(false);
  });
});

describe('IndexWatcher', () => {
  let procs: FakeChildProcess[];
  let manager: SidecarManager;
  let watcher: IndexWatcher;

  const proc = () => procs.at(-1)!;
  const ready = () => vi.waitFor(() => expect(manager.state).toEqual({ kind: 'ready' }));
  const sent = (p = proc()) => p.received.filter((m) => m.method === 'index/filesChanged').map((m) => m.params);
  const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms));
  const live = () => watchers.filter((w) => w.dispose.mock.calls.length === 0);

  beforeEach(() => {
    process.env.CODE_MATRIX_SERVER_PATH = __filename;
    watchers.length = 0;
    workspaceFoldersChanged.dispose();
    workspace.workspaceFolders = [
      { uri: Uri.file('/proj'), name: 'proj', index: 0 },
      { uri: Uri.file('/lib'), name: 'lib', index: 1 },
    ];
    workspace.settings = { 'files.exclude': { '**/out': true, '**/gen': false } };
    procs = [];
    manager = new SidecarManager(
      '/ext',
      () => {
        const p = new FakeChildProcess();
        procs.push(p);
        return p;
      },
      () => 0,
    );
    watcher = new IndexWatcher(manager);
  });

  afterEach(async () => {
    watcher.dispose();
    await manager.stop();
    delete process.env.CODE_MATRIX_SERVER_PATH;
  });

  it('watches every root once ready and batches events into one index/filesChanged per 100 ms, in order', async () => {
    expect(watchers).toHaveLength(0);
    manager.start(['/proj', '/lib']);
    await ready();
    expect(watchers.map((w) => w.pattern)).toEqual([
      { base: workspace.workspaceFolders![0], pattern: WATCH_GLOB },
      { base: workspace.workspaceFolders![1], pattern: WATCH_GLOB },
    ]);

    const [proj, lib] = watchers;
    proj.created.fire(Uri.file('/proj/a.ts'));
    proj.changed.fire(Uri.file('/proj/out/b.ts'));
    lib.changed.fire(Uri.file('/lib/b.go'));
    proj.deleted.fire(Uri.file('/proj/a.ts'));
    proj.changed.fire(Uri.file('/proj/gen/a.ts'));
    await vi.waitFor(() => expect(sent()).toHaveLength(1));
    await settle();
    expect(sent()).toEqual([
      {
        changes: [
          { path: '/proj/a.ts', type: 'created' },
          { path: '/lib/b.go', type: 'changed' },
          { path: '/proj/a.ts', type: 'deleted' },
          { path: '/proj/gen/a.ts', type: 'changed' },
        ],
      },
    ]);

    proj.changed.fire(Uri.file('/proj/out/c.ts'));
    await settle();
    expect(sent()).toHaveLength(1);
    lib.created.fire(Uri.file('/lib/c.py'));
    await vi.waitFor(() => expect(sent()).toHaveLength(2));
    expect(sent()[1]).toEqual({ changes: [{ path: '/lib/c.py', type: 'created' }] });
    expect(proc().received.filter((m) => m.method === 'index/run')).toHaveLength(0);
  });

  it('failed drops watchers and the pending batch; retry and restart recreate them', async () => {
    manager.start(['/proj']);
    await ready();
    watchers[0].changed.fire(Uri.file('/proj/a.ts'));
    proc().emit('error', new Error('boom'));
    expect(manager.state.kind).toBe('failed');
    expect(live()).toHaveLength(0);
    await settle();
    expect(sent(procs[0])).toEqual([]);

    manager.retry();
    expect(live()).toHaveLength(0); // starting
    await ready();
    expect(live()).toHaveLength(2);

    const before = live();
    await manager.restart(); // passes through starting
    await ready();
    expect(before.every((w) => w.dispose.mock.calls.length === 1)).toBe(true);
    expect(live()).toHaveLength(2);
    expect(watchers).toHaveLength(6);
  });

  it('a workspace-folder change recreates watchers while ready, creates none while not-started; dispose ends it', async () => {
    workspaceFoldersChanged.fire({});
    expect(watchers).toHaveLength(0);

    manager.start(['/proj']);
    await ready();
    workspace.workspaceFolders = [{ uri: Uri.file('/added'), name: 'added', index: 0 }];
    workspaceFoldersChanged.fire({});
    expect(live().map((w) => w.pattern.base)).toEqual([workspace.workspaceFolders[0]]);
    expect(watchers).toHaveLength(3);

    watcher.dispose();
    expect(live()).toHaveLength(0);
    workspaceFoldersChanged.fire({});
    expect(watchers).toHaveLength(3);
  });
});
