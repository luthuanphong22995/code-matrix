import * as path from 'node:path';
import * as vscode from 'vscode';
import { InvalidGlob, globToRegExp } from '../../media/glob';
import type { SidecarManager } from '../sidecar/manager';
import { INDEX_FILES_CHANGED } from '../sidecar/protocol';
import type { FileChange, FileChangeType, IndexFilesChangedParams } from '../sidecar/protocol';
import { excludeGlobs } from './controller';

// Only the supported languages' files ever reach the extension, so `README.md` triggers nothing.
export const WATCH_GLOB = '**/*.{java,ts,tsx,js,jsx,py,go}';
const BATCH_MS = 100;

// Whether a root-relative `/`-separated path, or one of its ancestor directories, matches a glob; an invalid
// glob is skipped.
export function isExcluded(rel: string, globs: string[]): boolean {
  const parts = rel.split('/');
  const prefixes = parts.map((_, i) => parts.slice(0, i + 1).join('/'));
  return globs.some((glob) => {
    let re: RegExp;
    try {
      re = globToRegExp(glob);
    } catch (err) {
      if (err instanceof InvalidGlob) return false;
      throw err;
    }
    return prefixes.some((p) => re.test(p));
  });
}

// While the sidecar is ready or indexing, watches every workspace root and sends created / changed / deleted
// files as at most one `index/filesChanged` per 100 ms, in arrival order. It never starts a full run.
export class IndexWatcher {
  private watchers: vscode.FileSystemWatcher[] = [];
  private batch: FileChange[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly subs: Array<{ dispose(): void }>;

  constructor(private readonly manager: SidecarManager) {
    this.subs = [
      manager.onDidChangeState(({ kind }) => {
        if (kind !== 'ready' && kind !== 'indexing') this.clear();
        else if (this.watchers.length === 0) this.create();
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        if (this.watchers.length === 0) return;
        this.clear();
        this.create();
      }),
    ];
  }

  dispose(): void {
    this.clear();
    for (const s of this.subs) s.dispose();
  }

  private create(): void {
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, WATCH_GLOB));
      watcher.onDidCreate((uri) => this.push(folder, uri, 'created'));
      watcher.onDidChange((uri) => this.push(folder, uri, 'changed'));
      watcher.onDidDelete((uri) => this.push(folder, uri, 'deleted'));
      this.watchers.push(watcher);
    }
  }

  private clear(): void {
    for (const w of this.watchers) w.dispose();
    this.watchers = [];
    this.batch = [];
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  private push(folder: vscode.WorkspaceFolder, uri: vscode.Uri, type: FileChangeType): void {
    const rel = path.relative(folder.uri.fsPath, uri.fsPath).split(path.sep).join('/');
    // ponytail: files.exclude is re-read and re-compiled per event; compile once and listen to
    // onDidChangeConfiguration if event storms show it.
    const globs = excludeGlobs(vscode.workspace.getConfiguration('files').get<Record<string, unknown>>('exclude'));
    if (isExcluded(rel, globs)) return;
    this.batch.push({ path: uri.fsPath, type });
    this.timer ??= setTimeout(() => this.flush(), BATCH_MS);
  }

  // ponytail: deleting or renaming a whole directory reports nothing for the files inside it (the glob only
  // matches files), so their nodes linger until the next full run. Upgrade: a second `**/*` watcher for deletes
  // only, sending the directory path — the sidecar already re-syncs a directory's subtree.
  private flush(): void {
    const changes = this.batch;
    this.batch = [];
    this.timer = undefined;
    if (changes.length === 0) return;
    const params: IndexFilesChangedParams = { changes };
    this.manager.connection?.notify(INDEX_FILES_CHANGED, params);
  }
}
