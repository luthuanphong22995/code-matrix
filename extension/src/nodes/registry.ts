// The shell-owned node registry: the only way node data enters the extension. Features (code-graph)
// register nodes here before posting payloads that reference their ids; the shell never calls graph/*.

export interface NodeRecord {
  id: string;
  kind: string;
  name: string;
  // Absolute file path.
  path: string;
  // 0-based, as in the VS Code API.
  range: { startLine: number; startCol: number; endLine: number; endCol: number };
}

// get / delete / clear are the plain Map methods.
export class NodeRegistry extends Map<string, NodeRecord> {
  register(records: Iterable<NodeRecord>): void {
    for (const r of records) this.set(r.id, r);
  }
}

// One registry per extension host, exposed as Shell.nodes.
export const nodes = new NodeRegistry();
