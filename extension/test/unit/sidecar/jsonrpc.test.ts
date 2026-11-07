import { PassThrough } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectionClosedError, JsonRpcConnection, ResponseError } from '../../../src/sidecar/jsonrpc';

const frame = (message: object): Buffer => {
  const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...message }), 'utf8');
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]);
};

describe('JsonRpcConnection', () => {
  let toServer: PassThrough;
  let fromServer: PassThrough;
  let sent: Array<{ id: number; method: string }>;
  let connection: JsonRpcConnection;

  beforeEach(() => {
    toServer = new PassThrough();
    fromServer = new PassThrough();
    sent = [];
    toServer.on('data', (chunk: Buffer) => sent.push(JSON.parse(chunk.toString('utf8').split('\r\n\r\n')[1])));
    connection = new JsonRpcConnection({ stdin: toServer, stdout: fromServer });
  });

  it('reassembles a frame split mid-header and mid-body', async () => {
    const handler = vi.fn();
    connection.onNotification('$/log', handler);
    const bytes = frame({ method: '$/log', params: { level: 'info', message: 'héllo wörld' } });
    const midBody = bytes.indexOf('héllo') + 2; // inside the two-byte é
    fromServer.write(bytes.subarray(0, 7));
    fromServer.write(bytes.subarray(7, midBody));
    fromServer.write(bytes.subarray(midBody));
    await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce());
    expect(handler).toHaveBeenCalledWith({ level: 'info', message: 'héllo wörld' });
  });

  it('resolves concurrent requests answered out of order to their own ids', async () => {
    const a = connection.request('a');
    const b = connection.request('b');
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    const [first, second] = sent;
    expect(first.id).not.toBe(second.id);
    fromServer.write(frame({ id: second.id, result: 'B' }));
    fromServer.write(frame({ id: first.id, result: 'A' }));
    await expect(a).resolves.toBe('A');
    await expect(b).resolves.toBe('B');
  });

  it('rejects with ResponseError on an error response', async () => {
    const request = connection.request('initialize', { roots: ['/nope'] });
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    fromServer.write(frame({ id: sent[0].id, error: { code: -32001, message: 'InvalidRoots', data: '/nope' } }));
    const err = await request.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ResponseError);
    expect(err).toMatchObject({ code: -32001, message: 'InvalidRoots', data: '/nope' });
  });

  it('rejects pending requests with ConnectionClosedError when the stream ends', async () => {
    const request = connection.request('initialize');
    fromServer.end();
    await expect(request).rejects.toBeInstanceOf(ConnectionClosedError);
  });
});
