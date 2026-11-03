---
title: Sidecar RPC Server
type: epic-change
epic: app-shell
status: planned
depends-on: [project-init]
feature: app-shell
---

# sidecar-rpc-server

**As a** developer, **I want** the `code-matrix-server` binary to speak the shell's JSON-RPC
protocol over stdio **so that** the extension can initialize it on my workspace roots and learn
its state.

## Intent
Implements `.kernel/specs/features/app-shell/design/api.md § 1` on the Rust side: the `rpc`
crate's framing and message types, and the server binary's request loop handling
`initialize` (all workspace roots, R3) and `shutdown`, emitting `$/status` and `$/log`, and
rejecting anything sent before `initialize`. No analysis, no indexing: after `initialize` the
server reports `ready` and waits. The types defined here are what `03-sidecar-lifecycle`
mirrors in TypeScript and what `code-graph` / `workspace-index` extend with `graph/*` and
`index/*` later.

## Approach
- **`rpc` crate** (`core/crates/rpc`), no project-internal deps:
  - `framing.rs` — LSP-style `Content-Length: N\r\n\r\n<json>` reader/writer over any
    `BufRead` / `Write`. `read_message` returns `Ok(None)` on clean EOF.
  - `message.rs` — JSON-RPC 2.0 `Request { id, method, params }`, `Response { id, result |
    error }`, `Notification { method, params }`, `ResponseError { code, message, data }`,
    an untagged `Message` enum, serde derives.
  - `protocol.rs` — the shell's types: `InitializeParams { roots: Vec<PathBuf> }`,
    `InitializeResult { server_version: String, languages: Vec<String> }` (camelCase via
    serde rename), `StatusParams { state: ServerState, detail: Option<String> }` with
    `ServerState::{Ready, Indexing}` serialized lowercase, `LogParams { level:
    LogLevel::{Info, Warn, Error}, message }`, method name constants `INITIALIZE`,
    `SHUTDOWN`, `STATUS = "$/status"`, `LOG = "$/log"`, error codes `INVALID_ROOTS = -32001`,
    `NOT_INITIALIZED = -32002`, plus standard `METHOD_NOT_FOUND = -32601`.
- **`server` crate** (`core/crates/server`), bin `code-matrix-server`, no arguments:
  - `main.rs` — locks stdin/stdout, runs `Server::run(reader, writer)`, exits with the code
    it returns. `shutdown` → write the `null` response, flush, exit 0.
  - `handler.rs` — `Server` state `Uninitialized | Initialized { roots }`. `initialize`:
    every root must be an existing directory, else `-32001 InvalidRoots` with the offending
    path in `data`; on success respond with `serverVersion = env!("CARGO_PKG_VERSION")`,
    `languages: []` (frontends register later), then send `$/status { state: ready }`. A
    second `initialize` is answered with a `-32600` invalid-request error. Any other request
    before `initialize` → `-32002 NotInitialized`. Unknown method after init → `-32601`.
    Notifications from the client are ignored. Malformed JSON → `-32700` parse error, loop
    continues. Panics must not swallow the response: run the loop in `std::panic::catch_unwind`
    so a panic logs to stderr and exits non-zero (the extension treats that as unexpected).
  - Anything the server wants in the output channel beyond raw stderr goes through
    `$/log`; the handler sends one `info` line `initialized with N roots` after `initialize`.
- **Tests** (`core/crates/server/tests/lifecycle.rs`): spawn the built binary
  (`env!("CARGO_BIN_EXE_code-matrix-server")`) with piped stdio and a helper that frames /
  unframes messages; cases below. `rpc` has unit tests for framing round-trips and for the
  serde shape of every protocol type (exact JSON fixtures, since TS mirrors them).

## Design
- `.kernel/specs/features/app-shell/design/api.md § 1 Extension ↔ sidecar` — requests,
  notifications, error codes, "initialize must be first", "after shutdown the sidecar exits
  with code 0"
- `.kernel/specs/features/app-shell/design/flows.md § Sidecar lifecycle` — `Starting → Ready :
  initialize ok`, `Ready → Indexing : $/status indexing` (the indexing transition is emitted
  by `workspace-index` later; this change only emits `ready`)

## Code anchors
- `core/crates/rpc/src/lib.rs` — re-exports `framing`, `message`, `protocol`
- `core/crates/rpc/src/framing.rs` — `read_message`, `write_message`
- `core/crates/rpc/src/message.rs` — `Request`, `Response`, `Notification`, `ResponseError`, `Message`
- `core/crates/rpc/src/protocol.rs` — `InitializeParams`, `InitializeResult`, `StatusParams`, `ServerState`, `LogParams`, `LogLevel`, method and error-code constants
- `core/crates/server/src/main.rs` — `main`
- `core/crates/server/src/handler.rs` — `Server`, `Server::run`, `Server::handle_request`
- `core/crates/server/tests/lifecycle.rs` — binary-level tests
- `core/crates/server/Cargo.toml` — `[[bin]] name = "code-matrix-server"`

## Capabilities
- Modifies: none
- Creates: `core/rpc-server` — JSON-RPC 2.0 over stdio with LSP framing; `initialize` /
  `shutdown` lifecycle; `$/status` / `$/log` notifications; pre-initialize rejection

## Invariants / constraints
- `initialize` must be the first request; any other request before it is answered
  `-32002 NotInitialized` (app-shell api.md).
- `initialize` takes every workspace root and the server treats them as one graph
  (app-shell R3); a root that is not a directory → `-32001 InvalidRoots`.
- After `shutdown` the process exits with code 0 and nothing else is written to stdout
  (app-shell api.md § Exit handling: exit 0 after shutdown is the only expected exit).
- Everything diagnostic goes to stderr or `$/log`, never stdout — stdout carries only framed
  JSON-RPC (app-shell R10).
- No arguments, no environment variables read, no network, no file writes.
- Every request/response type is defined once here and serialized with serde
  (OVERVIEW convention); JSON field names are camelCase to match `api.md`.
- `rpc` depends on nothing project-internal; `server` depends only on `rpc`.

## Acceptance criteria
- [ ] Binary test: send `initialize { roots: [<tmpdir>] }` → response has `serverVersion` equal to the crate version and `languages: []`, followed by notification `$/status { state: "ready" }`; then `shutdown` → `null` result, process exits with code 0 and stdout is at EOF
- [ ] Binary test: send `shutdown` before `initialize` → error `-32002` with message `NotInitialized`; process keeps running and a subsequent `initialize` succeeds
- [ ] Binary test: `initialize { roots: [<tmpdir>, "/does/not/exist"] }` → error `-32001` with message `InvalidRoots` and the bad path in `data`; state stays uninitialized
- [ ] Binary test: two roots that both exist → one success response (R3); unknown method `graph/files` after init → `-32601`
- [ ] Binary test: a line of invalid JSON inside a valid frame → `-32700` response and the loop continues (next `initialize` succeeds)
- [ ] Binary test: stdin closed without `shutdown` → process exits with a non-zero code
- [ ] `rpc` unit tests: framing round-trip for a 0-byte, 1-byte and 1 MiB payload; serde fixtures for `InitializeParams`, `InitializeResult`, `StatusParams` (both states), `LogParams` (all levels) match the JSON in `api.md` byte for byte after normalisation
- [ ] `cargo clippy --all-targets -- -D warnings` and `cargo fmt --check` pass

## Plan
`/plan:change .kernel/specs/epics/app-shell/changes/02-sidecar-rpc-server.md` — plan reads this
file directly and derives the change name from it.
