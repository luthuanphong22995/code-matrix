//! Python data-flow lowering through `Frontend::lower`, solved by `ir::flow::solve`.

use std::fs;
use std::path::{Path, PathBuf};

use frontend_python::PythonFrontend;
use ir::{
    solve, BlockKind, FlowError, Frontend, Locate, Lowered, Picked, Pos, Role, Trace, TraceStatus,
};

fn dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/flow")
}

fn fixture(name: &str) -> String {
    fs::read_to_string(dir().join(name)).unwrap()
}

fn lower(source: &str, at: Locate) -> Result<Lowered, FlowError> {
    PythonFrontend.lower("x.py", source, at).unwrap()
}

/// The `nth` (0-based) whole-word `word` on 1-based `line`; ASCII lines only.
fn at(source: &str, line: u32, word: &str, nth: usize) -> Locate {
    let text = source.lines().nth(line as usize - 1).unwrap();
    let is_word = |c: char| c.is_alphanumeric() || c == '_';
    let character = text
        .match_indices(word)
        .filter(|&(i, _)| {
            !text[..i].ends_with(is_word) && !text[i + word.len()..].starts_with(is_word)
        })
        .nth(nth)
        .unwrap()
        .0 as u32;
    Locate::At(Pos { line, character })
}

fn trace(source: &str, at: Locate) -> Trace {
    let l = lower(source, at).unwrap();
    solve(&l.function, l.picked)
}

/// Hops as `(def line, use line)`, in hop order.
fn hops(t: &Trace) -> Vec<(u32, u32)> {
    t.hops
        .iter()
        .map(|h| {
            (
                t.occurrences[h.def_ordinal].line,
                t.occurrences[h.use_ordinal].line,
            )
        })
        .collect()
}

fn not_local(name: &str, function: &str) -> Result<Lowered, FlowError> {
    Err(FlowError::NotLocal {
        name: name.into(),
        function: function.into(),
    })
}

#[test]
fn lowering_snapshots() {
    for (file, line, word) in [
        ("config.py", 5, "total"),
        ("server.py", 2, "code"),
        ("serve.py", 2, "limit"),
        ("scope.py", 11, "total"),
        ("store.py", 4, "self"),
        ("control.py", 2, "n"),
    ] {
        let src = fixture(file);
        let lowered = lower(&src, at(&src, line, word, 0)).unwrap();
        insta::assert_debug_snapshot!(lowered.function.qualified_name.clone(), lowered);
    }
}

#[test]
fn loop_accumulator_from_the_read() {
    let src = fixture("config.py");
    let t = trace(&src, at(&src, 10, "total", 0));
    assert_eq!(t.status, TraceStatus::Hops);
    assert_eq!(hops(&t), vec![(5, 7), (7, 7), (5, 10), (7, 10)]);
    assert!(t.branches.iter().any(|b| b.back_edge));
    assert_eq!(t.function_name, "parse_config");
}

#[test]
fn picked_def_is_the_sole_start() {
    let src = fixture("config.py");
    let t = trace(&src, at(&src, 5, "total", 0));
    assert_eq!(hops(&t), vec![(5, 7), (5, 10)]);
}

#[test]
fn parameter_def_is_in_entry() {
    let src = fixture("config.py");
    let l = lower(&src, at(&src, 4, "path", 0)).unwrap();
    let Picked::Event(e) = l.picked else {
        panic!("expected an event")
    };
    assert_eq!(
        l.function.blocks[l.function.events[e].block].kind,
        BlockKind::Entry
    );
    let t = solve(&l.function, l.picked);
    assert_eq!(hops(&t), vec![(4, 6), (4, 11)]);
}

#[test]
fn unused_has_no_uses() {
    let src = fixture("config.py");
    assert_eq!(
        trace(&src, at(&src, 8, "unused", 0)).status,
        TraceStatus::NoUses
    );
}

