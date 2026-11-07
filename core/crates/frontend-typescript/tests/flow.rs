//! TypeScript/JavaScript data-flow lowering through `Frontend::lower`, solved by
//! `ir::flow::solve`.

use std::fs;
use std::path::{Path, PathBuf};

use frontend_typescript::TypeScriptFrontend;
use ir::{
    solve, BlockKind, FlowError, Frontend, Locate, Lowered, Picked, Pos, Role, Trace, TraceStatus,
};

fn dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/flow")
}

fn fixture(name: &str) -> String {
    fs::read_to_string(dir().join(name)).unwrap()
}

fn lower_as(path: &str, source: &str, at: Locate) -> Result<Lowered, FlowError> {
    TypeScriptFrontend.lower(path, source, at).unwrap()
}

fn lower(source: &str, at: Locate) -> Result<Lowered, FlowError> {
    lower_as("x.ts", source, at)
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

fn event(l: &Lowered) -> usize {
    let Picked::Event(e) = l.picked else {
        panic!("expected an event")
    };
    e
}

#[test]
fn lowering_snapshots() {
    for (file, line, word) in [
        ("config.ts", 12, "total"),
        ("server.ts", 30, "status"),
        ("calc.ts", 50, "v"),
        ("sum.ts", 60, "acc"),
        ("run.ts", 79, "i"),
        ("serve.ts", 90, "limit"),
    ] {
        let src = fixture(file);
        let lowered = lower(&src, at(&src, line, word, 0)).unwrap();
        insta::assert_debug_snapshot!(lowered.function.qualified_name.clone(), lowered);
    }
}

#[test]
fn loop_accumulator_from_the_read() {
    let src = fixture("config.ts");
    let t = trace(&src, at(&src, 18, "total", 0));
    assert_eq!(t.status, TraceStatus::Hops);
    assert_eq!(hops(&t), vec![(12, 14), (14, 14), (12, 18), (14, 18)]);
    assert!(t.branches.iter().any(|b| b.back_edge));
    assert_eq!(t.function_name, "parseConfig");
}

#[test]
fn picked_def_is_the_sole_start() {
    let src = fixture("config.ts");
    let t = trace(&src, at(&src, 12, "total", 0));
    assert_eq!(hops(&t), vec![(12, 14), (12, 18)]);
}

#[test]
fn parameter_def_is_in_entry() {
    let src = fixture("config.ts");
    let l = lower(&src, at(&src, 11, "path", 0)).unwrap();
    let e = event(&l);
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
        ("server.ts", 33, "status", 0, vec![(33, 36)]),
        ("server.ts", 40, "code", 0, vec![(40, 43), (40, 46)]),
        ("calc.ts", 54, "v", 0, vec![(52, 54)]),
        ("sum.ts", 62, "acc", 1, vec![(60, 62), (62, 62)]),
        ("calc.ts", 70, "x", 0, vec![(70, 71)]),
        ("run.ts", 80, "i", 0, vec![(79, 80)]),
        (
            "serve.ts",
            90,
            "limit",
            0,
            vec![(90, 92), (90, 97), (90, 99)],
        ),
    ];
    for (file, line, word, nth, want) in cases {
        let src = fixture(file);
        let t = trace(&src, at(&src, line, word, nth));
        assert_eq!(hops(&t), want, "{file}:{line} {word}");
    }
}

#[test]
fn shadowing_and_capture_lines_are_absent() {
    let src = fixture("run.ts");
    let t = trace(&src, at(&src, 80, "i", 0));
    assert!(t.occurrences.iter().all(|o| o.line != 85 && o.line != 86));

    let src = fixture("serve.ts");
    let t = trace(&src, at(&src, 90, "limit", 0));
    assert!(t.occurrences.iter().all(|o| o.line != 93 && o.line != 94));
    for line in [92, 99] {
        let capture = t.occurrences.iter().find(|o| o.line == line).unwrap();
        assert!(capture.capture, "line {line}");
    }
    // The capture sits on the site's first token: `(` of `() => {`, `function`.
    let arrow = t.occurrences.iter().find(|o| o.line == 92).unwrap();
    assert_eq!((arrow.start_char, arrow.end_char), (12, 13));
    let inner = t.occurrences.iter().find(|o| o.line == 99).unwrap();
    assert_eq!((inner.start_char, inner.end_char), (2, 10));

    // A reference inside the arrow body picks the capture.
    let l = lower(&src, at(&src, 94, "limit", 0)).unwrap();
    let ev = &l.function.events[event(&l)];
    assert!(ev.capture);
    assert_eq!(
        ev.pos,
        Pos {
            line: 92,
            character: 12
        }
    );
}

