---
title: Go frontend — tree-sitter extraction, package-level resolution, fixture + snapshots
type: epic-change
epic: code-graph
status: planned
depends-on: [ir-graph-model]
feature: code-graph
---

# frontend-go

**As a** developer with a Go workspace, **I want** its files, types, functions, imports, calls
and type references extracted into the IR **so that** the graph shows how the Go code hangs
together and marks what it could not resolve.

## Intent
First frontend crate, `core/frontend/go`, implementing `ir::Frontend` for `.go` files with
tree-sitter. Also the fixture repo `fixtures/go/` whose shape mirrors the code-graph scenarios
(`main.go` importing `config.go` and `util.go`, `parseConfig`, an unresolved `fetchData`),
with snapshot tests over the extracted symbols and the resolved edges.

## Approach
- Crate `frontend-go` depends on `ir`, `tree-sitter` (workspace version) and `tree-sitter-go`.
  Grammar FFI is the only `unsafe` (`#![allow(unsafe_code)]` scoped to the binding module).
- Queries as `.scm` files embedded with `include_str!`: definitions (func, method,
  type_declaration for struct/interface), imports (`import_spec` paths), calls
  (`call_expression` → selector or identifier), type references (identifiers in
  `type_identifier` positions inside signatures, var/field decls, composite literals).
- Node mapping: file → `File`; `type X struct|interface` → `Class`; `func f()` → `Function`
  with parent = file; method `func (r T) m()` → `Function` named `T.m` with parent = the
  `Class` node of `T` when `T` is declared in the same package, else parent = file.
  Other type declarations (`type X int`) are not nodes.
- Resolution (`resolve`): package = directory. Module path read from the nearest `go.mod`
  (walk up from the file) so `import "mod/path/pkg"` resolves to the workspace directory
  `pkg/`; an `Imports` edge from the importing file to **every** `.go` file in that package
  directory (Go imports packages, not files). External/std imports → placeholder named by the
  import path, `resolved: false`. Unqualified call `f()` → function `f` in the same package;
  `pkg.F()` → `F` in the imported package via alias/last path segment; method calls `x.m()` →
  unresolved placeholder `m` (no type inference in v1). Type references resolve the same way
  (`T`, `pkg.T`).
- Fixture `fixtures/go/`: `go.mod` (`module example.com/app`), `main.go` (imports the two
  others, `main` calls `parseConfig`, `fetchData` (undefined), uses type `Config`),
  `config.go` (`type Config struct`, `func parseConfig() Config`, `func parseEnv()`),
  `util.go` (`func readFile`), one sub-package `internal/db/conn.go` imported by `config.go`,
  and one call into the standard library (`fmt.Println`) to exercise an unresolved import.
- Tests: `cargo test -p frontend-go` runs `extract` on every fixture file and `resolve` over
  all of them; `insta` snapshots of `FileSymbols` per file and of the sorted edge list.

## Design
- `.kernel/specs/features/code-graph/design/data-model.md` — node/edge shape and parent rules this produces.
- `.kernel/specs/features/code-graph/scenarios.md § explore the graph` — the Go fixture shape (`main.go`, `config.go`, `util.go`, `parseConfig`, `fetchData`).

## Code anchors
- `core/frontend/go/Cargo.toml` — `ir`, `tree-sitter`, `tree-sitter-go`, dev `insta`
- `core/frontend/go/src/lib.rs` — `GoFrontend` implementing `ir::Frontend`
- `core/frontend/go/src/extract.rs` — parse + queries → `FileSymbols`
- `core/frontend/go/src/resolve.rs` — package/module resolution → `Vec<Edge>`
- `core/frontend/go/src/queries/{defs,imports,calls,refs}.scm`
- `core/frontend/go/tests/snapshots.rs`, `core/frontend/go/tests/snapshots/*.snap`
- `fixtures/go/**` — fixture repo
- `core/Cargo.lock` — shared with the other wave-3 changes (merge expected)

## Capabilities
- Modifies: none
- Creates: `core/frontend-go` — Go extraction and best-effort resolution into the IR.

## Invariants / constraints
- Depends only on `ir`, `tree-sitter` and the grammar crate; never on another frontend, `index`, `rpc` or `export` (OVERVIEW rule).
- Every raw reference yields exactly one edge; an unbound one is `resolved: false` to a placeholder named with the raw name (code-graph R4).
- `extract` is pure per file: same bytes → same `FileSymbols`, no filesystem access; only `resolve` reads `go.mod`.
- A file that fails to parse at the top level still yields a `File` node with zero symbols and a `FrontendError` the index can log (workspace-index R6).
- Node names: file = workspace-relative path; function = identifier; method = `Type.method`; class = type identifier (code-graph data-model).

## Acceptance criteria
- [ ] `cargo test -p frontend-go` passes; snapshots cover: file, class (struct and interface), function, method with class parent, method with file parent (receiver from another package), `contains`, `imports` (internal, resolved) and `imports` to a placeholder (std), `calls` resolved same-package and cross-package, `calls` unresolved (`fetchData`, and a method call), `references` to a struct type.
- [ ] The `main.go` → `fetchData` edge in the snapshot is `kind: calls, resolved: false` to a placeholder named `fetchData`.
- [ ] A fixture file containing a syntax error (added under `fixtures/go/broken/`) extracts a `File` node and returns the error; the test asserts both.
- [ ] `cargo clippy -p frontend-go --all-targets -- -D warnings` is clean; `unsafe` appears only in the grammar binding module.

## Plan
`/plan:change .kernel/specs/epics/code-graph/changes/04-frontend-go.md` — plan reads this file
directly and derives the change name from it.
