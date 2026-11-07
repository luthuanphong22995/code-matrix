import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SidecarManager } from '../../../src/sidecar/manager';
import type { SidecarState } from '../../../src/sidecar/state';
import { FakeChildProcess } from '../fakes/fakeProcess';
import { outputLines, window } from '../mocks/vscode';

describe('SidecarManager', () => {
  let procs: FakeChildProcess[];
  let spawn: ReturnType<typeof vi.fn<(command: string, args: string[]) => FakeChildProcess>>;
  let clock: number;
  let states: SidecarState[];
  let manager: SidecarManager;

  const ready = () => vi.waitFor(() => expect(manager.state).toEqual({ kind: 'ready' }));
  const methods = (proc: FakeChildProcess) => proc.received.map((m) => m.method);
  const expectNoToasts = () => {
    expect(window.showInformationMessage).not.toHaveBeenCalled();
    expect(window.showWarningMessage).not.toHaveBeenCalled();
    expect(window.showErrorMessage).not.toHaveBeenCalled();
  };

  beforeEach(() => {
    outputLines.length = 0;
    vi.clearAllMocks();
    process.env.CODE_MATRIX_SERVER_PATH = __filename;
    procs = [];
    clock = 0;
    spawn = vi.fn(() => {
      const proc = new FakeChildProcess();
      procs.push(proc);
      return proc;
    });
    manager = new SidecarManager('/ext', spawn, () => clock);
    states = [];
    manager.onDidChangeState((state) => states.push(state));
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.CODE_MATRIX_SERVER_PATH;
  });

  describe('happy path', () => {
    it('goes starting then ready and initializes with the root', async () => {
      manager.start(['/proj']);
      expect(manager.state).toEqual({ kind: 'starting' });
      await ready();
      expect(states).toEqual([{ kind: 'starting' }, { kind: 'ready' }]);
      expect(manager.connection).toBeDefined();
      expect(procs[0].received[0]).toMatchObject({ method: 'initialize', params: { roots: ['/proj'] } });
    });

    it('sends every root in one initialize (R3)', async () => {
      manager.start(['/api', '/web']);
      await ready();
      expect(procs[0].received.filter((m) => m.method === 'initialize')).toEqual([
        expect.objectContaining({ params: { roots: ['/api', '/web'] } }),
      ]);
    });
  });

  describe('restart budget (R5)', () => {
    beforeEach(async () => {
      manager.start(['/proj']);
      await ready();
      states.length = 0;
      procs[0].crash(101);
    });

    it('restarts silently on the first crash', async () => {
      expect(outputLines).toContain('server exited with code 101, restarting');
      expect(spawn).toHaveBeenCalledTimes(2);
      await ready();
      expect(states).toEqual([{ kind: 'starting' }, { kind: 'ready' }]);
      expectNoToasts();
    });

    it('fails on a second crash within 60 s', async () => {
      await ready();
      clock = 20_000;
      procs[1].crash(101);
      expect(manager.state).toEqual({ kind: 'failed', cause: 'Process exited with code 101' });
      expect(spawn).toHaveBeenCalledTimes(2);
      expectNoToasts();
    });

    it('restarts silently again when the second crash is 61 s later', async () => {
      await ready();
      clock = 61_000;
      procs[1].crash(101);
      expect(spawn).toHaveBeenCalledTimes(3);
      expect(manager.state).toEqual({ kind: 'starting' });
      await ready();
    });
  });

  describe('recovery', () => {
    it('retry() from failed resets the budget (R6)', async () => {
      manager.start(['/proj']);
      await ready();
      procs[0].crash(101);
      await ready();
      procs[1].crash(101);
      expect(manager.state.kind).toBe('failed');

      manager.retry();
      expect(spawn).toHaveBeenCalledTimes(3);
      expect(manager.state).toEqual({ kind: 'starting' });
      await ready();
      procs[2].crash(101);
      expect(spawn).toHaveBeenCalledTimes(4);
      await ready();
    });

    it('restart() shuts down, respawns and leaves the budget untouched', async () => {
      manager.start(['/proj']);
      await ready();
      states.length = 0;
      await manager.restart();
      expect(methods(procs[0])).toContain('shutdown');
      expect(spawn).toHaveBeenCalledTimes(2);
      await ready();
      expect(states).toEqual([{ kind: 'starting' }, { kind: 'ready' }]);

      procs[1].crash(101);
      expect(manager.state).toEqual({ kind: 'starting' });
      expect(spawn).toHaveBeenCalledTimes(3);
    });
  });

  describe('stop and diagnostics', () => {
    it('stop() sends shutdown and never respawns (R4)', async () => {
      manager.start(['/proj']);
      await ready();
      await manager.stop();
      expect(methods(procs[0])).toContain('shutdown');
      expect(procs[0].kill).not.toHaveBeenCalled();
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(manager.state).toEqual({ kind: 'not-started' });
      expect(outputLines).toEqual([]);
    });

    it('stop() kills a sidecar that ignores shutdown after 2 s (R4)', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      manager.start(['/proj']);
      await ready();
      procs[0].ignoreShutdown = true;
      const stopping = manager.stop();
      await vi.waitFor(() => expect(methods(procs[0])).toContain('shutdown'));
      expect(procs[0].kill).not.toHaveBeenCalled();
      vi.advanceTimersByTime(2_000);
      await stopping;
      expect(procs[0].kill).toHaveBeenCalledOnce();
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(manager.state).toEqual({ kind: 'not-started' });
    });

    it('a spawn error fails with its message and never respawns', () => {
      manager.start(['/proj']);
      procs[0].emit('error', new Error('spawn EACCES'));
      expect(manager.state).toEqual({ kind: 'failed', cause: 'spawn EACCES' });
      procs[0].crash(1); // the detached child's later exit is not an unexpected exit
      expect(spawn).toHaveBeenCalledOnce();
      expect(manager.state.kind).toBe('failed');
    });

    it('an initialize error fails with its message and kills the child', async () => {
      spawn.mockImplementationOnce(() => {
        const proc = new FakeChildProcess();
        proc.initializeError = { code: -32603, message: 'bad roots' };
        procs.push(proc);
        return proc;
      });
      manager.start(['/proj']);
      await vi.waitFor(() => expect(manager.state).toEqual({ kind: 'failed', cause: 'initialize failed: bad roots' }));
      expect(procs[0].kill).toHaveBeenCalledOnce();
      expect(spawn).toHaveBeenCalledOnce();
    });

    it('missing binary fails with the R11 cause without spawning', () => {
      process.env.CODE_MATRIX_SERVER_PATH = '/nonexistent/code-matrix-server';
      manager.start(['/proj']);
      expect(manager.state).toEqual({
        kind: 'failed',
        cause: `Server binary not found for ${process.platform}-${process.arch}: /nonexistent/code-matrix-server`,
      });
      expect(spawn).not.toHaveBeenCalled();
    });

    it('routes $/status, $/log and stderr (R10)', async () => {
      manager.start(['/proj']);
      await ready();
      procs[0].status('indexing', 'x');
      await vi.waitFor(() => expect(manager.state).toEqual({ kind: 'indexing', detail: 'x' }));
      procs[0].log('warn', 'm');
      procs[0].writeStderr('boom\n');
      await vi.waitFor(() => expect(outputLines).toEqual(expect.arrayContaining(['[warn] m', 'boom'])));
      expectNoToasts();
    });
  });

  describe('onNotification', () => {
    it('keeps a feature handler across restart() and an unexpected-exit respawn', async () => {
      const changed = vi.fn();
      manager.onNotification('graph/changed', changed);
      manager.start(['/proj']);
      await ready();
      procs[0].notify('graph/changed', { removedNodeIds: ['a'] });
      await vi.waitFor(() => expect(changed).toHaveBeenLastCalledWith({ removedNodeIds: ['a'] }));

      await manager.restart();
      await ready();
      procs[1].notify('graph/changed', { removedNodeIds: ['b'] });
      await vi.waitFor(() => expect(changed).toHaveBeenLastCalledWith({ removedNodeIds: ['b'] }));

      procs[1].crash(1);
      await ready();
      procs[2].notify('graph/changed', { removedNodeIds: ['c'] });
      await vi.waitFor(() => expect(changed).toHaveBeenLastCalledWith({ removedNodeIds: ['c'] }));
      expect(changed).toHaveBeenCalledTimes(3);
    });

    it('attaches to the live connection and never replaces $/status', async () => {
      manager.start(['/proj']);
      await ready();
      const changed = vi.fn();
      manager.onNotification('graph/changed', changed);
      manager.onNotification('$/status', vi.fn());
      procs[0].notify('graph/changed', { removedNodeIds: [] });
      await vi.waitFor(() => expect(changed).toHaveBeenCalledOnce());
      procs[0].status('indexing', 'x');
      await vi.waitFor(() => expect(manager.state).toEqual({ kind: 'indexing', detail: 'x' }));
    });
  });
});
