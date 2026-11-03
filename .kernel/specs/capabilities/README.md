# Capabilities

Durable, code-derived records of what the system *does* — one document per system
capability, at `capabilities/<id>/spec.md`. `<id>` may be nested by service in a
multi-service repo (e.g. `capabilities/billing/invoicing/spec.md`). This is the
source of truth for the workflow.

Each capability is a **code-anchored index**, not a prose re-description of behavior:
- `Purpose:` — one line, what the system does.
- `Code:` — the real files/functions/endpoints that implement it (what readers open for truth).
  Name the symbols in the note — `src/auth/login.go (Login, Session.Refresh)` — rather
  than hand-written line ranges: `sdlc caps code` resolves them to their current lines,
  and `sdlc caps verify` fails when one disappears. Any other note is free text.
- `Invariants:` — one-line rules that must hold, each checkable against the anchored code.

No WHEN/THEN scenarios, no `### Requirement:` blocks, in `spec.md` itself. Capabilities
are referenced from a change's `proposal.md` Capabilities section and merged here when
`/build:change` closes out the change (`sdlc caps sync`).

A capability directory may also hold an optional `scenarios.md`, sibling to `spec.md`,
written by `/check:test --scenarios-only` and consumed by `/check:test` — a reviewable, user-editable
staging area for test scenarios derived from `Invariants:`. It's the one exception to
"no scenario docs" in this tree, scoped narrowly to test planning; it never substitutes
for `Code:`/`Invariants:` as the source of truth.

## Multi-service layout (convention)

In a multi-service repo, nest capabilities by service: `capabilities/<service>/<cap>/spec.md`
(e.g. `capabilities/billing/invoicing/spec.md`). `sdlc caps list <service>` scopes to one.

Give each service a `capabilities/<service>/OVERVIEW.md` for its local intent
(purpose, service-local conventions, internal architecture), and declare its
upstreams on one line:

```
DependsOn: auth, ledger
```

Keep the root `.kernel/specs/OVERVIEW.md` global-only (system purpose, global conventions,
glossary) — no per-service map. The service map and cross-service edges are
*derived* from the distributed `DependsOn:` lines, never stored as a file, so
context stays scoped to the service you're touching and its neighbors (see plan
§7d / M8). Lay this convention down from the first service and it derives later
with no migration.

There is no static catalog file. Query the corpus with the `sdlc caps` commands
instead of reading service source directly:
- `sdlc caps list [service]` — the live index (`id — purpose`), optionally one service.
- `sdlc caps services` — list services (multi-service repos; none in a single-app repo).
- `sdlc caps deps <service>` — a service's cross-service edges (its `DependsOn:` + who depends on it).
  Add `--depth N` to follow those edges transitively; each result then carries its hop count.
- `sdlc caps impact <path>` — blast radius of a code path: the capabilities anchored to it,
  their services, and the services that depend on those (`--depth N` to go further out).
- `sdlc caps find <keyword>` — search purpose + invariants.
- `sdlc caps owner <path>` — which capability owns a code path.
- `sdlc caps show <id>` — a capability's full Purpose/Code/Invariants.
- `sdlc caps code <id> [<change>]` — just the code its anchors name (symbols at their current
  lines), instead of whole files.
- `sdlc caps dup <change>` / `sdlc caps scan` — duplication checks.
- `sdlc caps verify` — every `Code:` anchor's file and named symbols still exist (CI gate).
