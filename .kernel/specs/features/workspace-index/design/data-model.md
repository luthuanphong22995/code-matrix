# Workspace Index — Data model

What the `index` store holds beyond the graph nodes and edges that `code-graph` defines
(`.kernel/specs/features/code-graph/design/data-model.md`). In memory only (R11).

```mermaid
erDiagram
    INDEX_RUN {
        int run_id PK "increments per sidecar session"
        string phase "scanning | indexing | complete | cancelled"
        int total "files found by the scan; 0 while scanning"
        int done "files finished: indexed + failed + skipped"
        int indexed
        int failed
        int skipped
        int duration_ms "set on complete or cancelled"
    }
    FILE_ENTRY {
        string path PK "workspace-relative, root-prefixed when several roots"
        string root "absolute root the file belongs to"
        string language "java | typescript | python | go"
        string status "indexed | failed | skipped"
        string reason "frontend error text for failed; 'file exceeds 1 MB' for skipped"
        int size_bytes
    }
    PENDING_CHANGE {
        string path
        string type "created | changed | deleted"
        int seq "arrival order"
    }
    INDEX_RUN ||--o{ FILE_ENTRY : "produces"
    INDEX_RUN ||--o{ PENDING_CHANGE : "queues while scanning or indexing"
    FILE_ENTRY ||--o| NODE : "file node (none when skipped)"
    NODE ||--o{ NODE : "symbols (none when failed)"
```

Notes:
- `FILE_ENTRY.status` is what the completion summary and the log lines are computed from (R6):
  `indexed` counts into `Indexed N files`; `failed` into `F failed`; `skipped` never into
  either.
- A `failed` entry has exactly one node, its `file` node, and no symbol nodes (R6). A `skipped`
  entry has no node at all; edges that would point into it are Unresolved (R13).
- A single-file re-index (R7) replaces one `FILE_ENTRY` and its nodes in place; node ids stay
  stable while path, kind and name are unchanged, which is what lets `code-graph` keep
  selection and expansion across the refresh.
- `PENDING_CHANGE` is drained in `seq` order at `complete` and dropped at `cancelled` (R8, R9).
- There is exactly one `INDEX_RUN` in `scanning` or `indexing` at any time (R10).

**Rules**: R2, R6, R7, R8, R9, R10, R11, R13
