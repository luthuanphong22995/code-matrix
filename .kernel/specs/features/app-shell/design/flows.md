# App Shell — Flows

## Sidecar lifecycle

The state the status bar and the graph panel both display. One sidecar per window.

```mermaid
stateDiagram-v2
    [*] --> NotStarted
    NotStarted --> Starting : Open Graph (folder open)
    NotStarted --> NotStarted : Open Graph (no folder) → toast "Open a folder to analyze"
    Starting --> Ready : initialize ok
    Starting --> Failed : spawn error / binary missing / initialize error
    Ready --> Indexing : $/status indexing
    Indexing --> Ready : $/status ready
    Ready --> Restarting : unexpected exit, budget available
    Indexing --> Restarting : unexpected exit, budget available
    Restarting --> Starting : respawn (silent, logged)
    Ready --> Failed : unexpected exit, budget spent (2nd exit within 60 s)
    Indexing --> Failed : unexpected exit, budget spent
    Failed --> Starting : Retry (budget reset)
    Ready --> Starting : Restart Server (budget untouched)
    Indexing --> Starting : Restart Server
    Failed --> Starting : Restart Server
    Ready --> [*] : window closed → shutdown
    Indexing --> [*] : window closed → shutdown
    Failed --> [*] : window closed
```

Budget: one silent restart. The budget is spent when a second unexpected exit happens within
60 s of the previous one; it is restored by a successful 60 s of uptime or by `Retry`.
`Restart Server` is user-initiated and never counts as an unexpected exit.

**Rules**: R2, R4, R5, R6, R7, R11

## Open the graph

```mermaid
flowchart TD
    A[Developer runs Code Matrix: Open Graph] --> B{Workspace folder open?}
    B -- no --> C[Toast: Open a folder to analyze] --> Z[end]
    B -- yes --> D{Panel already open?}
    D -- yes --> E[Focus existing panel] --> Z
    D -- no --> F[Create panel 'Code Matrix' as editor tab]
    F --> G{Sidecar running?}
    G -- yes --> H[Panel shows current state] --> Z
    G -- no --> I[Spawn sidecar, status bar 'starting', panel state starting]
    I --> J{Spawn + initialize ok?}
    J -- no --> K[Panel state failed with cause, status bar 'failed'] --> Z
    J -- yes --> L[initialize with all workspace roots] --> M[Panel state ready, status bar 'ready'] --> Z
```

**Rules**: R1, R2, R3, R4, R7, R11

## Jump to source

```mermaid
flowchart TD
    A[Single click on node] --> B[Select node, fill Details region]
    B --> C{Double-click / Enter / Open in editor}
    C --> D{File exists?}
    D -- yes --> E[Open file beside the graph, reveal node range, cursor at start line]
    D -- no --> F[Toast: File not found: path; selection kept]
    B --> G[Escape clears selection; Details shows 'Select a node to see its details']
```

**Rules**: R8, R9

## Recover from a failed sidecar

```mermaid
flowchart TD
    A[Panel state failed] --> B{Developer chooses}
    B -- Show Log --> C[Reveal 'Code Matrix' output channel] --> A
    B -- Retry --> D[Reset budget, spawn sidecar, state starting]
    D --> E{Starts?}
    E -- yes --> F[state ready]
    E -- no --> A
    B -- closes panel / ignores --> G[Status bar stays 'failed'; click reveals log] --> A
```

Abandonment: closing the panel in the failed state leaves the status bar at `failed`; nothing
retries on its own.

**Rules**: R5, R6, R7, R10
