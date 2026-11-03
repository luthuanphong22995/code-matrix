# Code Graph — API

Extends the shell's two interfaces (`.kernel/specs/features/app-shell/design/api.md`).

## 1. Sidecar JSON-RPC: `graph/*`

All require a successful `initialize`.

| Method | Params | Result | Errors |
|---|---|---|---|
| `graph/files` | none | `{ nodes: Node[], edges: Edge[] }` — every `file` node and every `imports` edge, plus unresolved import placeholders | `-32002 NotInitialized`; `-32010 NotIndexed` (no index yet) |
| `graph/expand` | `{ fileId: string }` | `{ nodes: Node[], edges: Edge[] }` — the file's `class`/`function` nodes, their `contains` edges, and all `calls`/`references` edges whose `from` is inside the file (targets may be nodes the client has not loaded; the client draws only edges with both ends visible) | `-32011 UnknownNode` |
| `graph/node` | `{ nodeId: string }` | `{ node: Node, inbound: Edge[], outbound: Edge[] }` — for the Details region counts | `-32011 UnknownNode` |

### Notifications (sidecar → extension)

| Method | Params | When |
|---|---|---|
| `graph/changed` | `{ removedNodeIds: string[] }` | after a re-index finishes; the client re-fetches `graph/files`, re-expands the files it had expanded, drops selection/focus if their node ids are in `removedNodeIds` (R11) |

Node and Edge are as in `data-model.md`.

## 2. Webview messages: `graph/*`

| Direction | `type` | Payload | Effect |
|---|---|---|---|
| ext → webview | `graph/files` | `{ nodes, edges }` | replace the file layer |
| ext → webview | `graph/expanded` | `{ fileId, nodes, edges }` | add the file's symbols |
| ext → webview | `graph/nodeDetails` | `{ node, inbound, outbound }` | fill Details region |
| ext → webview | `graph/empty` | none | show `No supported source files found` |
| webview → ext | `graph/expand` | `{ fileId }` | handle or `Expand` button clicked |
| webview → ext | `graph/collapse` | `{ fileId }` | client-side only in effect, but reported so the extension can remember expansion for refresh |
| webview → ext | `graph/details` | `{ nodeId }` | after `shell/selectNode`, request counts |

Search, path glob, kind toggles, focus and the 2,000-node cap are evaluated inside the webview
over the nodes it holds; they send nothing to the sidecar.
