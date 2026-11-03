---
title: Graph RPC — export projection, graph/files, graph/expand, graph/node, graph/changed
type: epic-change
epic: code-graph
status: planned
depends-on: [ir-graph-model, sidecar-rpc-skeleton, frontend-go, frontend-typescript, frontend-python, frontend-java, workspace-index-core]
feature: code-graph
---

# graph-rpc

**As a** developer, **I want** the sidecar to serve the file layer, a file's expansion and a
node's detail over JSON-RPC, and to tell the extension when the graph changed **so that** the
panel can draw the workspace graph from one source of truth.

## Intent
Wires the core together: the binary registers the four frontends in the `FrontendRegistry`,
triggers a full run after `initialize` (publishing `$/status indexing` → `ready`,
`$/log` for each failure and skip, then `graph/changed`), and serves `graph/files`,
`graph/expand`, `graph/node` from the `IndexStore` through the `export` projection defined in
`code-graph/design/data-model.md`. This is `code-graph/design/api.md § 1` in full.

## Approach
- **`export` crate** (`ir → wire`): `view::Node { id, kind, name, path?, startLine?, endLine?, parentId? }`
  and `view::Edge { id, kind, fromId, toId, resolved }` with serde `camelCase`, matching the
  data-model table. Functions over `&ir::Graph`:
  - `files_layer(g) -> GraphSlice` — every `File` node, every `Imports` edge, and every
    `Unresolved` placeholder that is the target of an `Imports` edge (api.md: "plus unresolved
    import placeholders").
  - `expand(g, file_id) -> Result<GraphSlice, ExportError::UnknownNode>` — the file's subtree
    (classes, functions, nested), their `Contains` edges, and every `Calls`/`References` edge
    whose `from` is in that subtree, plus the `Unresolved` placeholders those edges target.
    A `file_id` that exists but is not a `File` is `UnknownNode` (the design lists only that
    error).
  - `node_detail(g, id) -> Result<NodeDetail { node, inbound, outbound }, UnknownNode>`.
  `GraphSlice { nodes, edges }` sorted by id so responses are deterministic for tests.
- **`rpc` additions**: `protocol.rs` gains `GraphFilesResult`, `GraphExpandParams/Result`,
  `GraphNodeParams/Result`, `GraphChangedParams { removedNodeIds }`, and error codes
  `NOT_INDEXED = -32010`, `UNKNOWN_NODE = -32011`. `handlers/graph.rs` maps the three methods
  onto `export` over `IndexStore::snapshot()`; `None` → `NotIndexed`.
- **Run trigger**: after the `initialize` response is written, spawn the full run on a
  worker thread with a `RunEvents` impl that sends `$/status { state: "indexing" }` on start,
  then on finish `$/log` one `warn` line per failed file (`<path>: <reason>`) and one `info`
  per skipped file, `IndexStore::publish`, `$/status { state: "ready", detail: "Indexed N files[, F failed]" }`,
  and `graph/changed { removedNodeIds }` (empty on the first run). Requests arriving during
  the run are served from the previous snapshot (or `NotIndexed` on the first run) — the
  dispatch loop is never blocked by indexing.
- **`main.rs`**: `FrontendRegistry::new(vec![GoFrontend, TypeScriptFrontend, PythonFrontend, JavaFrontend])`;
  `initialize` now returns `languages: registry.languages()` (`["go","typescript","python","java"]`).
- **Tests**: `rpc/tests/graph.rs` spawns the real binary against `fixtures/go`, performs
  `initialize`, waits for `$/status ready` and `graph/changed`, then asserts `graph/files`
  (three+ file nodes, imports edges, no function nodes), `graph/expand` on `config.go`
  (`parseConfig` with a `contains` edge, the `calls` edge from `main` is **not** here because
  its `from` is in `main.go`), `graph/expand` on `main.go` (the `main → parseConfig` calls
  edge and the `main → fetchData` unresolved edge + placeholder), `graph/node` on
  `parseConfig` (inbound calls 1), `graph/expand` on an unknown id (`-32011`), and
  `graph/files` before the run finishes on a fresh process (`-32010`).

## Design
- `.kernel/specs/features/code-graph/design/api.md § 1` — methods, params, results, errors, `graph/changed`.
- `.kernel/specs/features/code-graph/design/data-model.md` — wire `Node`/`Edge`.
- `.kernel/specs/features/app-shell/design/api.md § 1` — `$/status`, `$/log` wording.

## Code anchors
- `core/export/src/view.rs` — wire `Node`, `Edge`, `GraphSlice`, `NodeDetail`
- `core/export/src/lib.rs` — `files_layer`, `expand`, `node_detail`, `ExportError`
- `core/export/tests/projection.rs` — projection tests over a hand-built `ir::Graph`
- `core/rpc/src/protocol.rs` — graph params/results, `-32010`, `-32011`
- `core/rpc/src/handlers/graph.rs` — the three handlers
- `core/rpc/src/server.rs` — route `graph/*`, run trigger after `initialize`, `languages`
- `core/rpc/src/run_events.rs` — `RunEvents` → `$/status`, `$/log`, `graph/changed`
- `core/rpc/src/main.rs` — registry with the four frontends
- `core/rpc/tests/graph.rs` — end-to-end over `fixtures/go`
- `core/rpc/Cargo.toml`, `core/export/Cargo.toml` — deps on `index`, `export`, `ir`, the four frontend crates (rpc only)

## Capabilities
- Modifies: `core/rpc-transport` (routes `graph/*`, run trigger, `languages`)
- Creates: `core/graph-rpc` — the `graph/*` methods and `graph/changed`; `core/export` — IR → wire projection (`files_layer`, `expand`, `node_detail`).

## Invariants / constraints
- `graph/files` returns every `File` node and every `Imports` edge and nothing of kind class/function (code-graph R1).
- `graph/expand` returns a file's whole symbol subtree with `contains` edges and only those `calls`/`references` edges whose `from` lies in that subtree (api.md); the client decides visibility.
- An unresolved edge keeps its real kind (`calls`/`references`) and carries `resolved: false`; the placeholder node it targets is included in the slice that carries the edge (R4).
- Before the first run has published, every `graph/*` request is `-32010 NotIndexed`; an unknown or non-file id is `-32011 UnknownNode`.
- `graph/changed` is sent after every completed full run, after the `ready` status, with the ids `publish` reported removed.
- Indexing never blocks request dispatch.
- `export` depends only on `ir`; `rpc` is the only crate naming concrete frontends (OVERVIEW).

## Acceptance criteria
- [ ] `cargo test -p export` passes with projection tests over a hand-built graph covering each of the three functions and both error paths.
- [ ] `cargo test -p rpc` end-to-end over `fixtures/go` passes the assertions listed under Tests, including the notification order `$/status indexing`, `$/status ready`, `graph/changed`.
- [ ] `initialize` returns `languages` `["go","typescript","python","java"]`.
- [ ] Running the binary against `fixtures/typescript`, `fixtures/python` and `fixtures/java` in turn yields a non-empty `graph/files` for each (one smoke assertion per fixture).
- [ ] `cargo clippy --workspace --all-targets -- -D warnings` is clean.

## Plan
`/plan:change .kernel/specs/epics/code-graph/changes/10-graph-rpc.md` — plan reads this file
directly and derives the change name from it.
