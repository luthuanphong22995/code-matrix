---
title: TypeScript/JavaScript frontend — extraction, module-path resolution, fixture + snapshots
type: epic-change
epic: code-graph
status: planned
depends-on: [ir-graph-model]
feature: code-graph
---

# frontend-typescript

**As a** developer with a TypeScript or JavaScript workspace, **I want** its modules, classes,
functions, imports, calls and type references in the graph **so that** I can see how the
front-end or Node code hangs together, including this extension's own source.

## Intent
Crate `core/frontend/typescript` implementing `ir::Frontend` for `.ts`, `.tsx`, `.js`, `.jsx`
with tree-sitter (the `typescript` and `tsx` grammars from `tree-sitter-typescript`; `.js`/`.jsx`
parsed with the `tsx` grammar, which is a superset for this purpose). One language id,
`typescript`, covers all four extensions (workspace-index R2 groups them). Fixture repo
`fixtures/typescript/` with snapshots.

## Approach
- Crate `frontend-typescript` depends on `ir`, `tree-sitter`, `tree-sitter-typescript`.
  Pick the grammar per extension: `.ts` → typescript, `.tsx`/`.js`/`.jsx` → tsx.
- Node mapping: file → `File`; `class`, `interface`, `enum` declarations → `Class`
  (`type` aliases are not nodes); `function` declarations, `export default function`,
  methods and constructors (parent = enclosing class), and `const f = () => {}` /
  `const f = function` at module scope (parent = file) → `Function`. Nested functions inside
  function bodies: parent = the enclosing function. Anonymous callbacks are not nodes.
- Imports: `import … from "x"`, `import "x"`, `export … from "x"`, `require("x")` with a string
  literal. Relative and `/`-rooted specifiers resolve by probing, in order: exact path,
  `+.ts`, `+.tsx`, `+.js`, `+.jsx`, `/index.ts`, `/index.tsx`, `/index.js`; `.js` suffix in
  the specifier also tries `.ts`. Bare specifiers (`react`, `vscode`) and unresolved paths →
  placeholder named with the specifier, `resolved: false`. No `tsconfig` `paths` in v1.
- Calls: `f()` → the function `f` bound in this file (local def, or a named import mapped to
  the exporting file's def of that name; `export default` matches a default import); `obj.m()`,
  `this.m()` → `m` as an unresolved placeholder unless `obj` is a namespace import
  (`import * as ns`) whose target file exports `m`. `new C()` → `calls` edge to class `C` when
  bound the same way.
- References: identifiers in type positions (annotations, `extends`, `implements`, generics)
  → `references` edge to a `Class` bound through the same import map, else placeholder.
- Fixture `fixtures/typescript/`: `src/index.ts` (imports `./config`, `./util.js`, `react`;
  calls `parseConfig`, `fetchData` (undefined), uses type `Config`), `src/config.ts`
  (`interface Config`, `export function parseConfig(): Config`, `parseEnv`),
  `src/util/index.ts` (`readFile`), `src/App.tsx` (a class component with a method, `new`),
  `legacy/old.js` (`require`, `module.exports`), `legacy/view.jsx`.
- Tests: `cargo test -p frontend-typescript`; `insta` snapshots of `FileSymbols` per fixture
  file and the sorted resolved edges.

## Design
- `.kernel/specs/features/code-graph/design/data-model.md` — node/edge shape, parent rules.
- `.kernel/specs/features/code-graph/feature.md` R3, R4 — kinds and unresolved handling.

## Code anchors
- `core/frontend/typescript/Cargo.toml` — `ir`, `tree-sitter`, `tree-sitter-typescript`, dev `insta`
- `core/frontend/typescript/src/lib.rs` — `TypeScriptFrontend`, grammar selection by extension
- `core/frontend/typescript/src/extract.rs` — queries → `FileSymbols`
- `core/frontend/typescript/src/resolve.rs` — module-path probing, import map, binding
- `core/frontend/typescript/src/queries/{defs,imports,calls,refs}.scm`
- `core/frontend/typescript/tests/snapshots.rs`, `core/frontend/typescript/tests/snapshots/*.snap`
- `fixtures/typescript/**`
- `core/Cargo.lock` — shared with the other wave-3 changes (merge expected)

## Capabilities
- Modifies: none
- Creates: `core/frontend-typescript` — TypeScript/JavaScript extraction and best-effort module resolution into the IR.

## Invariants / constraints
- Depends only on `ir`, `tree-sitter` and the grammar crate; never on another frontend, `index`, `rpc` or `export`.
- Every raw reference and every import specifier yields exactly one edge; unbound → `resolved: false` placeholder named with the raw name or specifier (code-graph R4).
- `extract` is pure per file; only `resolve` touches the filesystem, and only to probe candidate paths under the workspace roots.
- `language()` is `typescript`; `extensions()` is exactly `ts, tsx, js, jsx` (workspace-index R2).
- A file with a top-level parse error still yields a `File` node and a `FrontendError`.

## Acceptance criteria
- [ ] `cargo test -p frontend-typescript` passes; snapshots cover: class, interface, enum as `Class`; function, method (class parent), arrow const (file parent), nested function (function parent); `imports` resolved via each probe rule (`.ts`, `.js`→`.ts`, `/index.ts`) and a bare specifier placeholder; `calls` resolved through a named import, through a namespace import, `new` to a class, and unresolved (`fetchData`, a method call); `references` to an interface through an import.
- [ ] `.js` and `.jsx` fixture files produce nodes and a `require` import edge.
- [ ] A syntax-error fixture extracts a `File` node and returns the error.
- [ ] `cargo clippy -p frontend-typescript --all-targets -- -D warnings` is clean; `unsafe` only in the grammar binding module.

## Plan
`/plan:change .kernel/specs/epics/code-graph/changes/05-frontend-typescript.md` — plan reads this file
directly and derives the change name from it.
