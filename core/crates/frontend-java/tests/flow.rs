//! Java data-flow lowering through `Frontend::lower`, solved by `ir::flow::solve`.

use std::fs;
use std::path::{Path, PathBuf};

use frontend_java::JavaFrontend;
use ir::{solve, BlockKind, FlowError, Frontend, Locate, Lowered, Picked, Pos, Trace, TraceStatus};

fn dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/flow")
}

fn fixture(name: &str) -> String {
    fs::read_to_string(dir().join(name)).unwrap()
}

fn lower(source: &str, at: Locate) -> Result<Lowered, FlowError> {
    JavaFrontend.lower("X.java", source, at).unwrap()
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

fn retrace(source: &str, function: &str, key: &str) -> Result<Lowered, FlowError> {
    lower(
        source,
        Locate::Function {
            qualified_name: function.into(),
            variable_key: key.into(),
        },
    )
}

fn picked_event(l: &Lowered) -> usize {
    let Picked::Event(e) = l.picked else {
        panic!("expected an event")
    };
    e
}

#[test]
fn lowering_snapshots() {
    for (file, line, word) in [
        ("Config.java", 12, "total"),
        ("Server.java", 30, "status"),
        ("Calc.java", 50, "v"),
        ("Sum.java", 60, "acc"),
        ("Run.java", 79, "i"),
        ("Serve.java", 90, "limit"),
    ] {
        let src = fixture(file);
        assert!(JavaFrontend.extract(file, &src).is_ok(), "{file} parses");
        let lowered = lower(&src, at(&src, line, word, 0)).unwrap();
        insta::assert_debug_snapshot!(lowered.function.qualified_name.clone(), lowered);
    }
}

#[test]
fn loop_accumulator_from_the_read() {
    let src = fixture("Config.java");
    let t = trace(&src, at(&src, 18, "total", 0));
    assert_eq!(t.status, TraceStatus::Hops);
    assert_eq!(hops(&t), vec![(12, 14), (14, 14), (12, 18), (14, 18)]);
    assert!(t.branches.iter().any(|b| b.back_edge));
    assert_eq!(t.function_name, "fixture.Config.parseConfig");
}

#[test]
fn picked_def_is_the_sole_start() {
    let src = fixture("Config.java");
    let t = trace(&src, at(&src, 12, "total", 0));
    assert_eq!(hops(&t), vec![(12, 14), (12, 18)]);
}

#[test]
fn parameter_def_is_in_entry() {
    let src = fixture("Config.java");
    let l = lower(&src, at(&src, 11, "path", 0)).unwrap();
    let e = picked_event(&l);
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
        ("Server.java", 33, "status", 0, vec![(33, 36)]),
        ("Server.java", 40, "code", 0, vec![(40, 43), (40, 46)]),
        ("Calc.java", 54, "v", 0, vec![(52, 54)]),
        ("Sum.java", 62, "acc", 1, vec![(60, 62), (62, 62)]),
        ("Calc.java", 70, "x", 0, vec![(70, 71)]),
        ("Run.java", 80, "i", 0, vec![(79, 80)]),
        ("Serve.java", 90, "limit", 0, vec![(90, 92), (90, 97)]),
    ];
    for (file, line, word, nth, want) in cases {
        let src = fixture(file);
        let t = trace(&src, at(&src, line, word, nth));
        assert_eq!(hops(&t), want, "{file}:{line} {word}");
    }
}

