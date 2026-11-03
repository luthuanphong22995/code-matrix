---
status: draft
---

# Scenarios: Data Flow

Review each scenario, edit freely, then set `status: reviewed` — /check:test refuses a draft.
- `as-is` (derived from code): is this intended? If not, add `⚠ bug` after the tag.
  A bug is routed to /bugs:investigate, never turned into a test.
- `new` (from the interview): is this what we want?

## Journey: trace a variable

### Scenario: trace a local variable from the cursor `new` (v1)
- Given an indexed workspace with `config.go` containing `parseConfig`, where line 12 reads `total := 0`, line 14 reads `total = total + n` inside a `for` loop, and line 18 reads `return total`, and the graph panel is closed
- When the developer places the cursor on `total` at line 18 and runs `Code Matrix: Trace Data Flow`
- Then the graph panel opens with `config.go` expanded, `parseConfig` unfolded into its basic blocks, the blocks holding lines 12, 14 and 18 highlighted, and the trace bar reading "Hop 1 of 4: `total` defined at line 12 → used at line 14" (R1, R4, R6, R7)

### Scenario: trace a parameter `new` (v1)
- Given `parseConfig(path string)` declared at line 11 of `config.go`, where `path` is read at line 13 (`open(path)`) and line 20 (`log(path)`) and never reassigned
- When the developer places the cursor on `path` in the parameter list and runs `Trace Data Flow`
- Then the trace has two hops, both from the parameter declaration, the entry block is highlighted as the def, and the trace bar reads "Hop 1 of 2: `path` defined at line 11 → used at line 13" (R4, R5, R9)

### Scenario: picking a def traces forward from it `new` (v1)
- Given `handle` in `server.go` where `status := 200` is at line 30, `status = 404` is at line 33 inside an `if`, and `write(status)` is at line 36
- When the developer places the cursor on `status` at line 33 and runs `Trace Data Flow`
- Then the trace contains only the def at line 33 and the use at line 36, and the trace bar reads "Hop 1 of 1: `status` defined at line 33 → used at line 36" (R4, R5)

### Scenario: uses on both branches are included `new` (v1)
- Given `handle` where `code := read()` is at line 40 and `code` is read at line 43 in the `if` branch and at line 46 in the `else` branch
- When the developer traces `code` from line 40
- Then the trace has two hops, line 40 → 43 and line 40 → 46, in that order (R4, R5)

### Scenario: a redefinition cuts the chain `new` (v1)
- Given `calc` where `v := 1` is at line 50, `v = 2` at line 52 with no branch between them, and `print(v)` at line 54
- When the developer traces `v` from line 54
- Then the trace has exactly one hop, line 52 → 54, and line 50 is not highlighted (R4, R5)

### Scenario: loop back-edge hop is included `new` (v1)
- Given `sum` where `acc := 0` is at line 60 and `acc = acc + x` is at line 62 inside a `for` loop
- When the developer traces `acc` from the read at line 62
- Then the trace has two hops ordered by use position, line 60 → 62 and line 62 → 62 (R5)

### Scenario: flow is not followed into another variable `new` (v1)
- Given `calc` where `x := read()` is at line 70, `y := x + 1` at line 71 and `print(y)` at line 72
- When the developer traces `x` from line 70
- Then the trace has one hop, line 70 → 71, and line 72 is not highlighted (R4)

### Scenario: same-named variable in another scope is not included `new` (v1)
- Given `run` where `i := 0` is at line 79 and read at line 80, and a nested block declares its own `i := 10` at line 85 and reads it at line 86
- When the developer traces `i` from line 80
- Then only the outer `i` is in the trace, with one hop line 79 → 80, and lines 85 and 86 are not highlighted (R4)

### Scenario: capture by a lambda is one use `new` (v1)
- Given `serve` where `limit := 5` is at line 90, a lambda defined at line 92 reads `limit` twice inside its body at lines 93 and 94, and `print(limit)` is at line 97
- When the developer traces `limit` from line 90
- Then the trace has two hops, line 90 → 92 (the capture site) and line 90 → 97, and lines 93 and 94 are not highlighted (R5, R10)

### Scenario: cursor on no identifier `new` (v1)
- Given the cursor is on whitespace inside `parseConfig` and a trace of `total` is active
- When the developer runs `Trace Data Flow`
- Then the message "Place the cursor on a variable or parameter" is shown and the `total` trace is unchanged (R2)

### Scenario: cursor on a function name `new` (v1)
- Given the cursor is on the name `open` in the call `open(path)` inside `parseConfig`
- When the developer runs `Trace Data Flow`
- Then the message "`open` is not a local variable or parameter of `parseConfig`" is shown and nothing else changes (R3)

### Scenario: cursor on a global `new` (v1)
- Given `config.go` declares the package-level `defaultPath` and `parseConfig` reads it at line 15
- When the developer places the cursor on `defaultPath` at line 15 and runs `Trace Data Flow`
- Then the message "`defaultPath` is not a local variable or parameter of `parseConfig`" is shown and nothing else changes (R3)

### Scenario: cursor outside any function `new` (v1)
- Given the cursor is on the package-level declaration `defaultPath` at line 5 of `config.go`
- When the developer runs `Trace Data Flow`
- Then the message "`defaultPath` is not inside a function" is shown and nothing else changes (R3)

