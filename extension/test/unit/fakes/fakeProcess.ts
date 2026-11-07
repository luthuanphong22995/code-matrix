import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { vi } from 'vitest';
import type { LogLevel, ServerState } from '../../../src/sidecar/protocol';

interface Received {
  id?: number;
  method: string;
  params?: unknown;
}

// Scripted stand-in for `code-matrix-server`: answers `initialize` and `shutdown` over LSP-framed stdio.
export class FakeChildProcess extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly received: Received[] = [];
  readonly kill = vi.fn(() => {
    this.exit(null, 'SIGTERM');
    return true;
  });
  ignoreShutdown = false;
  initializeError: { code: number; message: string } | undefined;
  private buffer = Buffer.alloc(0);
  private exited = false;

  constructor() {
    super();
    this.stdin.on('data', (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      for (;;) {
        const headerEnd = this.buffer.indexOf('\r\n\r\n');
        if (headerEnd < 0) return;
        const length = Number(/Content-Length: (\d+)/.exec(this.buffer.toString('ascii', 0, headerEnd))![1]);
        const end = headerEnd + 4 + length;
        if (this.buffer.length < end) return;
        const message = JSON.parse(this.buffer.toString('utf8', headerEnd + 4, end)) as Received;
        this.buffer = this.buffer.subarray(end);
        this.handle(message);
      }
    });
  }

  status(state: ServerState, detail?: string): void {
    this.send({ method: '$/status', params: { state, detail } });
  }

  log(level: LogLevel, message: string): void {
    this.send({ method: '$/log', params: { level, message } });
  }

  notify(method: string, params?: unknown): void {
    this.send({ method, params });
  }

  // Scripted replies by method; requests with no entry (other than initialize/shutdown) go unanswered.
  replies = new Map<string, (params: unknown) => { result?: unknown; error?: { code: number; message: string } }>();

  writeStderr(text: string): void {
    this.stderr.write(text);
  }

  crash(code: number): void {
    this.exit(code, null);
  }

  private handle(message: Received): void {
    this.received.push(message);
    if (message.method === 'initialize') {
      if (this.initializeError) this.send({ id: message.id, error: this.initializeError });
      else this.send({ id: message.id, result: { serverVersion: '0.0.0', languages: [] } });
    } else if (message.method === 'shutdown' && !this.ignoreShutdown) {
      this.send({ id: message.id, result: null });
      this.exit(0, null);
    } else {
      const reply = this.replies.get(message.method);
      if (reply) this.send({ id: message.id, ...reply(message.params) });
    }
  }

  private send(message: object): void {
    const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...message }), 'utf8');
    this.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
    this.stdout.write(body);
  }

  private exit(code: number | null, signal: string | null): void {
    if (this.exited) return;
    this.exited = true;
    this.stdout.end();
    this.stderr.end();
    this.emit('exit', code, signal);
  }
}
