---
title: Workspace index core — walk, select, run frontends, resolve, in-memory store
type: epic-change
epic: code-graph
status: planned
depends-on: [ir-graph-model]
feature: workspace-index
---

# workspace-index-core

**As a** developer, **I want** the sidecar to index every supported file under the workspace
roots into one in-memory graph on start **so that** the graph the panel shows is the whole
workspace, with skipped and failed files accounted for.

## Intent
Fills `core/index`: the full-run pipeline from workspace roots to an `ir::Graph`, and the store
that holds the current graph for `rpc` to serve. Builds only the non-UI rules of
`workspace-index` (R1 auto-run on start, R2 file selection, R4 publish-on-completion, R6
failed-file node, R11 memory-only, R13 skipped files). Progress reporting, Cancel, the
re-index command, watchers and single-file re-index belong to the `workspace-index` epic;
`files.exclude` is left out because `initialize` carries no exclusion list (see epic Open
Questions). The frontends are injected, not hard-wired, so this change tests against a fake
and change 10 registers the real four.

## Approach
- `registry.rs`: `FrontendRegistry { frontends: Vec<Box<dyn Frontend>> }` with
  `by_extension(ext) -> Option<&dyn Frontend>` and `languages()`. Built by the binary (change 10).
- `walk.rs`: walk every root with the `ignore` crate (honours `.gitignore`, skips hidden and
  VCS dirs), yielding `Candidate { root, rel_path, size }`. Select when the extension matches
  a registered frontend; a selected file over 1 MiB is **skipped** and reported as
  `Skipped::TooLarge`, never as failed (R2). Unsupported or ignored files are silently not
  candidates (R15 spirit). Paths are workspace-relative to their root; with multiple roots
  the relative path is prefixed with the root's basename to stay unique (app-shell R3).
- `run.rs`: `full_run(registry, roots, events: &dyn RunEvents) -> RunResult`:
  1. walk + select; 2. `extract` every selected file (parallel with `std::thread::scope`
     over a chunked list; `rayon` only if the plan finds it simpler); a `FrontendError`
     records a failure and still inserts the `File` node with no symbols (R6); 3. build the
     `SymbolTable`; 4. per language, `resolve` over that language's files; 5. assemble an
     `ir::Graph`. `RunResult { graph, indexed: usize, failed: Vec<(path, reason)>, skipped: Vec<(path, Skipped)> }`.
  `RunEvents` is a small trait (`on_started`, `on_finished(&RunResult)`) so `rpc` can map it
  to `$/status` and `$/log` without `index` knowing about JSON-RPC.
- `store.rs`: `IndexStore { current: RwLock<Option<Arc<Graph>>> }` with `publish(graph) -> Vec<NodeId>`
  returning the ids present in the previous graph and absent in the new one (what
  `graph/changed.removedNodeIds` needs), and `snapshot() -> Option<Arc<Graph>>`. A graph is
  published only when a run completes (R4); until the first publish `snapshot()` is `None`
  (`graph/files` → `NotIndexed`).
- The sidecar runs a full run on every start — nothing is persisted (R11). The trigger itself
  (after `initialize`) is wired in change 10.

## Design
- No `workspace-index` design exists. Behaviour is taken from `workspace-index/feature.md`
  R1, R2, R4, R6, R11, R13, R15 and `app-shell/design/api.md § 1` (`$/status` states).

## Code anchors
- `core/index/src/registry.rs` — `FrontendRegistry`
- `core/index/src/walk.rs` — root walk, selection, size cap, `Skipped`
- `core/index/src/run.rs` — `full_run`, `RunResult`, `RunEvents`
- `core/index/src/store.rs` — `IndexStore::publish`, `snapshot`
- `core/index/src/lib.rs` — exports
- `core/index/tests/fake_frontend.rs`, `core/index/tests/full_run.rs` — fake-frontend tests over a temp workspace
- `core/index/Cargo.toml` — `ir`, `ignore`, `thiserror`
- `core/Cargo.lock` — shared with the other wave-3 changes (merge expected)

## Capabilities
- Modifies: none
- Creates: `core/index` — workspace walk, file selection, full-run pipeline and the in-memory graph store.

## Invariants / constraints
- A file is a candidate only if its extension belongs to a registered frontend, it is not `.gitignore`d, and it is ≤ 1 MiB; a larger file is reported skipped, never failed (workspace-index R2).
- A skipped file has no node in the graph; references to it stay unresolved (R13).
- A file whose frontend returned an error is in the graph as a `File` node with no symbols and is listed in `failed` with its reason (R6).
- The store publishes only a completed run's graph; a run that panics or errors leaves the previous graph in place (R4, R9 spirit).
- `publish` returns exactly the node ids that were in the previous graph and are not in the new one.
- `index` depends on `ir` and frontends via the trait only; it never names a concrete frontend crate (OVERVIEW: `index → frontend/*, ir` is satisfied by the binary's registry, keeping `index` itself frontend-free and testable with a fake).
- Multi-root: every root is walked and the result is one graph (app-shell R3).

## Acceptance criteria
- [ ] `cargo test -p index` passes with a `FakeFrontend` (extension `fake`) over a temp workspace containing: supported files, an unsupported extension, a `.gitignore`d file, a 1 MiB + 1 byte file, and a file the fake fails on — asserting `indexed`, `failed` and `skipped` exactly, that the failed file has a bare `File` node, and that the skipped file has none.
- [ ] Two roots produce one graph with both roots' files and unique relative paths.
- [ ] `publish` of a second graph missing one file returns that file's node ids (file + symbols) as removed; `snapshot()` before any publish is `None`.
- [ ] `RunEvents` receives `on_started` once and `on_finished` once with the result.
- [ ] `cargo clippy -p index --all-targets -- -D warnings` is clean.

## Plan
`/plan:change .kernel/specs/epics/code-graph/changes/08-workspace-index-core.md` — plan reads this file
directly and derives the change name from it.