### Scenario: variable with no reached use `new` (v1)
- Given `parseConfig` declares `unused := 1` at line 16 and never reads it
- When the developer traces `unused` from line 16
- Then the block holding line 16 is highlighted, Prev and Next are disabled, and the trace bar reads "No uses of `unused` in `parseConfig`" (R9)

### Scenario: read with no reaching def `new` (v1)
- Given `parseConfig` declares `var n int` without an initializer at line 17, in a language where that declaration is not a def, and reads `n` at line 19 with no assignment in between
- When the developer traces `n` from line 19
- Then the block holding line 19 is highlighted, Prev and Next are disabled, and the trace bar reads "No definition of `n` reaches this read" (R9)

### Scenario: language without data-flow support `new` (v1)
- Given the workspace contains `script.rb` and the Ruby frontend provides no def-use
- When the developer places the cursor on a variable in `script.rb` and runs `Trace Data Flow`
- Then the message "Data flow is not supported for Ruby yet" is shown and nothing else changes (R15)

## Journey: step through the flow

### Scenario: Next moves to the following hop `new` (v1)
- Given the `total` trace in `parseConfig` is at "Hop 1 of 4: `total` defined at line 12 → used at line 14"
- When the developer clicks "Next"
- Then the trace bar reads "Hop 2 of 4", the block holding the new hop's use is marked current, and the editor beside the graph reveals that use with its def and use decorated distinctly (R7)

### Scenario: arrow keys step when the graph panel has focus `new` (v1)
- Given the `total` trace is at hop 2 of 4 and the graph panel has focus
- When the developer presses the right arrow key
- Then the trace moves to hop 3 of 4 (R7)

### Scenario: Next is disabled on the last hop `new` (v1)
- Given the `total` trace is at hop 4 of 4
- When the developer presses the right arrow key
- Then "Next" is disabled, "Prev" is enabled, and the trace stays at hop 4 of 4 (R8)

### Scenario: Prev is disabled on the first hop `new` (v1)
- Given the `total` trace is at hop 1 of 4
- When the developer presses the left arrow key
- Then "Prev" is disabled, "Next" is enabled, and the trace stays at hop 1 of 4 (R8)

### Scenario: all occurrences stay decorated while stepping `new` (v1)
- Given the `total` trace is active with defs at lines 12 and 14 and uses at lines 14 and 18
- When the developer steps to hop 2
- Then lines 12, 14 and 18 all carry the trace decoration in the editor, and only hop 2's def and use carry the current-hop decoration (R7)

### Scenario: selecting another node keeps the trace `new` (v1)
- Given the `total` trace is at hop 2 of 4
- When the developer clicks the file node `util.go`
- Then the Details region shows `util.go`, and the trace bar still reads "Hop 2 of 4" with the CFG and highlights unchanged (R13)

## Journey: end or lose a trace

### Scenario: Clear trace folds the CFG back `new` (v1)
- Given the `total` trace is active with `parseConfig` unfolded into blocks
- When the developer clicks "Clear trace"
- Then the blocks are replaced by the single `parseConfig` function node, the trace bar is gone, and no trace decoration remains in the editor (R12)

### Scenario: Escape clears the trace `new` (v1)
- Given the `total` trace is active and the graph panel has focus
- When the developer presses Escape
- Then the blocks are replaced by the single `parseConfig` function node, the trace bar is gone, and no trace decoration remains in the editor (R12)

### Scenario: a new trace replaces the active one `new` (v1)
- Given the `total` trace in `parseConfig` is active
- When the developer places the cursor on `code` in `handle` in `server.go` and runs `Trace Data Flow`
- Then `parseConfig` folds back into its function node, `handle` unfolds into its CFG, and the trace bar shows hop 1 of the `code` trace (R6, R11)

### Scenario: re-index recomputes the trace and keeps the hop `new` (v1)
- Given the `total` trace is at hop 3 of 4, `total` defined at line 14 → used at line 18
- When the developer inserts a blank line at line 1 of `config.go`, saves, and the graph refreshes after re-indexing
- Then the trace is recomputed with every hop one line lower and stays on the hop that is now line 15 → line 19, shown as hop 3 of 4 (R14)

### Scenario: re-index resets the hop when it no longer exists `new` (v1)
- Given the `total` trace is at hop 4 of 4, `total` defined at line 14 → used at line 18
- When the developer deletes line 18, saves, and the graph refreshes after re-indexing
- Then the trace is recomputed for `total`, has 3 hops, and is at hop 1 of 3 (R14)

### Scenario: re-index with the function removed clears the trace `new` (v1)
- Given the `total` trace in `parseConfig` is active
- When the developer deletes `parseConfig` from `config.go`, saves, and the graph refreshes after re-indexing
- Then the trace is cleared, the message "Trace cleared: `parseConfig` no longer exists" is shown, and no trace decoration remains in the editor (R14)

### Scenario: re-index with the variable removed clears the trace `new` (v1)
- Given the `total` trace in `parseConfig` is active
- When the developer renames every `total` to `sum`, saves, and the graph refreshes after re-indexing
- Then the trace is cleared, the message "Trace cleared: `total` no longer exists in `parseConfig`" is shown, and `parseConfig` folds back into its function node (R14)
