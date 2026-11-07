import { promises as fs } from 'node:fs';
import * as vscode from 'vscode';
import type { NodeRecord } from './registry';

// Workspace-relative path and 1-based start line, e.g. `src/config.go:12`.
export function nodeLocation(record: NodeRecord): string {
  return `${vscode.workspace.asRelativePath(record.path)}:${record.range.startLine + 1}`;
}

// Opens the node's file beside the graph, cursor at the range start, whole range centred (R8).
// A missing file only warns: no editor opens and the selection is untouched (R9).
export async function openNodeInEditor(record: NodeRecord): Promise<void> {
  try {
    await fs.stat(record.path);
  } catch {
    void vscode.window.showWarningMessage(`File not found: ${vscode.workspace.asRelativePath(record.path)}`);
    return;
  }
  const { startLine, startCol, endLine, endCol } = record.range;
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(record.path));
  const editor = await vscode.window.showTextDocument(doc, {
    viewColumn: vscode.ViewColumn.Beside,
    preserveFocus: false,
    selection: new vscode.Range(startLine, startCol, startLine, startCol),
  });
  editor.revealRange(new vscode.Range(startLine, startCol, endLine, endCol), vscode.TextEditorRevealType.InCenter);
}
