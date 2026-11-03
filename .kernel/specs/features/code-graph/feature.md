---
title: Code Graph
type: feature
created: 2026-11-03
version: 1
released: 0
---

# Feature: Code Graph

## Intent
Browse the structural graph of the workspace (files, classes, functions; contains, imports, calls, references) interactively, so a developer can see how an unfamiliar codebase hangs together without reading every file. Renders in the app shell's main region.

## Actors
- **developer** — wants to see what depends on what, drill from files into their symbols, find a symbol by name, and keep a large graph readable.

## Scope
**In**
- Files-first graph with expand/collapse into classes and functions
- Node kinds file, class, function; edge kinds contains, imports, calls, references
- Unresolved references drawn distinctly
- Narrowing: kind toggles, name search, path glob filter, neighbourhood focus
- Visible-node cap with a clear message
- Node details in the shell's Details region

**Out**
- Data-flow highlighting and stepping (`data-flow`)
- Indexing, progress and re-index triggers (`workspace-index`)
- Manual node positioning, saved layouts
- Export to file (DOT/GraphML/PNG)
- Variable nodes

## Rules
1. The default view shows one node per indexed file and imports edges only; classes and functions are hidden until their file is expanded. (v1)
2. Expanding a file node reveals its classes and functions with contains edges, plus calls and references edges to any other visible node; collapsing hides them again. (v1)
3. Node kinds are file, class and function; edge kinds are contains, imports, calls and references. (v1)
4. An unresolved reference is drawn as a dashed edge to a placeholder node labelled with the raw name; it is never dropped. (v1)
5. Kind toggles hide or show every node or edge of that kind; hiding a node kind also hides its edges. By default all node kinds and the edge kinds contains, imports and calls are shown, and references is hidden. (v1)
6. Name search highlights every visible node whose name contains the query, case-insensitively, and centres the view on the first hit; with no hit it shows "No matches for '<query>'". (v1)
7. The path glob filter restricts the graph to files matching the glob and the nodes inside them; an invalid glob shows "Invalid pattern: <glob>" and keeps the previous filter. (v1)
8. Focus on the selected node shows only nodes within N hops of it (default 1, range 1–3); clearing focus restores the view as it was before focusing. (v1)
9. At most 2,000 visible nodes are rendered; above that the canvas shows "Graph too large to render (N nodes). Narrow it with a filter." and renders nothing until a filter brings the count under the cap. (v1)
10. A workspace with no file in a supported language shows "No supported source files found" instead of an empty canvas. (v1)
11. Layout is automatic and positions are not saved; when the graph refreshes after re-indexing, expansion, filters, focus and selection are kept for nodes that still exist. (v1)
12. Selecting a node shows Kind, Name, Location and its incoming and outgoing edge counts by kind in the shell's Details region. (v1)

## Journeys
- **explore the graph** — developer opens the graph, expands files into their symbols and follows edges to understand structure. (v1)
- **find a symbol** — developer searches a name and lands on the matching node. (v1)
- **narrow a large graph** — developer uses toggles, a path glob or focus to make a big repo readable, and recovers from the size cap. (v1)

## Capabilities
- none yet

## Versions
- v1 — files-first structural graph with expand, unresolved edges, search, filters, focus and size cap — opened 2026-11-03
