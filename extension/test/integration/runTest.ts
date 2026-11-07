import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runTests } from '@vscode/test-electron';

async function main(): Promise<void> {
  // Compiled to out/test/integration/, so the extension root is three levels up.
  const extensionDevelopmentPath = path.resolve(__dirname, '../../..');
  const extensionTestsPath = path.resolve(__dirname, './suite/index');
  const fixtures = path.resolve(extensionDevelopmentPath, 'test/integration/fixtures');

  const serverPath = path.resolve(
    extensionDevelopmentPath,
    '../core/target/debug',
    process.platform === 'win32' ? 'code-matrix-server.exe' : 'code-matrix-server',
  );
  if (!fs.existsSync(serverPath)) {
    throw new Error(`code-matrix-server not built: ${serverPath} (run \`cargo build\` in core/ first)`);
  }

  const large = makeLargeWorkspace();
  // The refresh suite deletes a file, so it runs on a throwaway copy of fixtures/go.
  const refreshCopy = path.join(os.tmpdir(), `cm-refresh-${process.pid}`);
  fs.rmSync(refreshCopy, { recursive: true, force: true });
  fs.cpSync(path.resolve(extensionDevelopmentPath, '../fixtures/go'), refreshCopy, { recursive: true });
  // The reindex suite adds a folder: a .code-workspace window does that without reloading the extension host.
  const reindexWorkspace = path.join(os.tmpdir(), `cm-reindex-${process.pid}.code-workspace`);
  fs.writeFileSync(reindexWorkspace, JSON.stringify({ folders: [{ path: path.resolve(extensionDevelopmentPath, '../fixtures/go') }] }));
  // The watch suite edits files; realpath so watcher paths match the folder root on macOS (/var → /private/var).
  const watchCopy = path.join(fs.realpathSync(os.tmpdir()), `cm-watch-${process.pid}`);
  fs.rmSync(watchCopy, { recursive: true, force: true });
  fs.cpSync(path.resolve(extensionDevelopmentPath, '../fixtures/typescript'), watchCopy, { recursive: true });
  const suites: Array<[string, string | undefined]> = [
    ['folder', path.join(fixtures, 'workspace')],
    ['noFolder', undefined],
    ['multiRoot', path.join(fixtures, 'multi-root.code-workspace')],
    ['goFixture', path.resolve(extensionDevelopmentPath, '../fixtures/go')],
    ['empty', path.join(fixtures, 'workspace2')],
    ['large', large],
    ['refresh', refreshCopy],
    ['reindex', reindexWorkspace],
    ['watch', watchCopy],
    ['flow', path.join(fixtures, 'flow')],
  ];
  try {
    for (const [suite, target] of suites) {
      await runTests({
        version: '1.90.0',
        extensionDevelopmentPath,
        extensionTestsPath,
        extensionTestsEnv: { CODE_MATRIX_SERVER_PATH: serverPath, CM_SUITE: suite },
        // Short user-data dir: VS Code's IPC socket path must stay under macOS's 103-char limit in deep checkouts.
        launchArgs: [
          ...(target ? [target] : []),
          '--disable-extensions',
          `--user-data-dir=${path.join(os.tmpdir(), `cm-vscode-test-${suite}`)}`,
        ],
      });
    }
  } finally {
    fs.rmSync(large, { recursive: true, force: true });
    fs.rmSync(refreshCopy, { recursive: true, force: true });
    fs.rmSync(reindexWorkspace, { force: true });
    fs.rmSync(watchCopy, { recursive: true, force: true });
  }
}

// A 2,500-file Go workspace with no imports: 300 files under src/api, 2,200 under src/other (the too-large case).
function makeLargeWorkspace(): string {
  const root = path.join(os.tmpdir(), `cm-large-${process.pid}`);
  fs.rmSync(root, { recursive: true, force: true });
  for (const [dir, count, width] of [['src/api', 300, 3], ['src/other', 2200, 4]] as const) {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
    for (let i = 0; i < count; i++) fs.writeFileSync(path.join(root, dir, `f${String(i).padStart(width, '0')}.go`), 'package x\n');
  }
  fs.writeFileSync(path.join(root, 'go.mod'), 'module example.com/large\n');
  return root;
}

main().catch((err) => {
  console.error('Failed to run integration tests', err);
  process.exit(1);
});
