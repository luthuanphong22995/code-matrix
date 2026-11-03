---
status: draft
---

# Scenarios: Code Graph

Review each scenario, edit freely, then set `status: reviewed` — /check:test refuses a draft.
- `as-is` (derived from code): is this intended? If not, add `⚠ bug` after the tag.
  A bug is routed to /bugs:investigate, never turned into a test.
- `new` (from the interview): is this what we want?

## Journey: explore the graph

### Scenario: default view is files and imports `new` (v1)
- Given an indexed workspace with files `main.go`, `config.go`, `util.go` where `main.go` imports the other two and `config.go` defines `parseConfig`
- When the developer opens the graph
- Then three file nodes are shown with two imports edges from `main.go`, and no class or function node is visible (R1, R3)

### Scenario: expanding a file reveals its symbols `new` (v1)
- Given the default view above
- When the developer expands the `config.go` node
- Then function node `parseConfig` appears with a contains edge from `config.go` (R2)

### Scenario: calls edge appears only when both ends are visible `new` (v1)
- Given `config.go` is expanded showing `parseConfig`, and `main.go` (collapsed) contains `main` which calls `parseConfig`
- When the developer expands `main.go`
- Then function node `main` appears with a calls edge from `main` to `parseConfig` (R2)

### Scenario: collapsing a file hides its symbols and their edges `new` (v1)
- Given `main.go` and `config.go` are both expanded with the calls edge `main → parseConfig` visible
- When the developer collapses `main.go`
- Then `main` and the calls edge disappear; `parseConfig` stays visible (R2)

### Scenario: unresolved reference is drawn distinctly `new` (v1)
- Given `main.go` is expanded and `main` calls `fetchData`, which the frontend could not resolve
- When the developer looks at the `main` node's edges
- Then a dashed edge leads to a placeholder node labelled `fetchData` marked unresolved (R4)

### Scenario: selected node details with edge counts `new` (v1)
- Given `config.go` is expanded and `parseConfig` is called by `main` and references type `Config`
- When the developer selects `parseConfig`
- Then the Details region shows Kind `function`, Name `parseConfig`, Location `config.go:12`, incoming `calls: 1`, outgoing `references: 1` (R12)

### Scenario: no supported source files `new` (v1)
- Given a workspace containing only `README.md` and `notes.txt`
- When the developer opens the graph
- Then the canvas shows "No supported source files found" and no nodes (R10)

### Scenario: refresh after re-index keeps the view state `new` (v1)
- Given `config.go` is expanded, `parseConfig` is selected, and the references toggle is on
- When the workspace is re-indexed and the graph refreshes
- Then `config.go` is still expanded, `parseConfig` still selected, and references still shown (R11)

### Scenario: refresh after a selected node was deleted `new` (v1)
- Given `parseConfig` is selected
- When `config.go` is deleted and the graph refreshes after re-indexing
- Then `config.go` and `parseConfig` are gone, nothing is selected, and the Details region shows "Select a node to see its details" (R11)

### Scenario: Expand button in Details mirrors the handle `new` (v1)
- Given the collapsed file node `config.go` is selected
- When the developer clicks "Expand" in the Details region
- Then `config.go` expands exactly as if its `+` handle were clicked, and the button now reads "Collapse" (R2)

### Scenario: placeholder node details `new` (v1)
- Given an unresolved placeholder node `fetchData` is visible
- When the developer selects it
- Then the Details region shows Kind `unresolved`, Name `fetchData`, no Location and no "Open in editor" button (R4, R12)

## Journey: find a symbol

### Scenario: search highlights and centres on the first hit `new` (v1)
- Given the graph shows `config.go` expanded with `parseConfig` and `parseEnv`, and `util.go` collapsed
- When the developer searches `parse`
- Then `parseConfig` and `parseEnv` are highlighted and the view centres on `parseConfig` (R6)

### Scenario: search is case-insensitive `new` (v1)
- Given the graph shows the visible node `parseConfig`
- When the developer searches `PARSECONFIG`
- Then `parseConfig` is highlighted (R6)

### Scenario: search matches only visible nodes `new` (v1)
- Given `config.go` is collapsed so `parseConfig` is not visible
- When the developer searches `parseConfig`
- Then "No matches for 'parseConfig'" is shown (R6)

### Scenario: search with no hit `new` (v1)
- Given any graph
- When the developer searches `zzz`
- Then "No matches for 'zzz'" is shown and nothing is highlighted (R6)

### Scenario: clearing the search removes highlights `new` (v1)
- Given the search `parse` is applied with 2 matches highlighted
- When the developer presses Escape in the Search field
- Then the field is empty, no node is highlighted and the match text is gone (R6)

## Journey: narrow a large graph

### Scenario: default toggles `new` (v1)
- Given the graph has just opened
- When the developer looks at the kind toggles
- Then file, class, function, contains, imports and calls are on, and references is off (R5)

### Scenario: toggling references on shows reference edges `new` (v1)
- Given `config.go` is expanded and `parseConfig` references type `Config` in `types.go` (expanded)
- When the developer turns the references toggle on
- Then a references edge from `parseConfig` to `Config` appears (R3, R5)

### Scenario: hiding a node kind hides its edges `new` (v1)
- Given expanded files with function nodes and calls edges visible
- When the developer turns the function toggle off
- Then every function node and every calls edge between functions disappears (R5)

### Scenario: path glob restricts to matching files `new` (v1)
- Given files `src/api/handler.go`, `src/api/router.go` and `src/db/conn.go`
- When the developer applies the path glob `src/api/**`
- Then only `src/api/handler.go` and `src/api/router.go` and their symbols are shown (R7)

### Scenario: invalid path glob keeps the previous filter `new` (v1)
- Given the path glob `src/api/**` is applied
- When the developer enters the glob `src/[api`
- Then "Invalid pattern: src/[api" is shown and the graph still shows only `src/api/**` (R7)

### Scenario: focus on a node shows its neighbourhood `new` (v1)
- Given `main` is selected, `main` calls `parseConfig`, and `parseConfig` calls `readFile`
- When the developer applies Focus with 1 hop
- Then only `main` and `parseConfig` are visible (R8)

### Scenario: focus with more hops `new` (v1)
- Given focus on `main` with 1 hop as above
- When the developer sets hops to 2
- Then `main`, `parseConfig` and `readFile` are visible (R8)

### Scenario: clearing focus restores the previous view `new` (v1)
- Given the view had 40 nodes visible before focusing on `main` with 1 hop
- When the developer clears focus
- Then the same 40 nodes are visible again with the previous expansion state (R8)

### Scenario: graph over the cap is not rendered `new` (v1)
- Given a workspace with 2,500 indexed files
- When the developer opens the graph
- Then the canvas shows "Graph too large to render (2500 nodes). Narrow it with a filter." and no nodes are drawn (R9)

### Scenario: a filter brings the graph under the cap `new` (v1)
- Given the "Graph too large to render (2500 nodes)" message is shown
- When the developer applies the path glob `src/api/**` matching 300 files
- Then 300 file nodes are rendered and the message is gone (R7, R9)

### Scenario: Focus is disabled with nothing selected `new` (v1)
- Given the graph is shown and no node is selected
- When the developer looks at the toolbar
- Then the "Focus" button is disabled and "Hops" is disabled (R8)

### Scenario: filters that exclude everything `new` (v1)
- Given an indexed workspace with Go files only
- When the developer applies the path glob `docs/**`
- Then the canvas is empty, the counts read "0 nodes · 0 edges", and no "No supported source files found" message is shown (R7, R10)
