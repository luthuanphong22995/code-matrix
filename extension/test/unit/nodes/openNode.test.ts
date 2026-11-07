import { beforeEach, describe, expect, it, vi } from 'vitest';
import { nodeLocation, openNodeInEditor } from '../../../src/nodes/openNode';
import type { NodeRecord } from '../../../src/nodes/registry';
import { Range, TextEditorRevealType, ViewColumn, window, workspace } from '../mocks/vscode';

const node = (path: string): NodeRecord => ({
  id: 'parseConfig',
  kind: 'function',
  name: 'parseConfig',
  path,
  range: { startLine: 11, startCol: 0, endLine: 39, endCol: 1 },
});

describe('openNodeInEditor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    workspace.root = '/proj';
  });

  it('opens an existing file beside the graph, cursor at the start, range centred (R8)', async () => {
    await openNodeInEditor(node(__filename));
    expect(workspace.openTextDocument).toHaveBeenCalledOnce();
    expect(workspace.openTextDocument.mock.calls[0][0].fsPath).toBe(__filename);
    expect(window.showTextDocument).toHaveBeenCalledWith(expect.anything(), {
      viewColumn: ViewColumn.Beside,
      preserveFocus: false,
      selection: new Range(11, 0, 11, 0),
    });
    const editor = await window.showTextDocument.mock.results[0].value;
    expect(editor.revealRange).toHaveBeenCalledWith(new Range(11, 0, 39, 1), TextEditorRevealType.InCenter);
  });

  it('a missing file warns with the relative path and opens nothing (R9)', async () => {
    await openNodeInEditor(node('/proj/src/old.go'));
    expect(window.showWarningMessage).toHaveBeenCalledWith('File not found: src/old.go');
    expect(workspace.openTextDocument).not.toHaveBeenCalled();
    expect(window.showTextDocument).not.toHaveBeenCalled();
  });
});

describe('nodeLocation', () => {
  it('is the workspace-relative path and the 1-based start line', () => {
    workspace.root = '/proj';
    expect(nodeLocation(node('/proj/src/config.go'))).toBe('src/config.go:12');
  });
});
