//! The solver over hand-lowered functions (the data-flow scenario numbers).

use ir::flow::variable_key;
use ir::{
    solve, Binding, BlockKind, FlowBlock, FlowEvent, FlowFunction, LineRange, Picked, Pos, Role,
    Trace, TraceStatus,
};

struct F(FlowFunction);

impl F {
    /// `blocks`: `None` for entry/exit (by position: first is Entry, last is Exit).
    fn new(blocks: &[Option<(u32, u32)>], branches: &[(usize, usize)]) -> Self {
        let last = blocks.len() - 1;
        F(FlowFunction {
            qualified_name: "f".into(),
            blocks: blocks
                .iter()
                .enumerate()
                .map(|(i, l)| FlowBlock {
                    kind: match i {
                        0 => BlockKind::Entry,
                        _ if i == last => BlockKind::Exit,
                        _ => BlockKind::Basic,
                    },
                    lines: l.map(|(start, end)| LineRange { start, end }),
                    first_line: String::new(),
                })
                .collect(),
            branches: branches.to_vec(),
            bindings: Vec::new(),
            events: Vec::new(),
        })
    }

    fn bind(&mut self, name: &str, line: u32, character: u32) -> usize {
        self.0.bindings.push(Binding {
            name: name.into(),
            decl: Pos { line, character },
        });
        self.0.bindings.len() - 1
    }

    fn ev(&mut self, block: usize, binding: usize, role: Role, line: u32, character: u32) -> usize {
        self.0.events.push(FlowEvent {
            block,
            binding,
            role,
            pos: Pos { line, character },
            end_char: character + 1,
            capture: false,
        });
        self.0.events.len() - 1
    }

    fn def(&mut self, block: usize, b: usize, line: u32) -> usize {
        self.ev(block, b, Role::Def, line, 4)
    }

    fn use_(&mut self, block: usize, b: usize, line: u32) -> usize {
        self.ev(block, b, Role::Use, line, 4)
    }
}

/// Hops as `(def line, use line)`, in hop order.
fn hops(t: &Trace) -> Vec<(u32, u32)> {
    t.hops
        .iter()
        .enumerate()
        .map(|(k, h)| {
            assert_eq!(h.index, k + 1);
            (
                t.occurrences[h.def_ordinal].line,
                t.occurrences[h.use_ordinal].line,
            )
        })
        .collect()
}

/// `total := 0` (12); `for _, v := range xs {` (13); `total = total + v` (14);
/// `return total` (18). Returns the function, `total`'s first def and the use at 18.
fn accumulator() -> (F, usize, usize) {
    // b0 entry, b1 12, b2 13 (loop head), b3 14 (body), b4 18, b5 exit
    let mut f = F::new(
        &[
            None,
            Some((12, 12)),
            Some((13, 13)),
            Some((14, 14)),
            Some((18, 18)),
            None,
        ],
        &[(0, 1), (1, 2), (2, 3), (3, 2), (2, 4), (4, 5)],
    );
    let xs = f.bind("xs", 11, 10);
    let total = f.bind("total", 12, 1);
    let v = f.bind("v", 13, 8);
    f.def(0, xs, 11);
    let first = f.ev(1, total, Role::Def, 12, 1);
    f.use_(2, xs, 13);
    f.def(2, v, 13);
    f.ev(3, total, Role::Use, 14, 10);
    f.ev(3, total, Role::Def, 14, 2);
    f.use_(3, v, 14);
    let use18 = f.ev(4, total, Role::Use, 18, 8);
    (f, first, use18)
}

#[test]
fn loop_accumulator_gives_four_ordered_hops_with_back_edge() {
    let (f, _, use18) = accumulator();
    let t = solve(&f.0, Picked::Event(use18));
    assert_eq!(t.status, TraceStatus::Hops);
    assert_eq!(hops(&t), vec![(12, 14), (14, 14), (12, 18), (14, 18)]);
    let back: Vec<_> = t
        .branches
        .iter()
        .filter(|b| b.back_edge)
        .map(|b| (&*b.from, &*b.to))
        .collect();
    assert_eq!(back, vec![("b3", "b2")]);
    assert_eq!(t.variable, "total");
    assert_eq!(t.variable_key, "total#1");
    assert!(t.occurrences.iter().all(|o| o.line != 11 && o.line != 13));
}

