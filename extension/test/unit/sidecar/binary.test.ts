import { afterEach, describe, expect, it } from 'vitest';
import { resolveServerBinary, ServerBinaryMissingError } from '../../../src/sidecar/binary';

describe('resolveServerBinary', () => {
  afterEach(() => {
    delete process.env.CODE_MATRIX_SERVER_PATH;
  });

  it('throws the exact R11 message when the win32 binary is absent', () => {
    const call = () => resolveServerBinary('C:\\ext', 'win32', 'x64');
    expect(call).toThrow(ServerBinaryMissingError);
    expect(call).toThrow('Server binary not found for win32-x64: C:\\ext\\bin\\win32-x64\\code-matrix-server.exe');
  });

  it('returns CODE_MATRIX_SERVER_PATH when it points at an existing file', () => {
    process.env.CODE_MATRIX_SERVER_PATH = __filename;
    expect(resolveServerBinary('/ext', 'linux', 'x64')).toEqual({ path: __filename, platformKey: 'linux-x64' });
  });
});
