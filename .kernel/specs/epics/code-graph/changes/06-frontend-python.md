---
title: Python frontend — extraction, import resolution, fixture + snapshots
type: epic-change
epic: code-graph
status: planned
depends-on: [ir-graph-model]
feature: code-graph
---

# frontend-python

**As a** developer with a Python workspace, **I want** its modules, classes, functions,
imports, calls and type references in the graph **so that** I can see how the package hangs
together and which names the frontend could not bind.

## Intent
Crate `core/frontend/python` implementing `ir::Frontend` for `.py` with tree-sitter
(`tree-sitter-python`). Fixture repo `fixtures/python/` with snapshots.

## Approach
- Crate `frontend-python` depends on `ir`, `tree-sitter`, `tree-sitter-python`.
- Node mapping: file → `File`; `class` → `Class`; `def` and `async def` → `Function`; methods
  have parent = class; nested defs have parent = enclosing function; module-level defs have
  parent = file. Lambdas are not nodes.
- Imports: `import a.b.c`, `import a.b as x`, `from a.b import c, d`, `from . import x`,
  `from ..pkg import y`. Resolution maps a dotted module to a path under any workspace root
  (`a/b/c.py` or `a/b/c/__init__.py`), relative imports from the importing file's package
  directory. `from a.b import c` resolves to module `a.b` (file edge) and, if `c` is a def in
  it, binds `c` for calls/refs; if `a.b.c` is itself a module, resolves to that file.
  Unresolvable (stdlib, site-packages, missing) → placeholder named with the dotted module,
  `resolved: false`. No `sys.path`/virtualenv inspection in v1.
- Calls: `f()` → the def `f` bound in the module scope (local def, or imported name);
  `mod.f()` where `mod` is an imported module → `f` in that module; `Cls()` → `calls` edge to
  the class; `self.m()` → method `m` of the enclosing class when it exists, else placeholder;
  other attribute calls → placeholder named with the attribute.
- References: base classes in `class A(B)`, annotations (`x: Config`, `-> Config`) → `references`
  edge to the bound class, else placeholder.
- Fixture `fixtures/python/`: `app/__init__.py`, `app/main.py` (imports `app.config`,
  `from .util import read_file`, `import os`; calls `parse_config`, `fetch_data` (undefined),
  annotates with `Config`), `app/config.py` (`class Config`, `def parse_config() -> Config`,
  `def parse_env`), `app/util.py` (`def read_file`), `app/models/base.py` and
  `app/models/user.py` (`class User(Base)` with a method calling `self.save()`),
  `scripts/run.py` (`from app.main import main`).
- Tests: `cargo test -p frontend-python`; `insta` snapshots per fixture file and of the sorted edges.

## Design
- `.kernel/specs/features/code-graph/design/data-model.md` — node/edge shape, parent rules.
- `.kernel/specs/features/code-graph/feature.md` R3, R4 — kinds and unresolved handling.

## Code anchors
- `core/frontend/python/Cargo.toml` — `ir`, `tree-sitter`, `tree-sitter-python`, dev `insta`
- `core/frontend/python/src/lib.rs` — `PythonFrontend`
- `core/frontend/python/src/extract.rs` — queries → `FileSymbols`
- `core/frontend/python/src/resolve.rs` — dotted-module → path, relative imports, binding
- `core/frontend/python/src/queries/{defs,imports,calls,refs}.scm`
- `core/frontend/python/tests/snapshots.rs`, `core/frontend/python/tests/snapshots/*.snap`
- `fixtures/python/**`
- `core/Cargo.lock` — shared with the other wave-3 changes (merge expected)

## Capabilities
- Modifies: none
- Creates: `core/frontend-python` — Python extraction and best-effort import resolution into the IR.

## Invariants / constraints
- Depends only on `ir`, `tree-sitter` and the grammar crate; never on another frontend, `index`, `rpc` or `export`.
- Every raw reference and import yields exactly one edge; unbound → `resolved: false` placeholder (code-graph R4).
- `extract` is pure per file; `resolve` touches the filesystem only to probe module paths under the workspace roots.
- `language()` is `python`; `extensions()` is exactly `py` (workspace-index R2).
- A file with a top-level parse error still yields a `File` node and a `FrontendError`.

## Acceptance criteria
- [ ] `cargo test -p frontend-python` passes; snapshots cover: class, function, method (class parent), nested def (function parent); absolute, aliased, `from … import`, relative (`.`, `..`) and package (`__init__.py`) imports resolved, plus `import os` as a placeholder; `calls` to a local def, an imported def, a module attribute, a class constructor, `self.method`, and unresolved (`fetch_data`, an attribute call); `references` via a base class and an annotation.
- [ ] A syntax-error fixture extracts a `File` node and returns the error.
- [ ] `cargo clippy -p frontend-python --all-targets -- -D warnings` is clean; `unsafe` only in the grammar binding module.

## Plan
`/plan:change .kernel/specs/epics/code-graph/changes/06-frontend-python.md` — plan reads this file
directly and derives the change name from it.
