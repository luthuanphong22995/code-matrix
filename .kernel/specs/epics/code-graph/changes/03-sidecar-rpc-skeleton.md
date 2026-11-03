---
title: Sidecar RPC skeleton — code-matrix-server with initialize/shutdown, $/status, $/log
type: epic-change
epic: code-graph
status: planned
depends-on: [project-init]
feature: app-shell
---

# sidecar-rpc-skeleton

**As a** developer, **I want** the extension to be able to spawn `code-matrix-server` and
complete the `initialize` handshake over stdio **so that** every later request (`graph/*`,
later `index/*` and `flow/*`) rides on one transport and one dispatch loop.

## Intent
Implements `app-shell/design/api.md § 1` minus any graph method: JSON-RPC 2.0 over stdin/stdout
with LSP `Content-Length` framing, the request dispatcher, `initialize` and `shutdown`, the
`$/status` and `$/log` notifications, and the `NotInitialized` / `InvalidRoots` errors. Protocol
types live once in Rust with serde; change 09 mirrors them in TypeScript.

## Approach
- `rpc/src/transport.rs`: a blocking reader thread parsing `Content-Length: N\r\n\r\n<body>`
  frames from stdin into an mpsc channel, and a `Sender` that serializes outgoing frames to
  stdout behind a mutex (notifications may be sent from the index thread later). Malformed
  frame → `-32700 ParseError` response when an id is recoverable, else logged and skipped.
- `rpc/src/protocol.rs`: `Request`, `Response`, `Notification`, `RpcError { code, message, data }`,
  and the typed params/results: `InitializeParams { roots: Vec<PathBuf> }`,
  `InitializeResult { server_version, languages }`, `StatusParams { state: Ready | Indexing, detail }`,
  `LogParams { level: Info | Warn | Error, message }`. serde with `camelCase` renames to match the
  design's field names. Error codes as constants: `NOT_INITIALIZED = -32002`, `INVALID_ROOTS = -32001`
  (leave `-32010`, `-32011` for change 10).
- `rpc/src/server.rs`: `Server { state: Uninitialized | Initialized { roots } , handlers }`,
  `dispatch(request)`: `initialize` → validate each root is a directory (else `InvalidRoots`),
  store, reply `{ serverVersion: CARGO_PKG_VERSION, languages: [] }` (change 10 fills languages
  from the registry); any other method before that → `NotInitialized`; `shutdown` → reply `null`,
  then exit 0 after the response is flushed. Unknown method → `-32601 MethodNotFound`.
  `Server::notify_status`, `Server::log` write `$/status` / `$/log`.
- `rpc/src/main.rs`: build `Server`, run the loop; stderr is left alone (the extension pipes it
  to the output channel). Keep `--version` from 01.
- Tests drive the server in-process over a pair of pipes (`std::io::Cursor` / `os_pipe` or an
  in-memory duplex) with raw framed bytes, so framing is tested as bytes, not as structs.

## Design
- `.kernel/specs/features/app-shell/design/api.md § 1` — requests, notifications, error codes, exit semantics.
- `.kernel/specs/features/app-shell/design/flows.md § Sidecar lifecycle` — `initialize ok → Ready`; `shutdown` → exit 0.

## Code anchors
- `core/rpc/src/transport.rs` — `read_frame`, `write_frame`, `Sender`
- `core/rpc/src/protocol.rs` — message envelopes, typed params/results, error codes
- `core/rpc/src/server.rs` — `Server`, `dispatch`, `notify_status`, `log`
- `core/rpc/src/main.rs` — binary entry, stdio loop
- `core/rpc/src/lib.rs` — exports for tests and for change 10
- `core/rpc/tests/handshake.rs` — framed-byte tests
- `core/rpc/Cargo.toml` — `serde`, `serde_json`

## Capabilities
- Modifies: none
- Creates: `core/rpc-transport` — JSON-RPC framing, dispatch, initialize/shutdown lifecycle, status and log notifications.

## Invariants / constraints
- Any request before a successful `initialize` is answered with `-32002 NotInitialized` (api.md § 1).
- `initialize` with a root that is not a directory is answered with `-32001 InvalidRoots` and leaves the server uninitialized.
- After `shutdown` is answered, the process exits with code 0 and writes nothing more to stdout.
- Every outgoing frame is one complete `Content-Length`-framed JSON-RPC 2.0 message; frames from different threads never interleave.
- stdout carries only protocol frames; everything else goes to stderr or `$/log` (app-shell R10).
- `rpc` depends on `index` and `export` only (OVERVIEW); neither is used yet in this change.

## Acceptance criteria
- [ ] `cargo test -p rpc` passes: `initialize` with a temp dir root returns `serverVersion` and `languages: []`; a `graph/files` request before `initialize` returns `-32002`; `initialize` with a file path as root returns `-32001`; `shutdown` returns `null` and the loop ends; a frame with a bad `Content-Length` does not kill the loop.
- [ ] A spawned `code-matrix-server` (via `CARGO_BIN_EXE_code-matrix-server`) answers `initialize` then `shutdown` and exits 0; the test asserts stdout contains exactly the two response frames.
- [ ] `cargo clippy -p rpc --all-targets -- -D warnings` is clean.

## Plan
`/plan:change .kernel/specs/epics/code-graph/changes/03-sidecar-rpc-skeleton.md` — plan reads this file
directly and derives the change name from it.
