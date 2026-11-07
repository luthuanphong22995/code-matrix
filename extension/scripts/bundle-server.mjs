#!/usr/bin/env node
// Builds code-matrix-server with cargo and places it at bin/<host-key>/ (the layout resolveServerBinary reads).
// --package additionally runs `vsce package --target <host-key>` and checks the binary made it in.
// Native only: --target must equal the host key. Node stdlib, no config.
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const extensionDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoDir = path.resolve(extensionDir, '..');
const coreDir = path.join(repoDir, 'core');

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const flag = (name) => args.includes(name);

const win = process.platform === 'win32';
const hostKey = `${process.platform}-${process.arch}`;
const target = opt('--target', hostKey);
const profile = opt('--profile', 'dev');
const exe = win ? 'code-matrix-server.exe' : 'code-matrix-server';

function fail(message) {
  console.error(`bundle-server: ${message}`);
  process.exit(1);
}

function run(command, commandArgs, cwd) {
  const result = spawnSync(command, commandArgs, { cwd, stdio: 'inherit', shell: win });
  if (result.status !== 0) fail(`${command} ${commandArgs.join(' ')} failed (${result.status ?? result.signal})`);
}

if (target !== hostKey) fail(`cannot package ${target} on ${hostKey}: native runners only`);

if (!flag('--no-build')) run('cargo', ['build', '-p', 'server', '--profile', profile], coreDir);
const built = path.join(coreDir, 'target', profile === 'dev' ? 'debug' : profile, exe);
if (!fs.existsSync(built)) fail(`cargo output missing: ${built}`);

const binDir = path.join(extensionDir, 'bin');
fs.mkdirSync(binDir, { recursive: true });
for (const entry of fs.readdirSync(binDir)) {
  if (entry !== hostKey) fs.rmSync(path.join(binDir, entry), { recursive: true, force: true });
}
const dest = path.join(binDir, hostKey, exe);
fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.copyFileSync(built, dest);
if (!win) fs.chmodSync(dest, 0o755);
console.log(`bundle-server: ${path.relative(repoDir, built)} -> ${path.relative(repoDir, dest)}`);

if (flag('--package')) {
  for (const file of ['README.md', 'LICENSE']) fs.copyFileSync(path.join(repoDir, file), path.join(extensionDir, file));
  const { version } = JSON.parse(fs.readFileSync(path.join(extensionDir, 'package.json'), 'utf8'));
  const out = `code-matrix-${version}-${hostKey}.vsix`;
  const vsceArgs = ['vsce', 'package', '--no-dependencies', '--allow-missing-repository', '--target', hostKey, '--out', out];
  run('npx', vsceArgs, extensionDir);

  const listed = execFileSync('npx', ['vsce', 'ls', '--no-dependencies'], { cwd: extensionDir, encoding: 'utf8', shell: win })
    .split(/\r?\n/)
    .map((line) => line.trim());
  for (const required of [`bin/${hostKey}/${exe}`, 'dist/extension.js']) {
    if (!listed.includes(required)) fail(`${required} missing from the package listing:\n${listed.join('\n')}`);
  }
  console.log(`bundle-server: packaged ${out}`);
}