#[test]
fn occurrence_ordinals_follow_source_order() {
    let (f, _, use18) = accumulator();
    let t = solve(&f.0, Picked::Event(use18));
    let pos: Vec<_> = t
        .occurrences
        .iter()
        .map(|o| (o.ordinal, o.line, o.start_char))
        .collect();
    assert_eq!(pos, vec![(0, 12, 1), (1, 14, 2), (2, 14, 10), (3, 18, 8)]);
    assert_eq!(t.occurrences[1].role, Role::Def);
    assert_eq!(t.occurrences[2].role, Role::Use);
}

#[test]
fn picked_def_starts_only_from_itself() {
    let (f, first, _) = accumulator();
    assert_eq!(
        hops(&solve(&f.0, Picked::Event(first))),
        vec![(12, 14), (12, 18)]
    );
}

#[test]
fn picked_binding_starts_from_every_def() {
    let (f, first, use18) = accumulator();
    let total = f.0.events[first].binding;
    assert_eq!(
        solve(&f.0, Picked::Binding(total)),
        solve(&f.0, Picked::Event(use18))
    );

    // One def reaching every use: the binding traces like that def.
    let mut g = F::new(&[None, Some((1, 3)), None], &[(0, 1), (1, 2)]);
    let a = g.bind("a", 1, 4);
    let d = g.def(1, a, 1);
    g.use_(1, a, 2);
    g.use_(1, a, 3);
    assert_eq!(
        solve(&g.0, Picked::Binding(a)),
        solve(&g.0, Picked::Event(d))
    );
}

#[test]
fn picked_def_is_the_only_start() {
    // 33 a := 1; 36 use a; 37 a = 5; 38 use a
    let mut f = F::new(&[None, Some((33, 38)), None], &[(0, 1), (1, 2)]);
    let a = f.bind("a", 33, 4);
    let d33 = f.def(1, a, 33);
    f.use_(1, a, 36);
    f.def(1, a, 37);
    f.use_(1, a, 38);
    let t = solve(&f.0, Picked::Event(d33));
    assert_eq!(hops(&t), vec![(33, 36)]);
    assert_eq!(t.occurrences.len(), 2);
}

#[test]
fn if_else_reaches_both_arms() {
    // b1 40-41 (v := ..; if), b2 43 then, b3 46 else, b4 join
    let mut f = F::new(
        &[
            None,
            Some((40, 41)),
            Some((43, 43)),
            Some((46, 46)),
            Some((48, 48)),
            None,
        ],
        &[(0, 1), (1, 2), (1, 3), (2, 4), (3, 4), (4, 5)],
    );
    let v = f.bind("v", 40, 4);
    let d = f.def(1, v, 40);
    f.use_(2, v, 43);
    f.use_(3, v, 46);
    let t = solve(&f.0, Picked::Event(d));
    assert_eq!(hops(&t), vec![(40, 43), (40, 46)]);
    assert!(t.branches.iter().all(|b| !b.back_edge));
}

#[test]
fn redefinition_cuts_the_earlier_def() {
    let mut f = F::new(&[None, Some((50, 54)), None], &[(0, 1), (1, 2)]);
    let x = f.bind("x", 50, 4);
    f.def(1, x, 50);
    f.def(1, x, 52);
    let u = f.use_(1, x, 54);
    let t = solve(&f.0, Picked::Event(u));
    assert_eq!(hops(&t), vec![(52, 54)]);
    assert!(t.occurrences.iter().all(|o| o.line != 50));
}

#[test]
fn other_variables_never_appear() {
    // 60 x := 1; 61 y := x + 1; 62 use y
    let mut f = F::new(&[None, Some((60, 62)), None], &[(0, 1), (1, 2)]);
    let x = f.bind("x", 60, 4);
    let y = f.bind("y", 61, 4);
    let dx = f.def(1, x, 60);
    f.ev(1, x, Role::Use, 61, 9);
    f.def(1, y, 61);
    f.use_(1, y, 62);
    let t = solve(&f.0, Picked::Event(dx));
    assert_eq!(hops(&t), vec![(60, 61)]);
    assert_eq!(t.occurrences.len(), 2);
}