#[test]
fn sibling_scopes_and_capture_lines_are_absent() {
    let src = fixture("Run.java");
    let t = trace(&src, at(&src, 80, "i", 0));
    assert!(t.occurrences.iter().all(|o| o.line != 85 && o.line != 86));

    let src = fixture("Serve.java");
    let t = trace(&src, at(&src, 90, "limit", 0));
    assert!(t.occurrences.iter().all(|o| o.line != 93 && o.line != 94));
    let capture = t.occurrences.iter().find(|o| o.line == 92).unwrap();
    assert!(capture.capture);
    assert_eq!((capture.start_char, capture.end_char), (21, 26));

    // A reference inside the lambda picks the capture, and two reads make one capture.
    let l = lower(&src, at(&src, 94, "limit", 0)).unwrap();
    let ev = &l.function.events[picked_event(&l)];
    assert!(ev.capture);
    assert_eq!(
        ev.pos,
        Pos {
            line: 92,
            character: 21
        }
    );
    assert_eq!(l.function.events.iter().filter(|e| e.capture).count(), 1);
}

#[test]
fn unused_has_no_uses() {
    let src = fixture("Config.java");
    let t = trace(&src, at(&src, 16, "unused", 0));
    assert_eq!(t.status, TraceStatus::NoUses);
}

#[test]
fn refusals() {
    let src = fixture("Config.java");
    let not_local = |name: &str| {
        Err(FlowError::NotLocal {
            name: name.into(),
            function: "fixture.Config.parseConfig".into(),
        })
    };
    assert_eq!(lower(&src, at(&src, 13, "open", 0)), not_local("open"));
    assert_eq!(
        lower(&src, at(&src, 16, "defaultPath", 0)),
        not_local("defaultPath")
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
            character: 17
        })
    )
    .is_ok());

    let src = "package p;\nclass C {\n    int limit;\n    void f() {\n        int x = this.limit;\n    }\n    { limit = 1; }\n}\n";
    for word in ["this", "limit", "int"] {
        assert_eq!(
            lower(src, at(src, 5, word, 0)),
            Err(FlowError::NotLocal {
                name: word.into(),
                function: "p.C.f".into()
            }),
            "{word}"
        );
    }
    assert_eq!(
        lower(src, at(src, 7, "limit", 0)),
        Err(FlowError::NotInFunction {
            name: "limit".into()
        })
    );
}

#[test]
fn retrace_by_function_and_key() {
    let src = fixture("Config.java");
    let l = retrace(&src, "fixture.Config.parseConfig", "total#1").unwrap();
    assert!(matches!(l.picked, Picked::Binding(_)));
    assert_eq!(solve(&l.function, l.picked).hops.len(), 4);
    assert_eq!(
        retrace(&src, "fixture.Config.nope", "total#1"),
        Err(FlowError::FunctionGone)
    );
    assert_eq!(
        retrace(&src, "fixture.Config.parseConfig", "total#9"),
        Err(FlowError::VariableGone)
    );

    let src = fixture("Run.java");
    let l = retrace(&src, "fixture.Run.run", "i#2").unwrap();
    assert_eq!(hops(&solve(&l.function, l.picked)), vec![(85, 86)]);
}

#[test]
fn declaration_without_initializer_is_not_a_def() {
    let src = "package p;\nclass C {\n    int f() {\n        int n;\n        return n;\n    }\n}\n";
    assert_eq!(
        trace(src, at(src, 5, "n", 0)).status,
        TraceStatus::NoReachingDef
    );
    let l = lower(src, at(src, 4, "n", 0)).unwrap();
    assert!(matches!(l.picked, Picked::Binding(_)));
    assert_eq!(
        solve(&l.function, l.picked).status,
        TraceStatus::NoReachingDef
    );
}

#[test]
fn anonymous_class_is_one_capture() {
    let src = [
        "package p;",                            // 1
        "class C {",                             // 2
        "    void f() {",                        // 3
        "        int limit = 5;",                // 4
        "        Runnable r = new Runnable() {", // 5
        "            public void run() {",       // 6
        "                print(limit + limit);", // 7
        "            }",                         // 8
        "        };",                            // 9
        "        print(limit);",                 // 10
        "    }",                                 // 11
        "}",                                     // 12
    ]
    .join("\n");
    let t = trace(&src, at(&src, 4, "limit", 0));
    assert_eq!(hops(&t), vec![(4, 5), (4, 10)]);
    let capture = t.occurrences.iter().find(|o| o.capture).unwrap();
    assert_eq!(
        (capture.line, capture.start_char, capture.end_char),
        (5, 21, 24)
    );

    let l = lower(&src, at(&src, 7, "limit", 1)).unwrap();
    assert_eq!(l.function.qualified_name, "p.C.f");
    assert!(l.function.events[picked_event(&l)].capture);
    assert_eq!(
        lower(&src, at(&src, 6, "run", 0)),
        Err(FlowError::NotLocal {
            name: "run".into(),
            function: "p.C.f".into()
        })
    );
}

