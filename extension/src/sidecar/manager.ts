import { EventEmitter } from 'node:events';
import * as readline from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { getOutputChannel } from '../output';
import { resolveServerBinary } from './binary';
import { ConnectionClosedError, JsonRpcConnection } from './jsonrpc';
import { INITIALIZE, LOG, SHUTDOWN, STATUS } from './protocol';
import type { InitializeParams, InitializeResult, LogParams, StatusParams } from './protocol';
import type { SidecarState } from './state';

// The slice of `child_process.ChildProcess` the manager uses, so tests can inject a fake.
export interface SidecarProcess {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  kill(): boolean;
  on(event: string, listener: (...args: any[]) => void): unknown;
}

export type Spawn = (command: string, args: string[]) => SidecarProcess;

const BUDGET_WINDOW_MS = 60_000;
const SHUTDOWN_TIMEOUT_MS = 2_000;

// Owns the window's single `code-matrix-server` process (design/flows.md § Sidecar lifecycle).
export class SidecarManager {
  state: SidecarState = { kind: 'not-started' };
  connection: JsonRpcConnection | undefined;
  private child: SidecarProcess | undefined;
  private lastRoots: string[] = [];
  private lastUnexpectedExitAt: number | undefined;
  private readonly events = new EventEmitter();
  // Feature notification handlers (graph/changed), re-attached to every spawned connection.
  private readonly notificationHandlers = new Map<string, (params: unknown) => void>();

  constructor(
    private readonly extensionPath: string,
    private readonly spawn: Spawn,
    private readonly now: () => number,
  ) {}

  onDidChangeState(listener: (state: SidecarState) => void): { dispose(): void } {
    this.events.on('state', listener);
    return { dispose: () => this.events.off('state', listener) };
  }

  // One handler per method; it survives restarts, retries and respawns. Never replaces `$/status` / `$/log`.
  // `never` params: any typed handler fits; the caller owns the params type.
  onNotification(method: string, handler: (params: never) => void): void {
    if (method === STATUS || method === LOG) return;
    this.notificationHandlers.set(method, handler as (params: unknown) => void);
    this.connection?.onNotification(method, handler);
  }

  start(roots: string[]): void {
    if (this.child) return;
    this.lastRoots = roots;
    this.setState({ kind: 'starting' });

    let binaryPath: string;
    try {
      binaryPath = resolveServerBinary(this.extensionPath, process.platform, process.arch).path;
    } catch (err) {
      this.setState({ kind: 'failed', cause: (err as Error).message });
      return;
    }

    const output = getOutputChannel();
    const child = this.spawn(binaryPath, []);
    const connection = new JsonRpcConnection(child);
    this.child = child;
    this.connection = connection;

    readline.createInterface({ input: child.stderr }).on('line', (line) => output.appendLine(line));
    child.on('error', (err: Error) => {
      if (child !== this.child) return;
      this.detach();
      this.setState({ kind: 'failed', cause: err.message });
    });
    child.on('exit', (code: number | null, signal: string | null) => this.onExit(child, code ?? signal));

    connection.onNotification<StatusParams>(STATUS, ({ state, detail }) =>
      this.setState(state === 'indexing' ? { kind: 'indexing', detail } : { kind: 'ready' }),
    );
    connection.onNotification<LogParams>(LOG, ({ level, message }) => output.appendLine(`[${level}] ${message}`));
    for (const [method, handler] of this.notificationHandlers) connection.onNotification(method, handler);

    const params: InitializeParams = { roots };
    connection.request<InitializeResult>(INITIALIZE, params).then(
      () => {
        if (child === this.child && this.state.kind === 'starting') this.setState({ kind: 'ready' });
      },
      (err: Error) => {
        if (child !== this.child || err instanceof ConnectionClosedError) return;
        this.detach();
        child.kill();
        this.setState({ kind: 'failed', cause: `initialize failed: ${err.message}` });
      },
    );
  }

  async restart(): Promise<void> {
    await this.shutdown();
    this.start(this.lastRoots);
  }

  retry(): void {
    this.lastUnexpectedExitAt = undefined;
    this.start(this.lastRoots);
  }

  async stop(): Promise<void> {
    await this.shutdown();
    this.setState({ kind: 'not-started' });
  }

  dispose(): Promise<void> {
    return this.stop();
  }

  private setState(state: SidecarState): void {
    this.state = state;
    this.events.emit('state', state);
  }

  // ponytail: a detached process's exit is the expected one — only the current child's exit counts.
  private detach(): void {
    this.connection?.dispose();
    this.child = undefined;
    this.connection = undefined;
  }

  private async shutdown(): Promise<void> {
    const child = this.child;
    const connection = this.connection;
    if (!child || !connection) return;
    this.child = undefined;
    this.connection = undefined;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill();
        resolve();
      }, SHUTDOWN_TIMEOUT_MS);
      child.on('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      connection.request(SHUTDOWN).catch(() => undefined);
    });
    connection.dispose();
  }

  private onExit(child: SidecarProcess, code: number | string | null): void {
    if (child !== this.child) return;
    this.detach();
    const output = getOutputChannel();
    const now = this.now();
    if (this.lastUnexpectedExitAt !== undefined && now - this.lastUnexpectedExitAt < BUDGET_WINDOW_MS) {
      output.appendLine(`server exited with code ${code}`);
      this.setState({ kind: 'failed', cause: `Process exited with code ${code}` });
      return;
    }
    output.appendLine(`server exited with code ${code}, restarting`);
    this.lastUnexpectedExitAt = now;
    this.start(this.lastRoots);
  }
}