#[test]
fn shadowing_binding_is_excluded_and_keyed_second() {
    // 70 i := 0; 72 i := 5 (inner scope); 73 use inner i; 75 use outer i
    let mut f = F::new(&[None, Some((70, 75)), None], &[(0, 1), (1, 2)]);
    let outer = f.bind("i", 70, 4);
    let inner = f.bind("i", 72, 8);
    let d = f.def(1, outer, 70);
    f.def(1, inner, 72);
    f.use_(1, inner, 73);
    f.use_(1, outer, 75);
    let t = solve(&f.0, Picked::Event(d));
    assert_eq!(hops(&t), vec![(70, 75)]);
    assert_eq!(t.variable_key, "i#1");
    assert_eq!(variable_key(&f.0, inner), "i#2");
    assert_eq!(solve(&f.0, Picked::Binding(inner)).variable_key, "i#2");
}

#[test]
fn capture_is_one_use() {
    let mut f = F::new(&[None, Some((80, 82)), None], &[(0, 1), (1, 2)]);
    let n = f.bind("n", 80, 4);
    let d = f.def(1, n, 80);
    let c = f.use_(1, n, 81);
    f.0.events[c].capture = true;
    let t = solve(&f.0, Picked::Event(d));
    assert_eq!(hops(&t), vec![(80, 81)]);
    assert!(t.occurrences[1].capture);
}

#[test]
fn unused_def_gives_no_uses_with_only_defs() {
    let mut f = F::new(&[None, Some((90, 92)), None], &[(0, 1), (1, 2)]);
    let u = f.bind("unused", 90, 4);
    let d = f.def(1, u, 90);
    f.def(1, u, 92);
    let t = solve(&f.0, Picked::Binding(u));
    assert_eq!(t.status, TraceStatus::NoUses);
    assert!(t.hops.is_empty());
    assert_eq!(t.occurrences.len(), 2);
    assert!(t.occurrences.iter().all(|o| o.role == Role::Def));
    assert_eq!(solve(&f.0, Picked::Event(d)).occurrences.len(), 1);
}

#[test]
fn read_with_no_def_gives_no_reaching_def_with_one_occurrence() {
    // Java `int n;` then `n + 1`
    let mut f = F::new(&[None, Some((100, 101)), None], &[(0, 1), (1, 2)]);
    let n = f.bind("n", 100, 8);
    let u = f.use_(1, n, 101);
    f.use_(1, n, 102);
    let t = solve(&f.0, Picked::Event(u));
    assert_eq!(t.status, TraceStatus::NoReachingDef);
    assert_eq!(t.occurrences.len(), 1);
    assert_eq!(t.occurrences[0].line, 101);
    assert!(t.hops.is_empty());
    assert_eq!(
        solve(&f.0, Picked::Binding(n)).status,
        TraceStatus::NoReachingDef
    );
}

#[test]
fn parameter_def_in_entry_reaches_its_uses() {
    let mut f = F::new(&[None, Some((111, 112)), None], &[(0, 1), (1, 2)]);
    let p = f.bind("p", 110, 10);
    f.def(0, p, 110);
    let u = f.use_(1, p, 112);
    let t = solve(&f.0, Picked::Event(u));
    assert_eq!(hops(&t), vec![(110, 112)]);
    assert_eq!(t.occurrences[0].block, "b0");
    assert_eq!(t.blocks[0].start_line, None);
}

#[test]
fn trace_serializes_with_data_model_names() {
    let mut f = F::new(&[None, Some((100, 101)), None], &[(0, 1), (1, 2)]);
    let n = f.bind("n", 100, 8);
    let u = f.use_(1, n, 101);
    let v = serde_json::to_value(solve(&f.0, Picked::Event(u))).unwrap();
    assert_eq!(v["status"], "noReachingDef");
    assert_eq!(v["variableKey"], "n#1");
    assert_eq!(v["functionName"], "f");
    assert_eq!(v["blocks"][0]["kind"], "entry");
    assert_eq!(v["blocks"][1]["startLine"], 100);
    assert_eq!(v["blocks"][1]["endLine"], 101);
    assert!(v["blocks"][1].get("firstLine").is_some());
    assert_eq!(v["branches"][0]["backEdge"], false);
    let o = &v["occurrences"][0];
    assert_eq!(o["role"], "use");
    assert_eq!(o["startChar"], 4);
    assert_eq!(o["endChar"], 5);
    assert_eq!(o["block"], "b1");
    assert_eq!(o["capture"], false);

    let (f, _, use18) = accumulator();
    let v = serde_json::to_value(solve(&f.0, Picked::Event(use18))).unwrap();
    assert_eq!(v["status"], "hops");
    assert_eq!(
        v["hops"][0],
        serde_json::json!({"index": 1, "defOrdinal": 0, "useOrdinal": 2})
    );
}
