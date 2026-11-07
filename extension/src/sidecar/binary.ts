import * as fs from 'node:fs';
import * as path from 'node:path';

export class ServerBinaryMissingError extends Error {
  constructor(platformKey: string, binaryPath: string) {
    super(`Server binary not found for ${platformKey}: ${binaryPath}`);
    this.name = 'ServerBinaryMissingError';
  }
}

export function resolveServerBinary(
  extensionPath: string,
  platform: string,
  arch: string,
): { path: string; platformKey: string } {
  const platformKey = `${platform}-${arch}`;
  const win = platform === 'win32';
  const binaryPath =
    process.env.CODE_MATRIX_SERVER_PATH ||
    (win ? path.win32 : path).join(extensionPath, 'bin', platformKey, win ? 'code-matrix-server.exe' : 'code-matrix-server');
  if (!fs.existsSync(binaryPath)) throw new ServerBinaryMissingError(platformKey, binaryPath);
  return { path: binaryPath, platformKey };
}
