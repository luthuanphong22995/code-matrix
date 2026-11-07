import * as path from 'node:path';
import { glob } from 'glob';
import Mocha from 'mocha';

// Which test files each VS Code launch (runTest.ts) loads; order matters within a suite.
const SUITES: Record<string, string[]> = {
  folder: ['activate.test.js', 'openGraph.test.js', 'bundledBinary.test.js', 'recovery.test.js', 'jumpToSource.test.js'],
  noFolder: ['noFolder.test.js'],
  multiRoot: ['multiRoot.test.js'],
  goFixture: ['canvas.test.js', 'narrowing.test.js', 'tree.test.js', 'scopedView.test.js'],
  empty: ['emptyCanvas.test.js'],
  large: ['tooLarge.test.js'],
  refresh: ['refresh.test.js'],
  reindex: ['reindex.test.js'],
  watch: ['watch.test.js'],
  flow: ['flow.test.js'],
};

export async function run(): Promise<void> {
  const mocha = new Mocha({ ui: 'tdd', color: true, timeout: 20_000 });
  const suite = process.env.CM_SUITE;
  const files = suite ? SUITES[suite] : await glob('**/*.test.js', { cwd: __dirname });
  if (!files) throw new Error(`unknown CM_SUITE: ${suite}`);
  for (const f of files) mocha.addFile(path.resolve(__dirname, f));

  await new Promise<void>((resolve, reject) => {
    mocha.run((failures) =>
      failures > 0 ? reject(new Error(`${failures} integration tests failed`)) : resolve(),
    );
  });
}
