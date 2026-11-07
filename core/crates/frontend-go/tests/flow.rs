//! Go data-flow lowering through `Frontend::lower`, solved by `ir::flow::solve`.

use std::fs;
use std::path::{Path, PathBuf};

use frontend_go::GoFrontend;
use ir::{solve, BlockKind, FlowError, Frontend, Locate, Lowered, Picked, Pos, Trace, TraceStatus};

fn dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/flow")
}

fn fixture(name: &str) -> String {
    fs::read_to_string(dir().join(name)).unwrap()
}

fn lower(source: &str, at: Locate) -> Result<Lowered, FlowError> {
    GoFrontend::new(dir()).lower("x.go", source, at).unwrap()
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

#[test]
fn lowering_snapshots() {
    for (file, line, word) in [
        ("config.go", 12, "total"),
        ("server.go", 30, "status"),
        ("calc.go", 50, "v"),
        ("sum.go", 60, "acc"),
        ("run.go", 79, "i"),
        ("serve.go", 90, "limit"),
    ] {
        let src = fixture(file);
        let lowered = lower(&src, at(&src, line, word, 0)).unwrap();
        insta::assert_debug_snapshot!(lowered.function.qualified_name.clone(), lowered);
    }
}

#[test]
fn loop_accumulator_from_the_read() {
    let src = fixture("config.go");
    let t = trace(&src, at(&src, 18, "total", 0));
    assert_eq!(t.status, TraceStatus::Hops);
    assert_eq!(hops(&t), vec![(12, 14), (14, 14), (12, 18), (14, 18)]);
    assert!(t.branches.iter().any(|b| b.back_edge));
    assert_eq!(t.function_name, "parseConfig");
}

#[test]
fn picked_def_is_the_sole_start() {
    let src = fixture("config.go");
    let t = trace(&src, at(&src, 12, "total", 0));
    assert_eq!(hops(&t), vec![(12, 14), (12, 18)]);
}

#[test]
fn parameter_def_is_in_entry() {
    let src = fixture("config.go");
    let l = lower(&src, at(&src, 11, "path", 0)).unwrap();
    let Picked::Event(e) = l.picked else {
        panic!("expected an event")
    };
    assert_eq!(
        l.function.blocks[l.function.events[e].block].kind,
        BlockKind::Entry
    );
    let t = solve(&l.function, l.picked);
    assert_eq!(hops(&t), vec![(11, 13), (11, 20)]);
}

#[test]
fn scenario_hops() {
    let cases = [
        ("server.go", 33, "status", 0, vec![(33, 36)]),
        ("server.go", 40, "code", 0, vec![(40, 43), (40, 46)]),
        ("calc.go", 54, "v", 0, vec![(52, 54)]),
        ("sum.go", 62, "acc", 1, vec![(60, 62), (62, 62)]),
        ("calc.go", 70, "x", 0, vec![(70, 71)]),
        ("run.go", 80, "i", 0, vec![(79, 80)]),
        ("serve.go", 90, "limit", 0, vec![(90, 92), (90, 97)]),
    ];
    for (file, line, word, nth, want) in cases {
        let src = fixture(file);
        let t = trace(&src, at(&src, line, word, nth));
        assert_eq!(hops(&t), want, "{file}:{line} {word}");
    }
}

#[test]
fn shadowing_and_capture_lines_are_absent() {
    let src = fixture("run.go");
    let t = trace(&src, at(&src, 80, "i", 0));
    assert!(t.occurrences.iter().all(|o| o.line != 85 && o.line != 86));

    let src = fixture("serve.go");
    let t = trace(&src, at(&src, 90, "limit", 0));
    assert!(t.occurrences.iter().all(|o| o.line != 93 && o.line != 94));
    let capture = t.occurrences.iter().find(|o| o.line == 92).unwrap();
    assert!(capture.capture);
    assert_eq!((capture.start_char, capture.end_char), (6, 10));

    // A reference inside the literal picks the capture.
    let l = lower(&src, at(&src, 94, "limit", 0)).unwrap();
    let Picked::Event(e) = l.picked else {
        panic!("expected an event")
    };
    let ev = &l.function.events[e];
    assert!(ev.capture);
    assert_eq!(
        ev.pos,
        Pos {
            line: 92,
            character: 6
        }
    );
}

#[test]
fn unused_has_no_uses() {
    let src = fixture("config.go");
    let t = trace(&src, at(&src, 16, "unused", 0));
    assert_eq!(t.status, TraceStatus::NoUses);
}

#[test]
fn refusals() {
    let src = fixture("config.go");
    assert_eq!(
        lower(&src, at(&src, 13, "open", 0)),
        Err(FlowError::NotLocal {
            name: "open".into(),
            function: "parseConfig".into()
        })
    );
    assert_eq!(
        lower(&src, at(&src, 16, "defaultPath", 0)),
        Err(FlowError::NotLocal {
            name: "defaultPath".into(),
            function: "parseConfig".into()
        })
    );
    assert_eq!(
        lower(&src, at(&src, 5, "defaultPath", 0)),
        Err(FlowError::NotInFunction {
            name: "defaultPath".into()
        })
    );
    assert_eq!(
        lower(
            &src,
            Locate::At(Pos {
                line: 12,
                character: 0
            })
        ),
        Err(FlowError::NoIdentifier)
    );
    // An identifier may end exactly at the position.
    assert!(lower(
        &src,
        Locate::At(Pos {
            line: 12,
            character: 6
        })
    )
    .is_ok());
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
    let src = fixture("config.go");
    let l = retrace(&src, "parseConfig", "total#1").unwrap();
    assert!(matches!(l.picked, Picked::Binding(_)));
    assert_eq!(solve(&l.function, l.picked).hops.len(), 4);
    assert_eq!(
        retrace(&src, "nope", "total#1"),
        Err(FlowError::FunctionGone)
    );
    assert_eq!(
        retrace(&src, "parseConfig", "total#9"),
        Err(FlowError::VariableGone)
    );

    let src = fixture("run.go");
    let l = retrace(&src, "run", "i#2").unwrap();
    assert_eq!(hops(&solve(&l.function, l.picked)), vec![(85, 86)]);
}

#[test]
fn method_name_matches_extract() {
    let src = "package p\n\ntype List[T any] struct{}\n\nfunc (l *List[T]) Len() int {\n\tn := 0\n\treturn n\n}\n";
    let frontend = GoFrontend::new(dir());
    let def = frontend
        .extract("x.go", src)
        .unwrap()
        .defs
        .into_iter()
        .find(|d| d.qualified_name.ends_with("Len"))
        .unwrap();
    let l = lower(src, at(src, 6, "n", 0)).unwrap();
    assert_eq!(l.function.qualified_name, def.qualified_name);
    assert_eq!(l.function.qualified_name, "List.Len");
    assert_eq!(
        retrace(src, "List.Len", "l#1").map(|l| l.picked),
        Ok(Picked::Binding(0))
    );
}

#[test]
fn positions_are_utf16() {
    let src = "package p\n\nfunc f() {\n\ts := \"h\u{e9}\u{1F600}\"; t := s\n\t_ = t\n}\n";
    // `\t s := "hé😀"; t := s`: é is 1 unit, 😀 is 2, so the last `s` is at 19.
    let l = lower(
        src,
        Locate::At(Pos {
            line: 4,
            character: 19,
        }),
    )
    .unwrap();
    let Picked::Event(e) = l.picked else {
        panic!("expected an event")
    };
    let ev = &l.function.events[e];
    assert_eq!(l.function.bindings[ev.binding].name, "s");
    assert_eq!((ev.pos.character, ev.end_char), (19, 20));
    let t = l.function.bindings.iter().find(|b| b.name == "t").unwrap();
    assert_eq!(
        t.decl,
        Pos {
            line: 4,
            character: 14
        }
    );
}

#[test]
fn var_without_initializer_is_a_def() {
    let src = "package p\n\nfunc f() int {\n\tvar n int\n\treturn n + 1\n}\n";
    let t = trace(src, at(src, 5, "n", 0));
    assert_eq!(t.status, TraceStatus::Hops);
    assert_eq!(hops(&t), vec![(4, 5)]);
}

#[test]
fn control_flow_constructs() {
    let src = [
        "package p",                  // 1
        "func f(ch chan int) int {",  // 2
        "\tn := 0",                   // 3
        "\tfor i := 0; i < 3; i++ {", // 4
        "\t\tif i == 1 {",            // 5
        "\t\t\tcontinue",             // 6
        "\t\t}",                      // 7
        "\t\tn = i",                  // 8
        "\t}",                        // 9
        "\tswitch n {",               // 10
        "\tcase 1:",                  // 11
        "\t\tn = 2",                  // 12
        "\t\tfallthrough",            // 13
        "\tcase 2:",                  // 14
        "\t\tprint(n)",               // 15
        "\t}",                        // 16
        "\tk := 0",                   // 17
        "outer:",                     // 18
        "\tfor {",                    // 19
        "\t\tfor {",                  // 20
        "\t\t\tk = 1",                // 21
        "\t\t\tbreak outer",          // 22
        "\t\t}",                      // 23
        "\t}",                        // 24
        "\tj := k",                   // 25
        "\tif j > 0 {",               // 26
        "\t\tgoto done",              // 27
        "\t}",                        // 28
        "\tj = 5",                    // 29
        "done:",                      // 30
        "\tselect {",                 // 31
        "\tcase v := <-ch:",          // 32
        "\t\tprint(v + j)",           // 33
        "\t}",                        // 34
        "\treturn n",                 // 35
        "}",                          // 36
    ]
    .join("\n");
    let t = trace(&src, at(&src, 3, "n", 0));
    // continue → post → header; fallthrough 12 → 15; no default → fall-out to 35.
    assert_eq!(
        hops(&trace(&src, at(&src, 35, "n", 0))),
        vec![
            (3, 10),
            (8, 10),
            (3, 15),
            (8, 15),
            (12, 15),
            (3, 35),
            (8, 35),
            (12, 35)
        ]
    );
    assert_eq!(hops(&t), vec![(3, 10), (3, 15), (3, 35)]);
    // `break outer` leaves both loops; neither `for {}` exits otherwise.
    assert_eq!(hops(&trace(&src, at(&src, 25, "k", 0))), vec![(21, 25)]);
    // `goto done` skips `j = 5`.
    assert_eq!(
        hops(&trace(&src, at(&src, 33, "j", 0))),
        vec![(25, 26), (25, 33), (29, 33)]
    );
    assert_eq!(hops(&trace(&src, at(&src, 32, "v", 0))), vec![(32, 33)]);
    // `i`: the init, the condition and the post's use and def share line 4.
    let i = trace(&src, at(&src, 8, "i", 0));
    assert_eq!(i.branches.iter().filter(|b| b.back_edge).count(), 1);
}

#[test]
fn lower_is_pure() {
    let src = fixture("config.go");
    assert_eq!(
        lower(&src, at(&src, 18, "total", 0)),
        lower(&src, at(&src, 18, "total", 0))
    );
}
