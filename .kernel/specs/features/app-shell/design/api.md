# App Shell — API

Two interfaces the shell defines and other features extend.

## 1. Extension ↔ sidecar: JSON-RPC 2.0 over stdio

The extension spawns the bundled binary `code-matrix-server` (no arguments; stdin/stdout are
the transport, stderr goes to the `Code Matrix` output channel). Framing as in LSP:
`Content-Length` headers. Request/response types are defined once in Rust (`rpc` crate) and
mirrored in the extension.

### Requests (extension → sidecar)

| Method | Params | Result | Errors |
|---|---|---|---|
| `initialize` | `{ roots: string[] }` — absolute paths of every workspace root (R3) | `{ serverVersion: string, languages: string[] }` | `-32001 InvalidRoots` (a root is not a directory) |
| `shutdown` | none | `null` | — |

`initialize` must be the first request; any other request before it is answered with
`-32002 NotInitialized`. After `shutdown` the sidecar exits with code 0; the extension treats
that exit as expected.

### Notifications (sidecar → extension)

| Method | Params | When |
|---|---|---|
| `$/status` | `{ state: "ready" \| "indexing", detail?: string }` | every state change; drives the status bar text and the panel's indexing overlay (R7) |
| `$/log` | `{ level: "info" \| "warn" \| "error", message: string }` | anything the sidecar wants in the output channel beyond raw stderr (R10) |

Other features add their own methods (`graph/*`, `index/*`, `flow/*`); none of them may be
sent before `initialize` succeeds.

### Exit handling (extension side)

| Sidecar exit | Shell reaction |
|---|---|
| exit 0 after `shutdown` | expected; nothing shown |
| any other exit, restart budget available | respawn silently, log `server exited with code N, restarting` (R5) |
| any other exit, budget spent | failed state, cause `Process exited with code N` (R5, R6) |
| spawn fails: binary missing | failed state, cause `Server binary not found for <platform>: <path>` (R11) |
| spawn fails: other OS error | failed state, cause is the OS error text |

## 2. Extension ↔ webview: postMessage

Messages between the extension host and the graph panel's webview. `code-graph` adds the
graph payloads; the shell defines only these.

| Direction | `type` | Payload | Effect |
|---|---|---|---|
| ext → webview | `shell/state` | `{ state: "starting" \| "indexing" \| "ready" \| "failed", cause?: string }` | panel switches overlay / enables toolbar |
| webview → ext | `shell/selectNode` | `{ nodeId: string }` | extension records the selection; details content comes from `code-graph` |
| webview → ext | `shell/openNode` | `{ nodeId: string }` | open file at node range; on missing file, toast `File not found: <path>` (R8, R9) |
| webview → ext | `shell/retry` | none | Retry button (R6) |
| webview → ext | `shell/restart` | none | Restart Server button |
| webview → ext | `shell/showLog` | none | reveal output channel (R10) |

## 3. VS Code contributions

| Contribution | Id / label |
|---|---|
| command | `codeMatrix.openGraph` — `Code Matrix: Open Graph` |
| command | `codeMatrix.restartServer` — `Code Matrix: Restart Server` |
| command | `codeMatrix.showLog` — `Code Matrix: Show Log` |
| output channel | `Code Matrix` |
| status bar item | `codeMatrix.status`, left aligned |
| webview panel | viewType `codeMatrix.graph`, title `Code Matrix` |

Activation: on any of the three commands. The sidecar is **not** started on activation (R4).
