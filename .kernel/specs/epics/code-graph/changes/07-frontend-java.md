---
title: Java frontend — extraction, package/import resolution, fixture + snapshots
type: epic-change
epic: code-graph
status: planned
depends-on: [ir-graph-model]
feature: code-graph
---

# frontend-java

**As a** developer with a Java workspace, **I want** its compilation units, types, methods,
imports, calls and type references in the graph **so that** I can see how the packages hang
together and which names stayed unbound.

## Intent
Crate `core/frontend/java` implementing `ir::Frontend` for `.java` with tree-sitter
(`tree-sitter-java`). Fixture repo `fixtures/java/` with snapshots.

## Approach
- Crate `frontend-java` depends on `ir`, `tree-sitter`, `tree-sitter-java`.
- Node mapping: file → `File`; `class`, `interface`, `enum`, `record`, annotation type →
  `Class` (nested types: parent = enclosing class); methods and constructors → `Function`
  with parent = enclosing class, named `method` (overloads collapse into one node in v1:
  same qualified name → same id; note this in the capability). Fields and lambdas are not nodes.
- Imports: `import a.b.C;` → the file declaring class `C` in package `a.b` under any workspace
  root (package is read from the file's `package` declaration, not from its directory);
  `import a.b.*;` → placeholder named `a.b.*`; `import static a.b.C.m;` → file of `C` and binds
  `m`. JDK and external imports → placeholder named with the fully qualified name,
  `resolved: false`. Same-package types need no import: `resolve` builds a package → types map.
- Calls: `m()` → method `m` in the enclosing class, then its superclass chain when the
  superclass is in the workspace; `this.m()` same; `Type.m()` → static method of a bound type;
  `new T()` → `calls` edge to class `T`; `obj.m()` → placeholder `m` (no type inference in v1).
- References: type usages in extends/implements, field and local declarations, parameters,
  return types, generics, `new T` → `references` edge to the bound class, else placeholder
  named with the simple or qualified name as written.
- Fixture `fixtures/java/`: `src/main/java/com/example/App.java` (imports `com.example.config.Config`,
  `com.example.util.*`, `java.util.List`; `main` calls `Config.parse`, `fetchData()` (undefined),
  `new Server()`), `src/main/java/com/example/config/Config.java` (`record`/`class Config` with
  static `parse`, `parseEnv`), `src/main/java/com/example/util/Files.java` (`readFile`),
  `src/main/java/com/example/Server.java` (`class Server extends Base` with a method calling an
  inherited method), `src/main/java/com/example/Base.java`, and an `interface` + `enum` + nested
  class in one file.
- Tests: `cargo test -p frontend-java`; `insta` snapshots per fixture file and of the sorted edges.

## Design
- `.kernel/specs/features/code-graph/design/data-model.md` — node/edge shape, parent rules.
- `.kernel/specs/features/code-graph/feature.md` R3, R4 — kinds and unresolved handling.

## Code anchors
- `core/frontend/java/Cargo.toml` — `ir`, `tree-sitter`, `tree-sitter-java`, dev `insta`
- `core/frontend/java/src/lib.rs` — `JavaFrontend`
- `core/frontend/java/src/extract.rs` — queries → `FileSymbols` (package decl, types, methods, imports, calls, type refs)
- `core/frontend/java/src/resolve.rs` — package map, import binding, superclass chain
- `core/frontend/java/src/queries/{defs,imports,calls,refs}.scm`
- `core/frontend/java/tests/snapshots.rs`, `core/frontend/java/tests/snapshots/*.snap`
- `fixtures/java/**`
- `core/Cargo.lock` — shared with the other wave-3 changes (merge expected)

## Capabilities
- Modifies: none
- Creates: `core/frontend-java` — Java extraction and best-effort package/import resolution into the IR.

## Invariants / constraints
- Depends only on `ir`, `tree-sitter` and the grammar crate; never on another frontend, `index`, `rpc` or `export`.
- Every raw reference and import yields exactly one edge; unbound → `resolved: false` placeholder (code-graph R4).
- `extract` is pure per file; `resolve` needs no filesystem access (binding is by declared package, over the extracted set).
- `language()` is `java`; `extensions()` is exactly `java` (workspace-index R2).
- A file with a top-level parse error still yields a `File` node and a `FrontendError`.

## Acceptance criteria
- [ ] `cargo test -p frontend-java` passes; snapshots cover: class, interface, enum, record, nested class (class parent); method and constructor (class parent); `imports` resolved by package+name, wildcard and JDK placeholders, static import; `calls` to a same-class method, an inherited workspace method, a static method via import, a constructor, and unresolved (`fetchData`, an instance method on a local); `references` via extends, field type, parameter type and generic argument.
- [ ] A type whose package declaration does not match its directory still resolves by the declared package.
- [ ] A syntax-error fixture extracts a `File` node and returns the error.
- [ ] `cargo clippy -p frontend-java --all-targets -- -D warnings` is clean; `unsafe` only in the grammar binding module.

## Plan
`/plan:change .kernel/specs/epics/code-graph/changes/07-frontend-java.md` — plan reads this file
directly and derives the change name from it.
