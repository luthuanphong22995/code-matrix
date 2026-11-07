import type { Trace } from '../../../src/sidecar/protocol';

// `total` in parseConfig, shaped like core/crates/frontend-go/tests/fixtures/flow/config.go's lowering: blocks
// entry, 12, 13 (loop head), 14, 16–17, 18, 20–21, exit; defs at 12 and 14, uses at 14 and 18; hops 12→14, 14→14,
// 12→18, 14→18.
export const FUNCTION_ID = 'fn:parseConfig';
export const parseConfig: Trace = {
  functionId: FUNCTION_ID,
  functionName: 'parseConfig',
  variable: 'total',
  variableKey: 'total#1',
  status: 'hops',
  blocks: [
    { id: 'b0', kind: 'entry', firstLine: '' },
    { id: 'b1', kind: 'basic', startLine: 12, endLine: 12, firstLine: '\ttotal := 0' },
    { id: 'b2', kind: 'basic', startLine: 13, endLine: 13, firstLine: '\tfor _, n := range open(path) {' },
    { id: 'b3', kind: 'basic', startLine: 14, endLine: 14, firstLine: '\t\ttotal = total + n' },
    { id: 'b4', kind: 'basic', startLine: 16, endLine: 17, firstLine: '\tunused := defaultPath' },
    { id: 'b5', kind: 'basic', startLine: 18, endLine: 18, firstLine: '\t\treturn total' },
    { id: 'b6', kind: 'basic', startLine: 20, endLine: 21, firstLine: '\tlog(path)' },
    { id: 'b7', kind: 'exit', firstLine: '' },
  ],
  branches: [
    ['b0', 'b1'],
    ['b1', 'b2'],
    ['b2', 'b3'],
    ['b3', 'b2'],
    ['b2', 'b4'],
    ['b4', 'b5'],
    ['b5', 'b7'],
    ['b4', 'b6'],
    ['b6', 'b7'],
  ].map(([from, to]) => ({ from, to, backEdge: from === 'b3' })),
  occurrences: [
    { ordinal: 0, role: 'def', block: 'b1', line: 12, startChar: 1, endChar: 6, capture: false },
    { ordinal: 1, role: 'use', block: 'b3', line: 14, startChar: 10, endChar: 15, capture: false },
    { ordinal: 2, role: 'def', block: 'b3', line: 14, startChar: 2, endChar: 7, capture: false },
    { ordinal: 3, role: 'use', block: 'b5', line: 18, startChar: 9, endChar: 14, capture: false },
  ],
  hops: [
    { index: 1, defOrdinal: 0, useOrdinal: 1 },
    { index: 2, defOrdinal: 2, useOrdinal: 1 },
    { index: 3, defOrdinal: 0, useOrdinal: 3 },
    { index: 4, defOrdinal: 2, useOrdinal: 3 },
  ],
};

export const noUses: Trace = { ...parseConfig, variable: 'unused', status: 'noUses', occurrences: [{ ...parseConfig.occurrences[0], block: 'b4', line: 16 }], hops: [] };
export const noReachingDef: Trace = { ...parseConfig, variable: 'n', status: 'noReachingDef', occurrences: [parseConfig.occurrences[1]], hops: [] };
