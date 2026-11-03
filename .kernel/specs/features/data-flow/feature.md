---
title: Data Flow
type: feature
created: 2026-11-03
version: 1
released: 0
---

# Feature: Data Flow

## Intent
Pick a variable or parameter inside a function and see its intra-procedural flow (defs to uses along the CFG) highlighted on the graph and stepped through one hop at a time, so a developer can answer "where does this value come from and where does it go inside this function" visually instead of by reading.

## Actors
- **developer** — wants to put the cursor on a variable, see every definition that reaches it and every read it reaches, and walk that flow hop by hop between the graph and the editor.

## Scope
**In**
- Command `Code Matrix: Trace Data Flow` on the identifier under the editor cursor
- The traced function unfolded into its CFG (basic blocks, branch edges) in the graph canvas
- Backward (reaching defs) and forward (reached uses) flow for one variable in one function
- Hop stepping with Next/Prev and arrow keys; editor decoration of the trace and the current hop
- Degenerate traces (no reached use, no reaching def) shown with a note
- Trace recompute after re-indexing; clear and replace
- Captures by lambdas and nested functions counted as a use at the capture site

**Out**
- Inter-procedural flow (across call boundaries)
- Following flow into other variables (`y = x + 1` does not continue to `y`)
- Fields, globals, imports and module-level variables
- Flow inside lambdas, closures or nested functions
- Picking a variable from the graph (code-graph has no variable nodes)
- Browsing a function's CFG without an active trace
- Editor-cursor → graph-node sync (`app-shell`)
- Graph rendering, layout and filters (`code-graph`); indexing and progress (`workspace-index`)

## Rules
1. `Code Matrix: Trace Data Flow` traces the identifier under the editor cursor when it is a parameter or local variable of the enclosing function; the graph panel opens, or is focused, as `Open Graph` would, with the trace active. (v1)
2. With the cursor on no identifier, the command shows "Place the cursor on a variable or parameter" and changes nothing. (v1)
3. With the cursor on an identifier that is not a parameter or local variable of the enclosing function (a field, global, import, function name or keyword), the command shows "`<name>` is not a local variable or parameter of `<fn>`"; with the cursor outside any function body it shows "`<name>` is not inside a function". In both cases nothing changes and an active trace is kept. (v1)
4. A trace is for exactly one variable in one function: the defs of that variable that reach the picked occurrence (the picked occurrence itself, if it is a def), plus every use those defs reach, computed along the function's CFG. Flow never crosses a call boundary and is never followed into another variable. The variable is the binding the picked occurrence resolves to; a same-named variable in another scope is a different variable. (v1)
5. A hop is one def→use link: a def in the trace and a use it reaches along the CFG with no redefinition of the variable in between. A def may reach a use earlier in the source through a loop back-edge; such hops are included. Hops are ordered by the source position of the use, then of the def. (v1)
6. On trace start the traced function's node unfolds into its CFG: one node per basic block with branch edges, in place of the function node; the containing file is expanded first if it was collapsed. Blocks holding a def or use of the trace are highlighted and the block of the current hop's use is marked as current. All other graph nodes stay as they were. (v1)
7. The canvas shows a trace bar with "Prev", "Next", "Clear trace" and the status "Hop N of M: `<x>` defined at line A → used at line B". Next and Prev, and the right and left arrow keys while the graph panel has focus, move the current hop. Every def and use of the trace is decorated in the editor; the current hop's def and use are decorated distinctly and the use is revealed in an editor beside the graph. (v1)
8. Next on the last hop and Prev on the first hop are disabled; the hop order does not wrap. (v1)
9. A trace whose defs reach no use shows the defs highlighted, the step controls disabled and the status "No uses of `<x>` in `<fn>`". A picked read with no reaching def shows the read highlighted, the step controls disabled and the status "No definition of `<x>` reaches this read". A parameter is defined at its declaration, in the function's entry block. (v1)
10. A read of the variable inside a lambda, closure or nested function defined within the traced function counts as one use at the capture site; flow inside it is not followed. (v1)
11. At most one trace is active at a time; running `Trace Data Flow` again replaces the active trace. (v1)
12. Escape while the graph panel has focus, or "Clear trace", ends the trace: highlights, the trace bar and editor decorations are removed, and the CFG folds back into the function node. (v1)
13. Selecting another graph node while a trace is active keeps the trace; the Details region shows the selected node as usual. (v1)
14. When the graph refreshes after re-indexing while a trace is active: if the function still exists, the trace is recomputed for the same variable, keeping the current hop if a hop with the same def and use lines still exists, else hop 1; if the function is gone the trace is cleared with "Trace cleared: `<fn>` no longer exists", and if the variable is gone with "Trace cleared: `<x>` no longer exists in `<fn>`". (v1)
15. For a language whose frontend provides no CFG or def-use, the command shows "Data flow is not supported for <language> yet" and changes nothing. (v1)

## Journeys
- **trace a variable** — developer puts the cursor on a variable or parameter, runs `Trace Data Flow`, and sees its defs and uses on the function's CFG, or a clear reason why not. (v1)
- **step through the flow** — developer walks the trace hop by hop, each hop revealed in the editor beside the graph. (v1)
- **end or lose a trace** — developer clears the trace, replaces it with another, or the code changes under it. (v1)

## Capabilities
- none yet

## Open Questions
- What happens when `Trace Data Flow` runs on a file that is not indexed yet (sidecar still starting, or indexing in progress)? Deferred to `workspace-index`, which is still a stub; no scenario is written for it.

## Versions
- v1 — trace one variable's intra-procedural flow on the function's CFG with hop stepping, editor marks, degenerate cases and lifecycle — opened 2026-11-03
