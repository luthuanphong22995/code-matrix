#!/usr/bin/env node
// Crash-on-demand stand-in for code-matrix-server (recovery integration suite).
// LSP-framed stdio; answers `initialize` and `shutdown` (then exits 0). Every 100 ms, if the file named by
// FAKE_SERVER_CRASHES holds N > 0, rewrites it to N-1 and exits 101 — so "crash now" is writing 1 and
// "crash this one and the next spawn" is writing 2.
'use strict';
const fs = require('node:fs');

process.stderr.write('fake-server: started\n');

const send = (message) => {
  const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...message }), 'utf8');
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
};

let buffer = Buffer.alloc(0);
process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const headerEnd = buffer.indexOf('\r\n\r\n');
    if (headerEnd < 0) return;
    const length = Number(/Content-Length: (\d+)/i.exec(buffer.toString('ascii', 0, headerEnd))[1]);
    const end = headerEnd + 4 + length;
    if (buffer.length < end) return;
    const message = JSON.parse(buffer.toString('utf8', headerEnd + 4, end));
    buffer = buffer.subarray(end);
    if (message.method === 'initialize') {
      send({ id: message.id, result: { serverVersion: '0.0.0-fake', languages: [] } });
    } else if (message.method === 'shutdown') {
      send({ id: message.id, result: null });
      process.stdout.end(() => process.exit(0));
    }
  }
});
process.stdin.on('end', () => process.exit(1));

const crashFile = process.env.FAKE_SERVER_CRASHES;
if (crashFile) {
  const timer = setInterval(() => {
    let n = 0;
    try {
      n = Number(fs.readFileSync(crashFile, 'utf8').trim()) || 0;
    } catch {
      return;
    }
    if (n > 0) {
      clearInterval(timer);
      fs.writeFileSync(crashFile, String(n - 1));
      // Exit after the flush: pipe writes are async on macOS.
      process.stderr.write('fake-server: crashing\n', () => process.exit(101));
    }
  }, 100);
}