#[test]
fn unused_has_no_uses() {
    let src = fixture("config.ts");
    let t = trace(&src, at(&src, 16, "unused", 0));
    assert_eq!(t.status, TraceStatus::NoUses);
}

#[test]
fn javascript_lowers_like_typescript() {
    let src = fixture("config.ts");
    let ts = lower_as("config.ts", &src, at(&src, 18, "total", 0));
    assert!(ts.is_ok());
    for path in ["config.js", "config.jsx", "config.tsx"] {
        assert_eq!(lower_as(path, &src, at(&src, 18, "total", 0)), ts, "{path}");
    }
}

fn control(line: u32, word: &str, nth: usize) -> (Lowered, Trace) {
    let src = fixture("control.js");
    let l = lower_as("control.js", &src, at(&src, line, word, nth)).unwrap();
    let t = solve(&l.function, l.picked);
    (l, t)
}

#[test]
fn let_without_initializer_is_not_a_def() {
    let (_, t) = control(13, "n", 0);
    assert_eq!(t.status, TraceStatus::NoReachingDef);
}

#[test]
fn var_is_hoisted() {
    let (early, t) = control(4, "v", 0);
    assert_eq!(t.status, TraceStatus::NoReachingDef);
    let (late, t) = control(8, "v", 0);
    assert_eq!(hops(&t), vec![(6, 8)]);
    let binding = |l: &Lowered| l.function.events[event(l)].binding;
    assert_eq!(binding(&early), binding(&late));
}

#[test]
fn switch_falls_through() {
    // `case 1: r = 1;` has no `break`, so it reaches `case 2`'s read.
    let (_, t) = control(37, "r", 0);
    assert_eq!(hops(&t), vec![(37, 39)]);
    // No `default`: the initial value also falls out of the `switch`.
    let (_, t) = control(42, "r", 0);
    assert_eq!(hops(&t), vec![(34, 39), (34, 42), (39, 42)]);
}

#[test]
fn try_catch_finally_is_conservative() {
    // Both the catch's and the finally's read see the pre-try and the try def.
    let both = vec![(46, 50), (48, 50), (46, 52), (48, 52)];
    let (_, t) = control(50, "x", 0);
    assert_eq!(hops(&t), both);
    let (_, t) = control(52, "x", 0);
    assert_eq!(hops(&t), both);
    let (_, t) = control(49, "e", 0);
    assert_eq!(hops(&t), vec![(49, 50)]);
}

#[test]
fn return_enters_finally_which_reaches_exit() {
    let src = [
        "function f(x) {", // 1
        "  try {",         // 2
        "    return x;",   // 3
        "  } finally {",   // 4
        "    log(x);",     // 5
        "  }",             // 6
        "  x = 1;",        // 7
        "}",               // 8
    ]
    .join("\n");
    let l = lower(&src, at(&src, 5, "x", 0)).unwrap();
    let f = &l.function;
    let exit = f.blocks.len() - 1;
    let ret = f.events.iter().find(|e| e.pos.line == 3).unwrap().block;
    let fin = f.events[event(&l)].block;
    assert!(f.branches.contains(&(ret, fin)));
    assert!(!f.branches.contains(&(ret, exit)));
    assert!(f.branches.contains(&(fin, exit)));
    // Only a jump entered the `finally`, so nothing flows on to line 7.
    assert!(f
        .events
        .iter()
        .filter(|e| e.pos.line == 7)
        .all(|e| e.block != fin));
    assert_eq!(hops(&solve(f, l.picked)), vec![(1, 3), (1, 5)]);
}

#[test]
fn loops_have_back_edge_hops() {
    let (_, t) = control(30, "acc", 0);
    let h = hops(&t);
    // do…while, for with an update, and `continue outer` back to the `for…in` header.
    for pair in [
        (19, 19),
        (19, 20),
        (22, 22),
        (26, 26),
        (19, 30),
        (22, 30),
        (26, 30),
    ] {
        assert!(h.contains(&pair), "{pair:?} in {h:?}");
    }
    assert!(!h.contains(&(17, 30)));
    let (_, t) = control(22, "i", 0);
    assert!(hops(&t).contains(&(21, 22)));
    // do…while, `for (;;)` with an update, and the `for…in`; the inner `for (;;)` never
    // reaches its own header again (it always `continue outer`s).
    assert_eq!(t.branches.iter().filter(|b| b.back_edge).count(), 3);
    let (_, t) = control(24, "k", 0);
    assert_eq!(t.status, TraceStatus::NoUses);
}