#[test]
fn names_match_extract() {
    let src = [
        "package p;",                      // 1
        "class Outer {",                   // 2
        "    Outer(int a) {",              // 3
        "        int b = a;",              // 4
        "    }",                           // 5
        "    static class Inner {",        // 6
        "        int m(int x) {",          // 7
        "            return x;",           // 8
        "        }",                       // 9
        "    }",                           // 10
        "    int over(int y) {",           // 11
        "        return y;",               // 12
        "    }",                           // 13
        "    int over(String z, int y) {", // 14
        "        return y;",               // 15
        "    }",                           // 16
        "}",                               // 17
    ]
    .join("\n");
    let defs = JavaFrontend.extract("X.java", &src).unwrap().defs;
    for (line, word, name) in [
        (4, "b", "p.Outer.Outer"),
        (8, "x", "p.Outer.Inner.m"),
        (12, "y", "p.Outer.over"),
        (15, "y", "p.Outer.over"),
    ] {
        let l = lower(&src, at(&src, line, word, 0)).unwrap();
        assert_eq!(l.function.qualified_name, name);
        assert!(defs.iter().any(|d| d.qualified_name == name), "{name}");
    }
    // A retrace of an overloaded name lowers the first declaration.
    let l = retrace(&src, "p.Outer.over", "y#1").unwrap();
    assert_eq!(hops(&solve(&l.function, l.picked)), vec![(11, 12)]);
    assert_eq!(
        retrace(&src, "p.Outer.over", "z#1"),
        Err(FlowError::VariableGone)
    );
}

#[test]
fn positions_are_utf16() {
    let src = "package p;\nclass C {\n    void f() {\n        String s = \"h\u{e9}\u{1F600}\"; String t = s;\n    }\n}\n";
    // `String s = "hé😀"; String t = s;` after 8 spaces: é is 1 unit, 😀 is 2.
    let l = lower(
        src,
        Locate::At(Pos {
            line: 4,
            character: 38,
        }),
    )
    .unwrap();
    let ev = &l.function.events[picked_event(&l)];
    assert_eq!(l.function.bindings[ev.binding].name, "s");
    assert_eq!((ev.pos.character, ev.end_char), (38, 39));
    let t = l.function.bindings.iter().find(|b| b.name == "t").unwrap();
    assert_eq!(
        t.decl,
        Pos {
            line: 4,
            character: 34
        }
    );
}

