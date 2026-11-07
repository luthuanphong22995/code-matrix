// Hand mirror of `core/crates/rpc/src/protocol.rs` (design/api.md § 1); 02's serde fixtures are the contract.

export const INITIALIZE = 'initialize';
export const SHUTDOWN = 'shutdown';
export const STATUS = '$/status';
export const LOG = '$/log';

export const INVALID_ROOTS = -32001;
export const NOT_INITIALIZED = -32002;

export interface InitializeParams {
  roots: string[];
}

export interface InitializeResult {
  serverVersion: string;
  languages: string[];
}

export type ServerState = 'ready' | 'indexing';

export interface StatusParams {
  state: ServerState;
  detail?: string;
}

export type LogLevel = 'info' | 'warn' | 'error';

export interface LogParams {
  level: LogLevel;
  message: string;
}

// graph/* (code-graph), mirroring `rpc/src/protocol.rs` and `export/src/view.rs`.
export const GRAPH_FILES = 'graph/files';
export const GRAPH_EXPAND = 'graph/expand';
export const GRAPH_NODE = 'graph/node';
export const GRAPH_NEIGHBOURHOOD = 'graph/neighbourhood';
export const GRAPH_CHANGED = 'graph/changed';

export const NOT_INDEXED = -32010;
export const UNKNOWN_NODE = -32011;

export type GraphNodeKind = 'file' | 'class' | 'function' | 'unresolved';
export type GraphEdgeKind = 'contains' | 'imports' | 'calls' | 'references';

// Optional fields are omitted on the wire. Lines are 1-based inclusive; file nodes carry none, placeholders no path.
export interface GraphNode {
  id: string;
  kind: GraphNodeKind;
  name: string;
  path?: string;
  startLine?: number;
  endLine?: number;
  parentId?: string;
}

export interface GraphEdge {
  id: string;
  kind: GraphEdgeKind;
  fromId: string;
  toId: string;
  resolved: boolean;
}

export interface GraphSlice {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

// graph/files: the file layer plus the whole graph's node count, every kind (code-graph R13).
export interface GraphFiles extends GraphSlice {
  total: number;
}

export interface GraphNodeDetail {
  node: GraphNode;
  inbound: GraphEdge[];
  outbound: GraphEdge[];
  /** Far ends of the non-`contains` edges, once each, by id. */
  linked?: GraphNode[];
}

export interface GraphExpandParams {
  fileId: string;
}

export interface GraphNeighbourhoodParams {
  nodeId: string;
  hops: number;
}

export interface GraphNodeParams {
  nodeId: string;
}

export interface GraphChangedParams {
  removedNodeIds: string[];
}

// index/* (workspace-index), mirroring `rpc/src/protocol.rs`.
export const INDEX_RUN = 'index/run';
export const INDEX_CANCEL = 'index/cancel';
export const INDEX_PROGRESS = 'index/progress';
export const INDEX_DONE = 'index/done';
export const INDEX_FILES_CHANGED = 'index/filesChanged';

export type FileChangeType = 'created' | 'changed' | 'deleted';

// `path` is absolute; the sidecar re-syncs it with disk whatever `type` says.
export interface FileChange {
  path: string;
  type: FileChangeType;
}

export interface IndexFilesChangedParams {
  changes: FileChange[];
}

export interface IndexRunParams {
  roots: string[];
  exclude: string[];
}

export interface IndexRunResult {
  runId: number;
}

export interface IndexCancelParams {
  runId: number;
}

export interface IndexCancelResult {
  cancelled: boolean;
}

export interface IndexProgressParams {
  runId: number;
  phase: 'scanning' | 'indexing';
  done: number;
  total: number;
}

export interface IndexDoneParams {
  runId: number;
  outcome: 'complete' | 'cancelled';
  indexed: number;
  failed: number;
  skipped: number;
  durationMs: number;
}

// flow/* (data-flow), mirroring `rpc/src/protocol.rs` and `ir/src/flow.rs`'s `Trace` (plus `functionId`).
export const FLOW_TRACE = 'flow/trace';
export const FLOW_RETRACE = 'flow/retrace';

export interface TraceBlock {
  id: string;
  kind: 'entry' | 'exit' | 'basic';
  // 1-based; omitted for entry and exit.
  startLine?: number;
  endLine?: number;
  firstLine: string;
}

export interface TraceBranch {
  from: string;
  to: string;
  backEdge: boolean;
}

// `line` is 1-based, characters 0-based UTF-16. A capture counts as a use.
export interface TraceOccurrence {
  ordinal: number;
  role: 'def' | 'use';
  block: string;
  line: number;
  startChar: number;
  endChar: number;
  capture: boolean;
}

// `index` is 1-based.
export interface TraceHop {
  index: number;
  defOrdinal: number;
  useOrdinal: number;
}

export interface Trace {
  functionId: string;
  functionName: string;
  variable: string;
  variableKey: string;
  status: 'hops' | 'noUses' | 'noReachingDef';
  blocks: TraceBlock[];
  branches: TraceBranch[];
  occurrences: TraceOccurrence[];
  hops: TraceHop[];
}

// Absolute path, 0-based line and UTF-16 character.
export interface FlowTraceParams {
  path: string;
  line: number;
  character: number;
}

export type FlowTraceResult =
  | { kind: 'trace'; trace: Trace }
  | { kind: 'unsupportedLanguage'; language: string | null }
  | { kind: 'fileNotIndexed'; file: string }
  | { kind: 'fileFailed'; file: string }
  | { kind: 'noIdentifier' }
  | { kind: 'notInFunction'; name: string }
  | { kind: 'notLocal'; name: string; function: string };

export interface FlowRetraceParams {
  functionId: string;
  variableKey: string;
}

export type FlowRetraceResult =
  | { kind: 'trace'; trace: Trace }
  | { kind: 'functionGone'; function: string | null }
  | { kind: 'variableGone'; variable: string; function: string };
