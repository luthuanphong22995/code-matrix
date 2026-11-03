---
status: draft
---

# Scenarios: App Shell

Review each scenario, edit freely, then set `status: reviewed` — /check:test refuses a draft.
- `as-is` (derived from code): is this intended? If not, add `⚠ bug` after the tag.
  A bug is routed to /bugs:investigate, never turned into a test.
- `new` (from the interview): is this what we want?

## Journey: open the graph

### Scenario: first open starts the sidecar and shows the panel `new` (v1)
- Given a window with folder `~/proj` open and the extension activated but no sidecar running
- When the developer runs `Code Matrix: Open Graph`
- Then the sidecar process starts, an editor tab titled "Code Matrix" opens, and the status bar shows "Code Matrix: starting" then "Code Matrix: ready" (R1, R4, R7)

### Scenario: re-running Open Graph focuses the existing panel `new` (v1)
- Given the "Code Matrix" panel is open in editor group 2 and another editor is focused
- When the developer runs `Code Matrix: Open Graph`
- Then the existing panel is focused and no second panel is created (R1)

### Scenario: no folder open `new` (v1)
- Given a window with no workspace folder open
- When the developer runs `Code Matrix: Open Graph`
- Then the message "Open a folder to analyze" is shown, no panel opens, and no sidecar starts (R2, R4)

### Scenario: multi-root workspace is one graph `new` (v1)
- Given a workspace with roots `~/api` and `~/web`
- When the developer runs `Code Matrix: Open Graph`
- Then one panel opens and the sidecar is asked to analyze both roots into a single graph (R3)

### Scenario: activation alone does not start the sidecar `new` (v1)
- Given a window with folder `~/proj` open
- When the extension activates and no command is run
- Then no sidecar process exists and the status bar item is not shown (R4)

### Scenario: closing the window stops the sidecar `new` (v1)
- Given the sidecar is running for the window
- When the developer closes the window
- Then the sidecar process is terminated (R4)

### Scenario: status bar click opens the panel `new` (v1)
- Given the sidecar is in state ready and the panel is closed
- When the developer clicks the status bar item "Code Matrix: ready"
- Then the "Code Matrix" panel opens and is focused (R7)

### Scenario: reopening a closed panel does not restart the sidecar `new` (v1)
- Given the sidecar is in state ready and the developer has closed the "Code Matrix" tab
- When the developer runs `Code Matrix: Open Graph`
- Then a new panel opens showing the current graph, the sidecar process is the same one, and the status bar stays "Code Matrix: ready" (R1, R4)

### Scenario: indexing state is shown in the panel `new` (v1)
- Given the panel is open and the sidecar reports state indexing
- When the developer looks at the panel
- Then the main region shows "Indexing workspace…" and the status bar shows "Code Matrix: indexing" (R7)

## Journey: jump to source

### Scenario: single click shows node details `new` (v1)
- Given the panel shows a graph containing function node `parseConfig` in `src/config.go` lines 12–40
- When the developer single-clicks the `parseConfig` node
- Then the node is selected and the details show kind "function", name "parseConfig", and "src/config.go:12" (R8)

### Scenario: double-click opens the file at the node's range `new` (v1)
- Given the `parseConfig` node is selected
- When the developer double-clicks it
- Then `src/config.go` opens in an editor beside the graph with lines 12–40 revealed and the cursor at line 12 (R8)

### Scenario: Enter opens the selected node `new` (v1)
- Given the `parseConfig` node is selected and the panel has focus
- When the developer presses Enter
- Then `src/config.go` opens beside the graph at line 12 (R8)

### Scenario: node file no longer exists `new` (v1)
- Given the graph contains a node anchored to `src/old.go`, which has been deleted since indexing
- When the developer double-clicks that node
- Then the message "File not found: src/old.go" is shown and the node stays selected (R9)

### Scenario: no node selected shows the empty details text `new` (v1)
- Given the panel is populated and nothing is selected
- When the developer looks at the details region
- Then it shows "Select a node to see its details" (R8)

### Scenario: Open in editor button opens the file `new` (v1)
- Given the `parseConfig` node is selected and the details region shows "src/config.go:12"
- When the developer clicks "Open in editor"
- Then `src/config.go` opens beside the graph at line 12 (R8)

### Scenario: Escape clears the selection `new` (v1)
- Given the `parseConfig` node is selected and the panel has focus
- When the developer presses Escape
- Then no node is selected and the details region shows "Select a node to see its details" (R8)

## Journey: recover from a failed sidecar

### Scenario: one crash restarts silently `new` (v1)
- Given the sidecar is in state ready
- When the sidecar process exits unexpectedly for the first time
- Then it is restarted without any message, the status bar passes through "Code Matrix: starting" back to "Code Matrix: ready", and the exit is written to the "Code Matrix" output channel (R5, R10)

### Scenario: second crash within a minute fails the shell `new` (v1)
- Given the sidecar was silently restarted 20 seconds ago
- When the sidecar process exits unexpectedly again
- Then the panel shows the failure cause with "Retry" and "Show Log", and the status bar shows "Code Matrix: failed" (R5, R6, R7)

### Scenario: Retry from the failed state `new` (v1)
- Given the shell is in the failed state
- When the developer clicks "Retry"
- Then the sidecar starts again, the restart budget is reset so a later single crash is again restarted silently, and the status bar shows "Code Matrix: starting" (R5, R6)

### Scenario: Show Log opens the output channel `new` (v1)
- Given the shell is in the failed state
- When the developer clicks "Show Log"
- Then the "Code Matrix" output channel is revealed containing the sidecar's stderr (R6, R10)

### Scenario: status bar click when failed opens the log `new` (v1)
- Given the status bar shows "Code Matrix: failed"
- When the developer clicks it
- Then the "Code Matrix" output channel is revealed (R7)

### Scenario: missing binary for the platform `new` (v1)
- Given the extension is installed on a platform with no bundled sidecar binary
- When the developer runs `Code Matrix: Open Graph`
- Then the panel opens in the failed state with the cause "Server binary not found for <platform>: <path>" and the buttons "Retry" and "Show Log" (R6, R11)

### Scenario: Restart Server command `new` (v1)
- Given the sidecar is in state ready
- When the developer runs `Code Matrix: Restart Server`
- Then the sidecar is stopped and started again, the status bar passes through "Code Matrix: starting", and this restart does not count toward the unexpected-exit budget (R5, R7)
