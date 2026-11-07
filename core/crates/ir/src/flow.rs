//! Intra-procedural data flow: the lowering a frontend produces for one function, and the
//! reaching-definitions solver that turns it into the trace of one binding.

use std::collections::BTreeSet;

use serde::Serialize;

use crate::LineRange;

/// A source position: 1-based line, 0-based UTF-16 character (as VS Code counts).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Pos {
    pub line: u32,
    pub character: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum BlockKind {
    Entry,
    Exit,
    Basic,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FlowBlock {
    pub kind: BlockKind,
    /// `None` for entry and exit.
    pub lines: Option<LineRange>,
    /// Trimmed source of the block's first line.
    pub first_line: String,
}

/// One variable binding: a parameter or declaration scope of a name.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Binding {
    pub name: String,
    pub decl: Pos,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    Def,
    Use,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FlowEvent {
    /// Index into `FlowFunction::blocks`.
    pub block: usize,
    /// Index into `FlowFunction::bindings`.
    pub binding: usize,
    pub role: Role,
    pub pos: Pos,
    pub end_char: u32,
    /// A lambda / nested-function capture site; counts as one use.
    pub capture: bool,
}

/// One function lowered for the solver. Within a block, `events` are in evaluation order
/// (`x = x + 1` lowers to the use, then the def).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FlowFunction {
    pub qualified_name: String,
    pub blocks: Vec<FlowBlock>,
    /// `(from, to)` block indices.
    pub branches: Vec<(usize, usize)>,
    pub bindings: Vec<Binding>,
    pub events: Vec<FlowEvent>,
}

