import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

const configs = [
  {
    entryPoints: ['src/extension.ts'],
    outfile: 'dist/extension.js',
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node20',
    external: ['vscode'],
    sourcemap: true,
  },
  {
    entryPoints: ['media/main.ts'],
    outfile: 'dist/webview.js',
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    sourcemap: true,
  },
];

if (watch) {
  for (const config of configs) {
    await (await esbuild.context(config)).watch();
  }
} else {
  await Promise.all(configs.map((config) => esbuild.build(config)));
}
