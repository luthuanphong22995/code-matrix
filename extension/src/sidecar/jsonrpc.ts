import type { Readable, Writable } from 'node:stream';

export class ResponseError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = 'ResponseError';
  }
}

export class ConnectionClosedError extends Error {
  constructor() {
    super('Connection closed');
    this.name = 'ConnectionClosedError';
  }
}

interface Message {
  id?: number | string | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

// JSON-RPC 2.0 client with LSP Content-Length framing (design/api.md § 1).
export class JsonRpcConnection {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (result: unknown) => void; reject: (err: Error) => void }>();
  private readonly handlers = new Map<string, (params: unknown) => void>();
  private buffer = Buffer.alloc(0);
  private closed = false;

  constructor(private readonly io: { stdin: Writable; stdout: Readable }) {
    io.stdout.on('data', this.onData);
    io.stdout.on('end', this.close);
    io.stdout.on('close', this.close);
    io.stdin.on('error', this.close);
  }

  request<R>(method: string, params?: unknown): Promise<R> {
    if (this.closed) return Promise.reject(new ConnectionClosedError());
    const id = this.nextId++;
    return new Promise<R>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (result: unknown) => void, reject });
      this.send({ id, method, params });
    });
  }

  notify(method: string, params?: unknown): void {
    this.send({ method, params });
  }

  onNotification<P>(method: string, handler: (params: P) => void): void {
    this.handlers.set(method, handler as (params: unknown) => void);
  }

  dispose(): void {
    this.io.stdout.off('data', this.onData);
    this.io.stdout.off('end', this.close);
    this.io.stdout.off('close', this.close);
    this.close();
  }

  private send(message: Message): void {
    if (this.closed) return;
    const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...message }), 'utf8');
    this.io.stdin.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]));
  }

  private readonly onData = (chunk: Buffer): void => {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;
      const length = /Content-Length: *(\d+)/i.exec(this.buffer.toString('ascii', 0, headerEnd))?.[1];
      if (length === undefined) return this.close(); // ponytail: unframeable stream is unrecoverable
      const start = headerEnd + 4;
      const end = start + Number(length);
      if (this.buffer.length < end) return;
      const body = this.buffer.toString('utf8', start, end);
      this.buffer = this.buffer.subarray(end);
      let message: Message;
      try {
        message = JSON.parse(body) as Message;
      } catch {
        continue;
      }
      this.dispatch(message);
    }
  };

  private dispatch(message: Message): void {
    if (message.method !== undefined) {
      this.handlers.get(message.method)?.(message.params);
      return;
    }
    const pending = typeof message.id === 'number' ? this.pending.get(message.id) : undefined;
    if (!pending) return;
    this.pending.delete(message.id as number);
    if (message.error) pending.reject(new ResponseError(message.error.code, message.error.message, message.error.data));
    else pending.resolve(message.result ?? null);
  }

  private readonly close = (): void => {
    this.closed = true;
    for (const { reject } of this.pending.values()) reject(new ConnectionClosedError());
    this.pending.clear();
  };
}
