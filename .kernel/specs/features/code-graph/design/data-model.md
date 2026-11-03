# Code Graph — Data model

The slice of the IR the webview receives. Defined once in Rust; this is the shape, not the
crate layout.

```mermaid
erDiagram
    NODE {
        string id PK "stable across re-index while path+kind+name unchanged"
        string kind "file | class | function | unresolved"
        string name "display name; for file the workspace-relative path; for unresolved the raw name"
        string path "workspace-relative file path; absent for unresolved"
        int start_line "1-based; absent for unresolved"
        int end_line
        string parent_id FK "containing node id; absent for file and unresolved"
    }
    EDGE {
        string id PK
        string kind "contains | imports | calls | references"
        string from_id FK
        string to_id FK
        bool resolved "false when to_id is an unresolved placeholder"
    }
    NODE ||--o{ EDGE : "from"
    NODE ||--o{ EDGE : "to"
    NODE ||--o{ NODE : "contains (parent_id)"
```

Notes:
- A file's symbols are only sent on expansion (`graph/expand`), so a collapsed file's
  `contains` children are not in the webview's memory.
- Edge `kind` on an unresolved edge is still `calls` or `references`; `resolved: false` is what
  makes it dashed and what the Details region counts as `unresolved`.
- Node `id` stability is what lets expansion, selection and focus survive a refresh (R11).

**Rules**: R3, R4, R11
