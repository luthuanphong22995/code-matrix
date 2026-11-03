# code-matrix — Overview

Project-level context the code can't tell you. Keep it to the irreducible: the
capability index, ownership, and tech stack are **live** — query them with
`sdlc caps list` / `sdlc caps owner`, don't restate them here.

## Purpose
code-matrix is a VS Code extension that analyzes the open workspace's source
code across languages and shows it as an interactive graph: files, classes,
functions, calls, imports. On top of that structural graph it computes real
intra-procedural data flow (CFG + def-use inside one function) so a user can
pick a variable or parameter and watch its flow stepped through on the graph.
It exists because existing tools either parse without understanding (syntax
only), understand only one language, or are too heavy (JVM code-property-graph
engines) to live inside an editor.

## Conventions
- Core is a Rust 2021 cargo workspace; `cargo clippy` clean; no `unsafe` outside FFI (tree-sitter grammar bindings).
- Parsing is tree-sitter only; one crate per language frontend, all implementing the same frontend trait.
- Extension is TypeScript with minimal npm deps; it owns UI only — no analysis logic in TS.
- Extension and core talk JSON-RPC over stdio (rust-analyzer pattern); every request/response type is defined once in Rust and serialized with serde.
- Tests: `cargo test` against fixture repos per language under `fixtures/<lang>/`; graph output is snapshot-tested. New frontend = new fixture repo + snapshots.
- Name resolution is best-effort per language; unresolved references are kept as `Unresolved` edges, never dropped silently.
- <TBD: supported VS Code minimum version>
- <TBD: binary distribution — bundled per platform in the .vsix vs downloaded on first run>

## Architecture
Style: **sidecar + per-language frontends** (plugin-style core behind a
thin editor shell). Provisional starting shape.

Big pieces:
- `extension/` (TypeScript) — VS Code commands, graph webview (Cytoscape.js or Sigma.js — <TBD: pick after first graph renders>), jump-to-source, progress/status. Spawns and talks to the sidecar.
- `core/` (Rust cargo workspace), binary `code-matrix-server`:
  - `rpc` — JSON-RPC over stdio; request/response types.
  - `frontend/<lang>` — one crate each (first set: `java`, `typescript` (also JS), `python`, `go`): tree-sitter grammar + queries, symbol extraction, per-language CFG and def-use construction. All implement the `Frontend` trait from `ir`.
  - `ir` — language-agnostic graph model: symbols, scopes, call/import edges, per-function CFG, def-use chains. The only type the analysis and export layers know.
  - `analysis` — reachability, intra-procedural data flow queries over `ir`. No language knowledge.
  - `index` — workspace walk, file-change tracking, in-memory graph store (<TBD: on-disk cache format>).
  - `export` — graph serialization for the webview (JSON), plus DOT/GraphML for external tools.

Allowed dependency edges:

```
extension   -> rpc (protocol only, over stdio)        (never reverse)
rpc         -> index, analysis, export
index       -> frontend/*, ir
frontend/*  -> ir, tree-sitter                        (frontends never depend on each other)
analysis    -> ir
export      -> ir
ir          -> (nothing project-internal)
```

Rule: anything language-specific lives in exactly one `frontend/<lang>`
crate; `ir`, `analysis`, `export` must compile with zero frontends present.

## Glossary
- **Frontend**: a per-language crate that turns tree-sitter output into `ir`. Parsing + symbol extraction + CFG + def-use for one language.
- **IR**: the language-agnostic intermediate graph all frontends emit; the single model the UI, analysis and export consume.
- **Structural graph**: nodes for files, classes, functions, variables; edges for contains, calls, imports, references. What the code-graph view shows.
- **CFG**: control-flow graph of one function: basic blocks and branch edges.
- **Def-use chain**: links from where a variable is assigned (def) to where it is read (use) inside one function. The unit of "data flow".
- **Intra-procedural**: within a single function. Flow does not cross call boundaries (that would be inter-procedural, out of scope for now).
- **Flow trace**: the ordered path of defs and uses for one chosen variable, which the data-flow feature animates on the graph.
- **Sidecar**: the Rust server process the extension spawns; all analysis happens there.
- **Unresolved edge**: a reference the frontend could not bind to a definition; kept in the graph and shown distinctly rather than dropped.