#[test]
fn destructuring_order() {
    // `b`'s default reads `a`.
    let (_, t) = control(57, "a", 0);
    assert_eq!(hops(&t), vec![(57, 57)]);
    let (_, t) = control(60, "b", 0);
    assert_eq!(hops(&t), vec![(57, 60)]);
    // `[p, q] = [q, p]`: the right side's uses, then the defs.
    let (l, _) = control(59, "p", 0);
    let line: Vec<(String, Role)> = l
        .function
        .events
        .iter()
        .filter(|e| e.pos.line == 59)
        .map(|e| (l.function.bindings[e.binding].name.clone(), e.role))
        .collect();
    let want = [
        ("q", Role::Use),
        ("p", Role::Use),
        ("p", Role::Def),
        ("q", Role::Def),
    ];
    assert_eq!(
        line,
        want.map(|(n, r)| (n.to_owned(), r)).to_vec(),
        "events on line 59"
    );
    let (_, t) = control(59, "p", 1);
    assert_eq!(hops(&t), vec![(58, 59)]);
}

#[test]
fn refusals() {
    let src = fixture("config.ts");
    assert_eq!(
        lower(&src, at(&src, 13, "open", 0)),
        not_local("open", "parseConfig")
    );
    assert_eq!(
        lower(&src, at(&src, 16, "defaultPath", 0)),
        not_local("defaultPath", "parseConfig")
    );
    assert_eq!(
        lower(&src, at(&src, 5, "defaultPath", 0)),
        Err(FlowError::NotInFunction {
            name: "defaultPath".into()
        })
    );
    assert_eq!(
        lower(&src, at(&src, 11, "parseConfig", 0)),
        not_local("parseConfig", "parseConfig")
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
            character: 11
        })
    )
    .is_ok());

    let src = [
        "import { dep } from \"./dep\";", // 1
        "class C {",                      // 2
        "  field = dep;",                 // 3
        "  m(o) {",                       // 4
        "    const n = this.size;",       // 5
        "    o.size = dep(n);",           // 6
        "    return n;",                  // 7
        "  }",                            // 8
        "}",                              // 9
    ]
    .join("\n");
    for (line, word, nth) in [
        (5, "this", 0),
        (5, "size", 0),
        (6, "size", 0),
        (6, "dep", 0),
    ] {
        assert_eq!(
            lower(&src, at(&src, line, word, nth)),
            not_local(word, "C.m"),
            "{line} {word}"
        );
    }
    assert_eq!(
        lower(&src, at(&src, 7, "return", 0)),
        not_local("return", "C.m")
    );
    assert_eq!(
        lower(&src, at(&src, 3, "dep", 0)),
        Err(FlowError::NotInFunction { name: "dep".into() })
    );
    // `o.size = …` is a use of `o`.
    let l = lower(&src, at(&src, 6, "o", 0)).unwrap();
    assert_eq!(l.function.events[event(&l)].role, Role::Use);
}

#[test]
fn nested_functions() {
    let src = fixture("serve.ts");
    assert_eq!(
        lower(&src, at(&src, 99, "limit", 0)),
        not_local("limit", "serve.inner")
    );
    // A capture site's own local is not a binding of the traced function.
    assert_eq!(lower(&src, at(&src, 93, "n", 0)), not_local("n", "serve"));
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
    let src = fixture("config.ts");
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

    let src = fixture("run.ts");
    let l = retrace(&src, "run", "i#2").unwrap();
    assert_eq!(hops(&solve(&l.function, l.picked)), vec![(85, 86)]);
}

