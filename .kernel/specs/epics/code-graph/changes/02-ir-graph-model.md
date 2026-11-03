---
title: IR graph model — nodes, edges, stable ids, unresolved placeholders, Frontend trait
type: epic-change
epic: code-graph
status: planned
depends-on: [project-init]
feature: code-graph
---

# ir-graph-model

**As a** frontend or analysis author, **I want** one language-agnostic graph model with stable
node ids and a single `Frontend` trait **so that** four frontends, the index, the export layer
and later the data-flow analysis all speak one type and never depend on each other.

## Intent
Fills the empty `core/ir` crate with the structural graph the whole system shares: node kinds
file / class / function / unresolved, edge kinds contains / imports / calls / references, ids
that survive re-indexing, placeholder nodes for references nothing resolved, and the trait a
per-language crate implements. This is the hub every later change reads against.

## Approach
- **Two-phase frontend contract.** Resolution is best-effort *per language* (OVERVIEW), but it
  needs to see every file of that language. So the trait is:
  - `extract(&self, path: &RelPath, source: &[u8]) -> Result<FileSymbols, FrontendError>` —
    per file, pure: the file node, its class/function definitions (with parent and line
    range), its import specifiers as raw strings, and its references as `RawRef { kind:
    Calls | References, from: local def index, target: RawName, span }`.
  - `resolve(&self, files: &[FileSymbols], table: &SymbolTable) -> Vec<Edge>` — given every
    extracted file of this language and the cross-file lookup `ir` provides, bind raw refs
    and raw imports to node ids; anything unbound becomes an edge with `resolved: false` to
    an unresolved placeholder.
  - `language(&self) -> &'static str` and `extensions(&self) -> &'static [&'static str]`.
  - Leave room for `data-flow`: no CFG/def-use here, but document in `frontend.rs` that a
    later optional method (e.g. `fn function_body(&self, ..) -> Option<Cfg>` with a default
    returning `None`) is the extension point, so adding it does not break existing frontends.
- **`Graph` store**: nodes and edges keyed by id, adjacency both directions, and a
  per-file ownership map (`file node id → every node and edge it contributes`) so a later
  single-file re-index can remove one file's contribution. Provide `remove_file`, `insert_file_symbols`,
  `insert_edges`, `node`, `outbound`, `inbound`, `files()`, `children(node)`.
- **Stable ids**: `NodeId` = hex of a 64-bit hash over `(kind, workspace-relative path,
  qualified name)`; for `Unresolved`, over `("unresolved", raw name)` — one placeholder per
  raw name workspace-wide. `EdgeId` = hash over `(kind, from, to)`. Deterministic across
  runs and platforms (use a fixed-seed hasher, not `DefaultHasher`).
- **`SymbolTable`**: built by the index from every `FileSymbols`; lookup by language +
  qualified name and by (path, name). Lives in `ir` so frontends can use it in `resolve`
  without depending on `index`.
- `serde` derives on the public types (the wire shape is projected in `export`, but
  snapshot tests serialize `FileSymbols` and `Graph`).

## Design
- `.kernel/specs/features/code-graph/design/data-model.md` — the Node/Edge shape this models; id stability note.
- `.kernel/specs/OVERVIEW.md § Architecture` — `ir` dependency rule and glossary (Structural graph, Unresolved edge).

## Code anchors
- `core/ir/src/lib.rs` — re-exports
- `core/ir/src/node.rs` — `Node`, `NodeKind { File, Class, Function, Unresolved }`, `LineRange`
- `core/ir/src/edge.rs` — `Edge`, `EdgeKind { Contains, Imports, Calls, References }`, `resolved`
- `core/ir/src/id.rs` — `NodeId`, `EdgeId`, `stable_hash`
- `core/ir/src/graph.rs` — `Graph`, per-file ownership, adjacency
- `core/ir/src/symbols.rs` — `FileSymbols`, `Def`, `RawRef`, `RawImport`, `SymbolTable`
- `core/ir/src/frontend.rs` — `Frontend` trait, `FrontendError`
- `core/ir/tests/graph.rs` — unit tests
- `core/ir/Cargo.toml` — `serde`, `serde_json` (dev), `thiserror`

## Capabilities
- Modifies: none
- Creates: `core/ir` — the language-agnostic structural graph and the `Frontend` contract.

## Invariants / constraints
- `core/ir` has no dependency on any frontend, on `tree-sitter`, or on any other project crate (OVERVIEW dependency rule).
- A `NodeId` is identical across two runs when `(kind, path, qualified name)` is identical, and differs when any of them differs (code-graph R11).
- An unresolved reference is never dropped: `resolve` output for a raw ref is always exactly one edge, resolved or not (code-graph R4; OVERVIEW convention).
- Exactly one `Unresolved` placeholder exists per raw name in a `Graph`.
- `Contains` edges are the only edges between a node and its `parent`; every non-file, non-unresolved node has a parent that is a file or a class or a function.
- Node kinds are exactly file, class, function, unresolved; edge kinds exactly contains, imports, calls, references (code-graph R3).
- `remove_file(f)` removes every node and edge that `f` contributed and nothing else; edges from other files into `f`'s nodes are returned so the index can re-resolve them.

## Acceptance criteria
- [ ] `cargo test -p ir` passes with tests for: id stability (same input → same id, changed path/name/kind → different id, deterministic across processes); one placeholder per raw name; `remove_file` leaves other files' nodes and returns dangling inbound edges; adjacency returns inbound/outbound by kind.
- [ ] A test-only `FakeFrontend` in `core/ir/tests/` implements the trait with two files calling each other and one unresolved call, and `resolve` yields two resolved `Calls` edges and one `resolved: false` edge to a placeholder.
- [ ] `cargo clippy -p ir --all-targets -- -D warnings` is clean; `cargo doc -p ir` documents the trait and the data-flow extension point.
- [ ] `ir`'s `Cargo.toml` lists no project-internal dependency.

## Plan
`/plan:change .kernel/specs/epics/code-graph/changes/02-ir-graph-model.md` — plan reads this file
directly and derives the change name from it.