#[test]
fn scenario_hops() {
    let cases = [
        ("server.py", 2, "code", 0, vec![(2, 4), (2, 6)]),
        (
            "server.py",
            14,
            "status",
            0,
            vec![(9, 14), (11, 14), (13, 14)],
        ),
        (
            "serve.py",
            2,
            "limit",
            0,
            vec![(2, 3), (2, 4), (2, 5), (2, 7)],
        ),
        ("serve.py", 1, "items", 0, vec![(1, 3)]),
        ("scope.py", 11, "total", 0, vec![(11, 12), (11, 16)]),
        ("store.py", 4, "self", 0, vec![(4, 5), (4, 6)]),
        ("control.py", 17, "n", 0, vec![(17, 20), (17, 24)]),
        ("control.py", 11, "err", 0, vec![(11, 12)]),
        ("control.py", 20, "fh", 0, vec![(20, 22)]),
        ("control.py", 22, "m", 0, vec![(22, 23)]),
        ("control.py", 1, "mode", 0, vec![(1, 15)]),
    ];
    for (file, line, word, nth, want) in cases {
        let src = fixture(file);
        let t = trace(&src, at(&src, line, word, nth));
        assert_eq!(hops(&t), want, "{file}:{line} {word}");
    }
}

#[test]
fn captures() {
    let src = fixture("serve.py");
    let t = trace(&src, at(&src, 2, "limit", 0));
    for line in [3, 4, 5] {
        let caps: Vec<_> = t.occurrences.iter().filter(|o| o.line == line).collect();
        assert_eq!(caps.len(), 1, "line {line}");
        assert!(caps[0].capture, "line {line}");
    }
    assert!(t.occurrences.iter().all(|o| o.line != 6));
    // `[x for x in items if x < limit]`: the capture spans the `[`.
    let c = t.occurrences.iter().find(|o| o.line == 3).unwrap();
    assert_eq!((c.start_char, c.end_char), (9, 10));

    let t = trace(&src, at(&src, 1, "items", 0));
    assert!(t.occurrences.iter().any(|o| o.line == 3 && o.capture));

    // A reference inside a lambda picks its capture.
    let l = lower(&src, at(&src, 4, "limit", 0)).unwrap();
    let Picked::Event(e) = l.picked else {
        panic!("expected an event")
    };
    let ev = &l.function.events[e];
    assert!(ev.capture);
    assert_eq!(
        ev.pos,
        Pos {
            line: 4,
            character: 8
        }
    );

    let src = fixture("scope.py");
    let t = trace(&src, at(&src, 11, "total", 0));
    assert!(t.occurrences.iter().any(|o| o.line == 12 && o.capture));
}

#[test]
fn control_flow() {
    let src = fixture("control.py");
    let t = trace(&src, at(&src, 14, "n", 0));
    let mut defs: Vec<u32> = hops(&t)
        .into_iter()
        .filter(|&(_, u)| u == 14)
        .map(|(d, _)| d)
        .collect();
    defs.sort_unstable();
    defs.dedup();
    assert_eq!(defs, vec![2, 6, 8, 10]);

    let l = lower(&src, at(&src, 6, "n", 0)).unwrap();
    let Picked::Event(e) = l.picked else {
        panic!("expected an event")
    };
    assert_eq!(l.function.events[e].role, Role::Def);

    assert_eq!(
        trace(&src, at(&src, 21, "os", 0)).status,
        TraceStatus::NoUses
    );
}

