---
status: draft
---

# Scenarios: Workspace Index

Review each scenario, edit freely, then set `status: reviewed` — /check:test refuses a draft.
- `as-is` (derived from code): is this intended? If not, add `⚠ bug` after the tag.
  A bug is routed to /bugs:investigate, never turned into a test.
- `new` (from the interview): is this what we want?

## Journey: index a workspace

### Scenario: first open indexes the whole workspace `new` (v1)
- Given a workspace with 12 supported files (6 `.ts`, 4 `.py`, 2 `.go`) and no graph panel open
- When the developer runs `Code Matrix: Open Graph`
- Then the panel shows "Indexing N of 12 files" with a Cancel action, the status bar shows "Code Matrix: indexing", and no graph is drawn until the run completes (R1, R3, R4, R5)

### Scenario: completed run publishes the graph with a summary `new` (v1)
- Given a full run over 12 supported files is in progress and every file parses
- When the last file is indexed
- Then the panel shows "Indexed 12 files", the graph with 12 file nodes is published, and the status bar shows "Code Matrix: ready" (R4, R6)

### Scenario: excluded and unsupported files are not indexed `new` (v1)
- Given a workspace with `src/app.ts`, `node_modules/lib/index.js` listed in `.gitignore`, `build/out.js` matched by `files.exclude`, and `README.md`
- When a full run completes
- Then the panel shows "Indexed 1 files" and the graph contains only the node for `src/app.ts` (R2)

### Scenario: a file over 1 MB is skipped, not failed `new` (v1)
- Given a workspace with `src/app.ts` (2 KB) and `src/generated.ts` (3 MB)
- When a full run completes
- Then the panel shows "Indexed 1 files", the output channel contains a line "Skipped src/generated.ts: file exceeds 1 MB", and `src/generated.ts` has no node (R2, R13)

### Scenario: a reference into a skipped file is an Unresolved edge `new` (v1)
- Given `src/app.ts` imports `parse` from `src/generated.ts`, and `src/generated.ts` is 3 MB
- When a full run completes
- Then the graph has an Unresolved edge from `src/app.ts` labelled `parse` and no node for `src/generated.ts` (R13)

### Scenario: a file that fails to parse is reported and kept as a bare node `new` (v1)
- Given a workspace with `src/ok.py` and `src/broken.py` whose content makes the Python frontend fail
- When a full run completes
- Then the panel shows "Indexed 2 files, 1 failed", the output channel contains "Failed src/broken.py: <reason>", and `src/broken.py` is a file node with no class or function nodes (R6)

### Scenario: Show Log from the summary reveals the failure lines `new` (v1)
- Given a full run completed with the panel showing "Indexed 2 files, 1 failed"
- When the developer clicks "Show Log" in the index strip
- Then the "Code Matrix" output channel is revealed and contains the line "Failed src/broken.py: <reason>" (R6)

### Scenario: dismissing the summary keeps the graph `new` (v1)
- Given a full run completed with the panel showing "Indexed 12 files"
- When the developer clicks "×" in the index strip
- Then the strip disappears and the graph over 12 files stays unchanged (R6)

### Scenario: a workspace with no supported files completes with zero `new` (v1)
- Given a workspace containing only `README.md` and `notes.txt`
- When a full run completes
- Then the panel shows "Indexed 0 files" and an empty graph is published (R2, R6)

### Scenario: sidecar restart re-indexes from scratch `new` (v1)
- Given a complete graph over 12 files is shown and the sidecar exits unexpectedly
- When the app shell silently restarts the sidecar
- Then a full run starts with no developer action, the panel shows "Indexing N of 12 files" over the previous graph, and on completion the graph is republished (R5, R11, R12)

## Journey: keep the graph current

### Scenario: saving a file re-indexes only that file `new` (v1)
- Given a complete graph where `src/a.ts` defines function `foo` and `src/b.ts` calls `foo`
- When the developer saves `src/a.ts` with `foo` renamed to `bar`
- Then only `src/a.ts` is re-indexed, the graph is republished with a function node `bar`, and the calls edge from `src/b.ts` to `foo` becomes an Unresolved edge labelled `foo` (R7)

