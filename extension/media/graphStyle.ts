import type { NodeSingular, StylesheetJson } from 'cytoscape';

// The canvas stylesheet (design/ui.md § Canvas). `colour(name)` reads a `--vscode-*` variable; no other colours.
export function graphStyle(colour: (name: string) => string): StylesheetJson {
  const fg = colour('--vscode-foreground');
  const muted = colour('--vscode-descriptionForeground');
  return [
    {
      selector: 'node',
      style: {
        label: 'data(label)',
        color: fg,
        'font-family': colour('--vscode-font-family'),
        'font-size': 11,
        'text-valign': 'center',
        'text-halign': 'center',
        'text-wrap': 'wrap',
        // ponytail: label width estimated from its longest line, measure text if labels look clipped.
        width: (n: NodeSingular) => Math.max(...String(n.data('label')).split('\n').map((l) => l.length)) * 7 + 16,
        height: (n: NodeSingular) => String(n.data('label')).split('\n').length * 14 + 10,
        'background-color': colour('--vscode-editor-background'),
        'border-width': 1,
        'border-color': fg,
        shape: 'rectangle',
      },
    },
    { selector: 'node.file', style: { 'background-color': colour('--vscode-sideBar-background') } },
    // Cytoscape has no single-side border: the class's double left border is a double border.
    { selector: 'node.class', style: { 'border-style': 'double', 'border-width': 3 } },
    { selector: 'node.function', style: { shape: 'round-rectangle' } },
    { selector: 'node.unresolved', style: { 'border-style': 'dashed', color: muted, 'border-color': muted } },
    { selector: 'node.selected', style: { 'outline-width': 2, 'outline-color': colour('--vscode-focusBorder') } },
    // Search matches (R6).
    { selector: 'node.search-halo', style: { 'underlay-color': muted, 'underlay-opacity': 0.4, 'underlay-padding': 6 } },
    {
      selector: 'edge',
      style: { width: 1, 'line-color': fg, 'target-arrow-color': fg, 'curve-style': 'bezier' },
    },
    { selector: 'edge.contains', style: { 'line-color': muted, width: 0.5 } },
    { selector: 'edge.calls', style: { 'target-arrow-shape': 'triangle' } },
    { selector: 'edge.references', style: { 'line-style': 'dotted', 'target-arrow-shape': 'triangle' } },
    { selector: 'edge.unresolved', style: { 'line-style': 'dashed' } },
    // Data-flow: the traced function as a container of CFG blocks (data-flow ui.md § unfolded function).
    { selector: 'node.block', style: { shape: 'rectangle', 'text-halign': 'center', 'text-valign': 'center' } },
    { selector: 'node:parent', style: { shape: 'round-rectangle', 'text-valign': 'top', 'text-halign': 'center', padding: '12px' } },
    // Group by folder: a box around a directory's nodes.
    { selector: 'node.folder', style: { 'border-style': 'dashed', 'border-color': muted, color: muted, 'background-opacity': 0, shape: 'rectangle' } },
    { selector: 'node.trace', style: { 'background-color': muted, 'background-opacity': 0.35 } },
    { selector: 'node.current', style: { 'border-width': 2, 'border-color': fg } },
    { selector: 'edge.branch', style: { width: 1, 'line-color': muted, 'target-arrow-color': muted, 'target-arrow-shape': 'triangle' } },
    {
      selector: 'edge.hop',
      style: {
        width: 3,
        'line-color': fg,
        'target-arrow-color': fg,
        'target-arrow-shape': 'triangle',
        label: 'data(label)',
        color: fg,
        'font-family': colour('--vscode-editor-font-family'),
        'font-size': 11,
        'text-background-color': colour('--vscode-editor-background'),
        'text-background-opacity': 1,
        'loop-direction': '-45deg',
        'loop-sweep': '-90deg',
        'control-point-step-size': 60,
      },
    },
    // Narrowed out: kept in Cytoscape so its position survives.
    { selector: '.hidden', style: { display: 'none' } },
  ];
}