/// What to trace: one event (a trace from the editor) or a whole binding (a retrace).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Picked {
    Event(usize),
    Binding(usize),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum TraceStatus {
    Hops,
    NoUses,
    NoReachingDef,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TraceBlock {
    pub id: String,
    pub kind: BlockKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start_line: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_line: Option<u32>,
    pub first_line: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TraceBranch {
    pub from: String,
    pub to: String,
    pub back_edge: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Occurrence {
    pub ordinal: usize,
    pub role: Role,
    pub block: String,
    pub line: u32,
    pub start_char: u32,
    pub end_char: u32,
    pub capture: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Hop {
    pub index: usize,
    pub def_ordinal: usize,
    pub use_ordinal: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Trace {
    pub function_name: String,
    pub variable: String,
    pub variable_key: String,
    pub status: TraceStatus,
    pub blocks: Vec<TraceBlock>,
    pub branches: Vec<TraceBranch>,
    pub occurrences: Vec<Occurrence>,
    pub hops: Vec<Hop>,
}

/// `<name>#<n>`: n is the 1-based rank of `binding` among same-named bindings by `decl`.
pub fn variable_key(f: &FlowFunction, binding: usize) -> String {
    let b = &f.bindings[binding];
    let n = f
        .bindings
        .iter()
        .enumerate()
        .filter(|(i, o)| o.name == b.name && (o.decl, *i) <= (b.decl, binding))
        .count();
    format!("{}#{n}", b.name)
}

/// For each branch, whether its target is on the DFS stack from `Entry` when followed.
fn back_edges(f: &FlowFunction) -> Vec<bool> {
    let n = f.blocks.len();
    let mut out: Vec<Vec<usize>> = vec![Vec::new(); n];
    for (j, &(from, _)) in f.branches.iter().enumerate() {
        out[from].push(j);
    }
    let mut back = vec![false; f.branches.len()];
    let Some(entry) = f.blocks.iter().position(|b| b.kind == BlockKind::Entry) else {
        return back;
    };
    let mut visited = vec![false; n];
    let mut on_stack = vec![false; n];
    // (block, next outgoing branch to follow)
    let mut stack = vec![(entry, 0usize)];
    visited[entry] = true;
    on_stack[entry] = true;
    while let Some(top) = stack.last_mut() {
        let (node, next) = *top;
        if let Some(&j) = out[node].get(next) {
            top.1 += 1;
            let to = f.branches[j].1;
            if on_stack[to] {
                back[j] = true;
            } else if !visited[to] {
                visited[to] = true;
                on_stack[to] = true;
                stack.push((to, 0));
            }
        } else {
            on_stack[node] = false;
            stack.pop();
        }
    }
    back
}

/// For every use event of `binding`, the def events of `binding` reaching it.
fn reaching(f: &FlowFunction, binding: usize) -> Vec<BTreeSet<usize>> {
    let n = f.blocks.len();
    let mut per_block: Vec<Vec<usize>> = vec![Vec::new(); n];
    for (i, e) in f.events.iter().enumerate() {
        if e.binding == binding {
            per_block[e.block].push(i);
        }
    }
    // gen = last def in the block; a block with any def kills every other def.
    let gen: Vec<Option<usize>> = per_block
        .iter()
        .map(|evs| {
            evs.iter()
                .rev()
                .copied()
                .find(|&i| f.events[i].role == Role::Def)
        })
        .collect();
    let mut preds: Vec<Vec<usize>> = vec![Vec::new(); n];
    for &(from, to) in &f.branches {
        preds[to].push(from);
    }
    let mut outs: Vec<BTreeSet<usize>> = vec![BTreeSet::new(); n];
    let ins = |outs: &[BTreeSet<usize>], b: usize| -> BTreeSet<usize> {
        preds[b]
            .iter()
            .flat_map(|&p| outs[p].iter().copied())
            .collect()
    };
    let mut changed = true;
    while changed {
        changed = false;
        for b in 0..n {
            let new = match gen[b] {
                Some(d) => BTreeSet::from([d]),
                None => ins(&outs, b),
            };
            if new != outs[b] {
                outs[b] = new;
                changed = true;
            }
        }
    }
    let mut reach = vec![BTreeSet::new(); f.events.len()];
    for (b, evs) in per_block.iter().enumerate() {
        let mut cur = ins(&outs, b);
        for &i in evs {
            match f.events[i].role {
                Role::Use => reach[i] = cur.clone(),
                Role::Def => cur = BTreeSet::from([i]),
            }
        }
    }
    reach
}

/// The trace of the picked binding. Pure: reads only that binding's events.
pub fn solve(f: &FlowFunction, picked: Picked) -> Trace {
    let binding = match picked {
        Picked::Event(i) => f.events[i].binding,
        Picked::Binding(b) => b,
    };
    let reach = reaching(f, binding);
    let of_binding = |role| {
        (0..f.events.len())
            .filter(move |&i| f.events[i].binding == binding && f.events[i].role == role)
    };

    // A binding with no def retraces as its first use, so it keeps `NoReachingDef`.
    let picked = match picked {
        Picked::Binding(_) if of_binding(Role::Def).next().is_none() => {
            of_binding(Role::Use).next().map_or(picked, Picked::Event)
        }
        p => p,
    };
    let start: BTreeSet<usize> = match picked {
        Picked::Event(i) if f.events[i].role == Role::Def => BTreeSet::from([i]),
        Picked::Event(i) => reach[i].clone(),
        Picked::Binding(_) => of_binding(Role::Def).collect(),
    };

    let mut pairs: Vec<(usize, usize)> = Vec::new();
    for u in of_binding(Role::Use) {
        pairs.extend(reach[u].intersection(&start).map(|&d| (d, u)));
    }
    let status = match picked {
        Picked::Event(i) if f.events[i].role == Role::Use && start.is_empty() => {
            TraceStatus::NoReachingDef
        }
        _ if pairs.is_empty() => TraceStatus::NoUses,
        _ => TraceStatus::Hops,
    };

    let mut members: Vec<usize> = match (status, picked) {
        (TraceStatus::NoReachingDef, Picked::Event(i)) => vec![i],
        _ => start
            .iter()
            .copied()
            .chain(pairs.iter().map(|&(_, u)| u))
            .collect(),
    };
    members.sort_by_key(|&i| (f.events[i].pos, i));
    members.dedup();
    let ordinal = |e: usize| members.iter().position(|&m| m == e).expect("member");

    let mut hops: Vec<(usize, usize)> = pairs
        .iter()
        .map(|&(d, u)| (ordinal(u), ordinal(d)))
        .collect();
    hops.sort_unstable();
    let block_id = |b: usize| format!("b{b}");
    let back = back_edges(f);
    let b = &f.bindings[binding];

    Trace {
        function_name: f.qualified_name.clone(),
        variable: b.name.clone(),
        variable_key: variable_key(f, binding),
        status,
        blocks: f
            .blocks
            .iter()
            .enumerate()
            .map(|(i, blk)| TraceBlock {
                id: block_id(i),
                kind: blk.kind,
                start_line: blk.lines.map(|r| r.start),
                end_line: blk.lines.map(|r| r.end),
                first_line: blk.first_line.clone(),
            })
            .collect(),
        branches: f
            .branches
            .iter()
            .zip(back)
            .map(|(&(from, to), back_edge)| TraceBranch {
                from: block_id(from),
                to: block_id(to),
                back_edge,
            })
            .collect(),
        occurrences: members
            .iter()
            .enumerate()
            .map(|(ordinal, &i)| {
                let e = &f.events[i];
                Occurrence {
                    ordinal,
                    role: e.role,
                    block: block_id(e.block),
                    line: e.pos.line,
                    start_char: e.pos.character,
                    end_char: e.end_char,
                    capture: e.capture,
                }
            })
            .collect(),
        hops: hops
            .into_iter()
            .enumerate()
            .map(|(k, (use_ordinal, def_ordinal))| Hop {
                index: k + 1,
                def_ordinal,
                use_ordinal,
            })
            .collect(),
    }
}
