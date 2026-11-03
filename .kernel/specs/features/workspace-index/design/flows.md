# Workspace Index — Flows

## Full run lifecycle

One run at a time per sidecar. The shell's state (`app-shell/design/flows.md § Sidecar
lifecycle`) is `indexing` from Scanning until Complete or Cancelled.

```mermaid
stateDiagram-v2
    [*] --> NoIndex : sidecar ready
    NoIndex --> Scanning : Open Graph first time / Re-index / roots changed / sidecar (re)started with panel open
    Scanning --> Indexing : walk finished, total known
    Scanning --> Cancelled : Cancel
    Indexing --> Indexing : file done → progress N of M
    Indexing --> Complete : last file done → publish graph, apply queued changes, publish again if any
    Indexing --> Cancelled : Cancel
    Indexing --> Scanning : Re-index → discard partial results, start over
    Scanning --> Scanning : Re-index → start over
    Complete --> Scanning : Re-index / roots changed
    Cancelled --> Scanning : Re-index (strip button, toolbar button or command)
    Complete --> Complete : single-file re-index → publish
    Complete --> [*] : sidecar exit (index lost)
    Cancelled --> [*] : sidecar exit
    NoIndex --> [*] : sidecar exit
```

Notes:
- `Cancelled` keeps whatever graph was published by the last `Complete`; if there was none,
  the panel shows the cancelled overlay.
- Watcher events received in `Scanning` or `Indexing` go to a queue; `Complete` drains it in
  arrival order before the final publish (R8). `Cancelled` drops the queue: those files will be
  seen by the next full run.
- A sidecar exit in any state loses the index; the shell's restart leads back to `NoIndex`, and
  with the panel open the extension starts a run at once (R11, R12).

**Rules**: R1, R3, R4, R8, R9, R10, R11, R12, R14

## Index a workspace (first run)

```mermaid
flowchart TD
    A[Shell state ready after initialize] --> B{Graph panel open?}
    B -- no --> Z0[Nothing runs until Open Graph] --> B
    B -- yes --> C[Extension sends index/run with roots and files.exclude globs]
    C --> D[Shell state indexing; strip 'Scanning workspace…'; canvas 'Indexing workspace…']
    D --> E[Sidecar walks roots: supported extension, not excluded, not ignored]
    E --> F[Strip 'Indexing 0 of M files']
    F --> G{Next file}
    G -- over 1 MB --> H[Log 'Skipped path: file exceeds 1 MB'; no node] --> F2[progress N+1]
    G -- parse ok --> I[Symbols into IR] --> F2
    G -- parse fails --> J[Log 'Failed path: reason'; bare file node] --> F2
    F2 --> K{More files?}
    K -- yes --> G
    K -- no --> L[Resolve cross-file references; unresolvable become Unresolved edges]
    L --> M[Drain queued watcher events in order]
    M --> N[Publish graph: graph/changed; shell state ready]
    N --> O[Strip 'Indexed N files' or 'Indexed N files, F failed' + Show Log + ×]
    O --> P{M was 0?}
    P -- yes --> Q[code-graph shows 'No supported source files found']
    P -- no --> R[code-graph renders the graph]
```

**Rules**: R1, R2, R3, R4, R6, R8, R13

## Keep the graph current

```mermaid
flowchart TD
    A[Watcher: created / changed / deleted on a path] --> B{Supported extension and not files.exclude?}
    B -- no --> Z[Ignored, nothing logged]
    B -- yes --> C[Extension sends index/filesChanged]
    C --> D{Full run in progress?}
    D -- yes --> E[Queued until the run completes]
    D -- no --> F{Change type}
    F -- deleted --> G[Remove file node and its symbols; edges into them become Unresolved]
    F -- created / changed --> H{Ignored by .gitignore or over 1 MB?}
    H -- yes --> I[Treat as removed if it had a node; log Skipped if over cap]
    H -- no --> J[Re-parse that file only]
    J -- ok --> K[Replace its symbols; re-resolve edges into and out of it]
    J -- fails --> L[Log 'Failed path: reason'; keep bare file node]
    G --> M[Publish graph/changed with removed node ids]
    I --> M
    K --> M
    L --> M
    M --> N[code-graph refreshes; selection and expansion kept where node ids survive]
```

A rename arrives as `deleted` on the old path then `created` on the new one; the two are
applied in order and published once each. The status bar does not change during a single-file
re-index.

**Rules**: R7, R8, R13, R15

## Re-run or cancel indexing

```mermaid
flowchart TD
    A[Run in progress, strip shows progress] --> B{Developer chooses}
    B -- Cancel --> C[index/cancel; partial results discarded; strip hidden; queue dropped]
    C --> D{Complete graph published earlier?}
    D -- yes --> E[Canvas keeps the previous graph; state ready]
    D -- no --> F[Canvas: 'Indexing cancelled' + Re-index button; state ready]
    B -- Re-index button / command --> G[Current run cancelled, new run starts at 'Scanning workspace…']
    G --> A
    B -- closes the panel --> H[Run continues; status bar stays 'indexing']
    H --> I[Reopening the panel shows the strip in its current state]
    B -- Restart Server --> J[Sidecar restarts; index lost; new run starts when ready]
    F -- Re-index --> G
```

Abandonment: closing the panel never cancels a run. Closing the window stops the sidecar, and
the next `Open Graph` in a new window starts from scratch (R11).

**Rules**: R1, R9, R10, R11, R12