#[test]
fn qualified_names_match_extract() {
    for (file, functions) in [
        ("config.ts", &["open", "read", "parseConfig"][..]),
        ("server.ts", &["Server.handle"]),
        ("calc.ts", &["calc"]),
        ("sum.ts", &["sum"]),
        ("run.ts", &["run"]),
        ("serve.ts", &["serve", "serve.inner"]),
        (
            "control.js",
            &["hoisted", "uninit", "loops", "pick", "guarded", "swap"],
        ),
    ] {
        let src = fixture(file);
        let defs = TypeScriptFrontend.extract(file, &src).unwrap().defs;
        for f in functions {
            assert!(
                defs.iter().any(|d| d.qualified_name == *f),
                "{file}: {f} not among extract's defs"
            );
            // Every function lowers by that name (a missing key, not a missing function).
            assert_eq!(
                lower_as(
                    file,
                    &src,
                    Locate::Function {
                        qualified_name: (*f).into(),
                        variable_key: "nope#1".into(),
                    }
                ),
                Err(FlowError::VariableGone),
                "{file}: {f}"
            );
        }
    }
    let src = fixture("server.ts");
    let l = lower(&src, at(&src, 30, "status", 0)).unwrap();
    assert_eq!(l.function.qualified_name, "Server.handle");
}

#[test]
fn parameters_destructured_and_defaulted() {
    let src = [
        "function f({ a, b = a }, c = b, ...rest) {", // 1
        "  return a + b + c + rest.length;",          // 2
        "}",                                          // 3
    ]
    .join("\n");
    let l = lower(&src, at(&src, 1, "c", 0)).unwrap();
    let f = &l.function;
    assert!(f
        .events
        .iter()
        .filter(|e| e.pos.line == 1)
        .all(|e| e.block == 0));
    let entry: Vec<(String, Role)> = f
        .events
        .iter()
        .filter(|e| e.block == 0)
        .map(|e| (f.bindings[e.binding].name.clone(), e.role))
        .collect();
    let want = [
        ("a", Role::Def),
        ("a", Role::Use),
        ("b", Role::Def),
        ("b", Role::Use),
        ("c", Role::Def),
        ("rest", Role::Def),
    ];
    assert_eq!(entry, want.map(|(n, r)| (n.to_owned(), r)).to_vec());
    assert_eq!(hops(&solve(f, l.picked)), vec![(1, 2)]);
}

#[test]
fn compound_and_update_are_use_then_def() {
    let src = [
        "function f(x, o) {", // 1
        "  x ??= 1;",         // 2
        "  x++;",             // 3
        "  delete o.k;",      // 4
        "  return x;",        // 5
        "}",                  // 6
    ]
    .join("\n");
    let t = trace(&src, at(&src, 5, "x", 0));
    assert_eq!(hops(&t), vec![(3, 5)]);
    let t = trace(&src, at(&src, 1, "x", 0));
    assert_eq!(hops(&t), vec![(1, 2)]);
    let t = trace(&src, at(&src, 2, "x", 0));
    assert_eq!(hops(&t), vec![(2, 3)]);
    let t = trace(&src, at(&src, 1, "o", 0));
    assert_eq!(hops(&t), vec![(1, 4)]);
}

#[test]
fn positions_are_utf16() {
    let src = "function f() {\n  const s = \"h\u{e9}\u{1F600}\"; const t = s;\n  return t;\n}\n";
    // `  const s = "hé😀"; const t = s;`: é is 1 unit, 😀 is 2, so the last `s` is at 30.
    let l = lower(
        src,
        Locate::At(Pos {
            line: 2,
            character: 30,
        }),
    )
    .unwrap();
    let ev = &l.function.events[event(&l)];
    assert_eq!(l.function.bindings[ev.binding].name, "s");
    assert_eq!((ev.pos.character, ev.end_char), (30, 31));
    let t = l.function.bindings.iter().find(|b| b.name == "t").unwrap();
    assert_eq!(
        t.decl,
        Pos {
            line: 2,
            character: 26
        }
    );
}

#[test]
fn blocks_have_lines_and_exit_is_last() {
    let src = fixture("control.js");
    let l = lower_as("control.js", &src, at(&src, 46, "x", 0)).unwrap();
    let blocks = &l.function.blocks;
    assert_eq!(blocks[0].kind, BlockKind::Entry);
    assert_eq!(blocks.last().unwrap().kind, BlockKind::Exit);
    for b in &blocks[1..blocks.len() - 1] {
        assert_eq!(b.kind, BlockKind::Basic);
        assert!(b.lines.is_some() && !b.first_line.is_empty(), "{b:?}");
    }
}

#[test]
fn lower_is_pure() {
    let src = fixture("config.ts");
    assert_eq!(
        lower(&src, at(&src, 18, "total", 0)),
        lower(&src, at(&src, 18, "total", 0))
    );
}