#[test]
fn refusals() {
    let src = fixture("config.py");
    assert_eq!(
        lower(&src, at(&src, 6, "open", 0)),
        not_local("open", "parse_config")
    );
    assert_eq!(
        lower(&src, at(&src, 8, "DEFAULT_PATH", 0)),
        not_local("DEFAULT_PATH", "parse_config")
    );
    assert_eq!(
        lower(&src, at(&src, 1, "DEFAULT_PATH", 0)),
        Err(FlowError::NotInFunction {
            name: "DEFAULT_PATH".into()
        })
    );
    assert_eq!(
        lower(
            &src,
            Locate::At(Pos {
                line: 5,
                character: 0
            })
        ),
        Err(FlowError::NoIdentifier)
    );
    // An identifier may end exactly at the position.
    assert!(lower(
        &src,
        Locate::At(Pos {
            line: 5,
            character: 9
        })
    )
    .is_ok());
    assert_eq!(
        lower(
            "",
            Locate::At(Pos {
                line: 1,
                character: 0
            })
        ),
        Err(FlowError::NoIdentifier)
    );

    let src = fixture("scope.py");
    assert_eq!(
        lower(&src, at(&src, 6, "counter", 0)),
        not_local("counter", "bump")
    );
    assert_eq!(
        lower(&src, at(&src, 14, "total", 0)),
        not_local("total", "outer.add")
    );

    let src = fixture("serve.py");
    assert_eq!(
        lower(&src, at(&src, 6, "limit", 0)),
        not_local("limit", "serve.inner")
    );
    assert_eq!(lower(&src, at(&src, 3, "x", 0)), not_local("x", "serve"));
    assert_eq!(
        lower(&src, at(&src, 5, "inner", 0)),
        not_local("inner", "serve")
    );

    let src = fixture("store.py");
    assert_eq!(
        lower(&src, at(&src, 5, "items", 0)),
        not_local("items", "Store.save")
    );
    assert_eq!(
        lower(&src, at(&src, 2, "limit", 0)),
        Err(FlowError::NotInFunction {
            name: "limit".into()
        })
    );
}

#[test]
fn method_name_matches_extract() {
    let src = fixture("store.py");
    let def = PythonFrontend
        .extract("store.py", &src)
        .unwrap()
        .defs
        .into_iter()
        .find(|d| d.qualified_name.ends_with("save"))
        .unwrap();
    let l = lower(&src, at(&src, 4, "self", 0)).unwrap();
    assert_eq!(l.function.qualified_name, def.qualified_name);
    assert_eq!(l.function.qualified_name, "Store.save");
}

#[test]
fn read_before_assignment_has_no_reaching_def() {
    let src = "def f():\n    print(x)\n    x = 1\n";
    assert_eq!(
        trace(src, at(src, 2, "x", 0)).status,
        TraceStatus::NoReachingDef
    );
}

#[test]
fn raise_leaves_the_function() {
    let src = "def f(c):\n    x = 1\n    if c:\n        x = 2\n        raise E\n    return x\n";
    assert_eq!(hops(&trace(src, at(src, 6, "x", 0))), vec![(2, 6)]);
}

#[test]
fn positions_are_utf16() {
    let src = "def f():\n    s = \"h\u{e9}\u{1F600}\"; t = s\n    return t\n";
    // `    s = "hé😀"; t = s`: é is 1 unit, 😀 is 2, so the last `s` is at 20.
    let l = lower(
        src,
        Locate::At(Pos {
            line: 2,
            character: 20,
        }),
    )
    .unwrap();
    let Picked::Event(e) = l.picked else {
        panic!("expected an event")
    };
    let ev = &l.function.events[e];
    assert_eq!(l.function.bindings[ev.binding].name, "s");
    assert_eq!((ev.pos.character, ev.end_char), (20, 21));
    let t = l.function.bindings.iter().find(|b| b.name == "t").unwrap();
    assert_eq!(
        t.decl,
        Pos {
            line: 2,
            character: 16
        }
    );
}

fn retrace(source: &str, function: &str, key: &str) -> Result<Lowered, FlowError> {
    lower(
        source,
        Locate::Function {
            qualified_name: function.into(),
            variable_key: key.into(),
        },
    )
}

#[test]
fn retrace_by_function_and_key() {
    let src = fixture("config.py");
    let l = retrace(&src, "parse_config", "total#1").unwrap();
    assert!(matches!(l.picked, Picked::Binding(_)));
    assert_eq!(solve(&l.function, l.picked).hops.len(), 4);
    assert_eq!(
        retrace(&src, "nope", "total#1"),
        Err(FlowError::FunctionGone)
    );
    assert_eq!(
        retrace(&src, "parse_config", "total#2"),
        Err(FlowError::VariableGone)
    );
}

#[test]
fn lower_is_pure() {
    let src = fixture("control.py");
    assert_eq!(
        lower(&src, at(&src, 24, "n", 0)),
        lower(&src, at(&src, 24, "n", 0))
    );
}
