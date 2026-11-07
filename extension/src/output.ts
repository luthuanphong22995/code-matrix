import * as vscode from 'vscode';

let channel: vscode.OutputChannel | undefined;

export function getOutputChannel(): vscode.OutputChannel {
  return (channel ??= vscode.window.createOutputChannel('Code Matrix'));
}