#[test]
fn control_flow_constructs() {
    let src = [
        "package p;",                                     // 1
        "class C {",                                      // 2
        "    int f(int[] xs, Object o) {",                // 3
        "        int w = 0;",                             // 4
        "        while (w < 3) {",                        // 5
        "            w = w + 1;",                         // 6
        "        }",                                      // 7
        "        int d = 0;",                             // 8
        "        do {",                                   // 9
        "            d = d + 1;",                         // 10
        "        } while (d < 5);",                       // 11
        "        int c = 0;",                             // 12
        "        for (int i = 0; i < 3; i++) {",          // 13
        "            c = 5;",                             // 14
        "            if (i == 1) {",                      // 15
        "                continue;",                      // 16
        "            }",                                  // 17
        "            c = i;",                             // 18
        "        }",                                      // 19
        "        int g = 0;",                             // 20
        "        switch (c) {",                           // 21
        "        case 1:",                                // 22
        "            g = 2;",                             // 23
        "        case 2:",                                // 24
        "            print(g);",                          // 25
        "        }",                                      // 26
        "        print(g);",                              // 27
        "        int r = 0;",                             // 28
        "        switch (c) {",                           // 29
        "        case 1 -> r = 7;",                       // 30
        "        case 2 -> print(r);",                    // 31
        "        default -> r = 8;",                      // 32
        "        }",                                      // 33
        "        print(r);",                              // 34
        "        int k = 0;",                             // 35
        "        outer:",                                 // 36
        "        while (true) {",                         // 37
        "            for (int b : xs) {",                 // 38
        "                k = 1;",                         // 39
        "                break outer;",                   // 40
        "            }",                                  // 41
        "        }",                                      // 42
        "        print(k);",                              // 43
        "        int t = 0;",                             // 44
        "        try {",                                  // 45
        "            t = 1;",                             // 46
        "            risky();",                           // 47
        "        } catch (Exception e) {",                // 48
        "            print(t);",                          // 49
        "            t = 2;",                             // 50
        "        } finally {",                            // 51
        "            print(t);",                          // 52
        "        }",                                      // 53
        "        if (o instanceof String s) {",           // 54
        "            print(s);",                          // 55
        "        }",                                      // 56
        "        if (w > 9) {",                           // 57
        "            w = 100;",                           // 58
        "            throw new IllegalStateException();", // 59
        "        }",                                      // 60
        "        return w;",                              // 61
        "    }",                                          // 62
        "}",                                              // 63
    ]
    .join("\n");
    let h = |line, word, nth| hops(&trace(&src, at(&src, line, word, nth)));
    // while: the body def loops back to the condition and leaves through it.
    assert_eq!(h(6, "w", 0), vec![(6, 5), (6, 6), (6, 57), (6, 61)]);
    // do: the body def reaches the condition, and the body again through the back edge.
    let d = trace(&src, at(&src, 10, "d", 0));
    assert_eq!(hops(&d), vec![(10, 10), (10, 11)]);
    assert!(d.branches.iter().any(|b| b.back_edge));
    assert_eq!(h(8, "d", 0), vec![(8, 10)]);
    // `continue` → update → header: `c = 5` leaves the loop only that way.
    assert_eq!(h(14, "c", 0), vec![(14, 21), (14, 29)]);
    // Colon switch: group 1 falls into group 2; no `default` → also past the switch.
    assert_eq!(h(23, "g", 0), vec![(23, 25), (23, 27)]);
    assert_eq!(h(25, "g", 0), vec![(20, 25), (23, 25), (20, 27), (23, 27)]);
    // Arrow switch: no fall-through; with `default` the header never bypasses the rules.
    assert_eq!(h(31, "r", 0), vec![(28, 31), (28, 34)]);
    assert_eq!(h(34, "r", 0), vec![(28, 31), (28, 34), (30, 34), (32, 34)]);
    // `break outer` leaves both loops; `while (true)` leaves no other way.
    assert_eq!(h(43, "k", 0), vec![(39, 43)]);
    // try: the block before the body and the body reach the catch; the body and the catch
    // reach finally.
    assert_eq!(h(49, "t", 0), vec![(44, 49), (46, 49), (44, 52), (46, 52)]);
    assert_eq!(
        h(52, "t", 0),
        vec![(44, 49), (46, 49), (44, 52), (46, 52), (50, 52)]
    );
    // instanceof pattern variable.
    assert_eq!(h(55, "s", 0), vec![(54, 55)]);
    // throw → Exit: the def before it reaches nothing.
    assert_eq!(
        trace(&src, at(&src, 58, "w", 0)).status,
        TraceStatus::NoUses
    );
}

#[test]
fn lower_is_pure() {
    let src = fixture("Config.java");
    assert_eq!(
        lower(&src, at(&src, 18, "total", 0)),
        lower(&src, at(&src, 18, "total", 0))
    );
}