### Scenario: creating a supported file adds it to the graph `new` (v1)
- Given a complete graph over 12 files
- When the developer creates `src/new.go` containing one function `Run`
- Then the graph is republished with 13 file nodes and a function node `Run` under `src/new.go`, without a full run (R7)

### Scenario: deleting a file removes it and unresolves references to it `new` (v1)
- Given a complete graph where `src/b.ts` imports `src/a.ts`
- When the developer deletes `src/a.ts`
- Then the graph is republished without the node for `src/a.ts`, and the imports edge from `src/b.ts` becomes an Unresolved edge (R7)

### Scenario: renaming a file moves its node `new` (v1)
- Given a complete graph with a file node `src/a.ts` containing function `foo`
- When the developer renames `src/a.ts` to `src/alpha.ts`
- Then the graph is republished with a file node `src/alpha.ts` containing `foo` and no node `src/a.ts` (R7)

### Scenario: an external on-disk change is picked up `new` (v1)
- Given a complete graph where `src/a.ts` has one function
- When `src/a.ts` is overwritten outside VS Code (git checkout) with a version that has two functions
- Then `src/a.ts` is re-indexed and the graph is republished with two function nodes under it (R7)

### Scenario: a change to an unsupported or excluded file triggers nothing `new` (v1)
- Given a complete graph over 12 files
- When the developer saves `README.md` and `node_modules/lib/index.js`
- Then no re-index runs and the graph is not republished (R15)

### Scenario: a save during a full run is applied after it completes `new` (v1)
- Given a full run over 200 files is at "Indexing 50 of 200 files"
- When the developer saves `src/a.ts` with a new function `late`
- Then the run continues uninterrupted, and after it completes `src/a.ts` is re-indexed and the graph is published once, containing `late` (R4, R8)

### Scenario: adding a workspace folder triggers a full run `new` (v1)
- Given a complete graph over one workspace folder with 12 files
- When the developer adds a second folder containing 5 supported files to the workspace
- Then a full run starts and on completion the panel shows "Indexed 17 files" (R14)

### Scenario: removing a workspace folder triggers a full run `new` (v1)
- Given a complete graph over two workspace folders with 12 and 5 files
- When the developer removes the second folder from the workspace
- Then a full run starts and on completion the panel shows "Indexed 12 files" with no node from the removed folder (R14)

## Journey: re-run or cancel indexing

### Scenario: the toolbar Re-index button starts a full run `new` (v1)
- Given a complete graph over 12 files is shown and the sidecar is ready
- When the developer clicks "Re-index" in the toolbar
- Then a full run starts and the panel shows "Indexing N of 12 files" with a Cancel action (R1, R3)

### Scenario: Re-index from the cancelled overlay starts a full run `new` (v1)
- Given the first run was cancelled and the panel shows "Indexing cancelled" with a "Re-index" action
- When the developer clicks "Re-index"
- Then a full run starts, the overlay is replaced by progress, and on completion the graph is published (R1, R9)

### Scenario: manual re-index keeps the old graph visible until done `new` (v1)
- Given a complete graph over 12 files is shown
- When the developer runs `Code Matrix: Re-index Workspace`
- Then the previous graph stays visible with "Indexing N of 12 files" shown over it, and on completion the graph is republished (R1, R5)

### Scenario: cancelling the first run leaves a Re-index action `new` (v1)
- Given the first run of a workspace is at "Indexing 50 of 200 files" and no previous graph exists
- When the developer clicks Cancel
- Then the run stops, no graph is published, and the panel shows "Indexing cancelled" with a "Re-index" action (R9)

### Scenario: cancelling a re-run keeps the previous graph `new` (v1)
- Given a complete graph over 12 files is shown and a re-run is at "Indexing 5 of 12 files"
- When the developer clicks Cancel
- Then the run stops and the previous graph over 12 files remains shown unchanged (R9)

### Scenario: re-index during a run restarts from scratch `new` (v1)
- Given a full run is at "Indexing 50 of 200 files"
- When the developer runs `Code Matrix: Re-index Workspace`
- Then the current run is cancelled and a new run starts, with the panel showing "Indexing 0 of 200 files" (R10)
