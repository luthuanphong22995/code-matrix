//! `flow/trace` and `flow/retrace` (`data-flow/design/api.md § 2`): lower one file on demand
//! against the published snapshot and solve it. Never touches `Live`, so never waits on a run.

use std::ffi::OsStr;
use std::fs;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::Path;

use index::{FrontendRegistry, Snapshot};
use ir::{solve, FlowError, Frontend, Locate, Lowered, NodeId, NodeKind, Pos};
use rpc::protocol::{
    FlowRetraceParams, FlowRetraceResult, FlowTraceParams, FlowTraceResult, FLOW_RETRACE,
    FLOW_TRACE, INTERNAL_ERROR, INVALID_PARAMS, METHOD_NOT_FOUND, NOT_INDEXED,
};
use serde_json::Value;

use crate::graph;

type Answer<T> = Result<T, (i64, String)>;

/// Answers `flow/trace` or `flow/retrace` from `snapshot`; `-32010` before the first one.
pub fn handle(method: &str, params: Value, snapshot: Option<&Snapshot>) -> Answer<Value> {
    let snapshot = snapshot.ok_or((NOT_INDEXED, "NotIndexed".to_owned()))?;
    answer(method, params, snapshot, &graph::registry(&snapshot.roots))
}

fn answer(
    method: &str,
    params: Value,
    snapshot: &Snapshot,
    registry: &FrontendRegistry,
) -> Answer<Value> {
    let bad_params = |e: serde_json::Error| (INVALID_PARAMS, e.to_string());
    let result = match method {
        FLOW_TRACE => {
            let params = serde_json::from_value(params).map_err(bad_params)?;
            serde_json::to_value(trace(params, snapshot, registry)?)
        }
        FLOW_RETRACE => {
            let params = serde_json::from_value(params).map_err(bad_params)?;
            serde_json::to_value(retrace(params, snapshot, registry)?)
        }
        _ => return Err((METHOD_NOT_FOUND, format!("unknown method: {method}"))),
    };
    result.map_err(internal)
}

/// First failure wins: language, indexed, failed, readable, then the frontend's refusals.
fn trace(
    params: FlowTraceParams,
    snapshot: &Snapshot,
    registry: &FrontendRegistry,
) -> Answer<FlowTraceResult> {
    let path = &params.path;
    let graph_path = snapshot.graph_path(path);
    let file = graph_path
        .clone()
        .unwrap_or_else(|| path.to_string_lossy().into_owned());
    let ext = path.extension().and_then(OsStr::to_str);
    let Some(frontend) = ext.and_then(|ext| registry.by_extension(ext)) else {
        return Ok(FlowTraceResult::UnsupportedLanguage { language: None });
    };
    let unsupported = || FlowTraceResult::UnsupportedLanguage {
        language: Some(display_language(frontend.language(), ext)),
    };
    // Probed on empty source, so an unindexed file is never parsed to find this out.
    let probe = Locate::At(Pos {
        line: 1,
        character: 0,
    });
    if lower(frontend, &file, "", probe)?.is_none() {
        return Ok(unsupported());
    }
    let Some(graph_path) = graph_path.filter(|p| snapshot.graph.node(&NodeId::file(p)).is_some())
    else {
        return Ok(FlowTraceResult::FileNotIndexed { file });
    };
    if snapshot.failed.contains(&graph_path) {
        return Ok(FlowTraceResult::FileFailed { file });
    }
    let Ok(bytes) = fs::read(path) else {
        return Ok(FlowTraceResult::FileNotIndexed { file });
    };
    let at = Locate::At(Pos {
        line: params.line.saturating_add(1),
        character: params.character,
    });
    Ok(
        match lower(frontend, &graph_path, &String::from_utf8_lossy(&bytes), at)? {
            None => unsupported(),
            Some(Ok(lowered)) => FlowTraceResult::Trace {
                trace: solved(&graph_path, &lowered)?,
            },
            Some(Err(FlowError::NotInFunction { name })) => FlowTraceResult::NotInFunction { name },
            Some(Err(FlowError::NotLocal { name, function })) => {
                FlowTraceResult::NotLocal { name, function }
            }
            // ponytail: `FunctionGone` / `VariableGone` only answer `Locate::Function`.
            Some(Err(_)) => FlowTraceResult::NoIdentifier,
        },
    )
}

fn retrace(
    params: FlowRetraceParams,
    snapshot: &Snapshot,
    registry: &FrontendRegistry,
) -> Answer<FlowRetraceResult> {
    let id = graph::node_id(params.function_id);
    let Some(node) = snapshot
        .graph
        .node(&id)
        .filter(|n| n.kind == NodeKind::Function)
    else {
        return Ok(FlowRetraceResult::FunctionGone { function: None });
    };
    let gone = || FlowRetraceResult::FunctionGone {
        function: Some(node.name.clone()),
    };
    let Some(graph_path) = node.path.as_deref() else {
        return Ok(gone());
    };
    let frontend = Path::new(graph_path)
        .extension()
        .and_then(OsStr::to_str)
        .and_then(|ext| registry.by_extension(ext));
    let source = snapshot
        .disk_path(graph_path)
        .and_then(|disk| fs::read(disk).ok());
    let (Some(frontend), Some(source)) = (frontend, source) else {
        return Ok(gone());
    };
    let at = Locate::Function {
        qualified_name: node.name.clone(),
        variable_key: params.variable_key.clone(),
    };
    Ok(
        match lower(frontend, graph_path, &String::from_utf8_lossy(&source), at)? {
            Some(Ok(lowered)) => FlowRetraceResult::Trace {
                trace: solved(graph_path, &lowered)?,
            },
            Some(Err(FlowError::VariableGone)) => {
                let key = &params.variable_key;
                FlowRetraceResult::VariableGone {
                    variable: key
                        .split_once('#')
                        .map_or(key.as_str(), |(name, _)| name)
                        .to_owned(),
                    function: node.name.clone(),
                }
            }
            _ => gone(),
        },
    )
}

/// `frontend.lower`, with a panic answered `-32603` instead of taking the server down.
fn lower(
    frontend: &dyn Frontend,
    path: &str,
    source: &str,
    at: Locate,
) -> Answer<Option<Result<Lowered, FlowError>>> {
    catch_unwind(AssertUnwindSafe(|| frontend.lower(path, source, at))).map_err(|panic| {
        let message = format!("lower panicked: {}", graph::panic_message(&*panic));
        (INTERNAL_ERROR, message)
    })
}

/// The solver's trace plus its function's graph node id.
fn solved(graph_path: &str, lowered: &Lowered) -> Answer<Value> {
    let mut trace =
        serde_json::to_value(solve(&lowered.function, lowered.picked)).map_err(internal)?;
    let id = NodeId::new(
        NodeKind::Function,
        graph_path,
        &lowered.function.qualified_name,
    );
    trace["functionId"] = Value::String(id.to_string());
    Ok(trace)
}

fn internal(e: serde_json::Error) -> (i64, String) {
    (INTERNAL_ERROR, e.to_string())
}

/// The name a refusal shows: by frontend language, `JavaScript` for `.js` / `.jsx`.
fn display_language(language: &str, ext: Option<&str>) -> String {
    match (language, ext) {
        ("go", _) => "Go",
        ("java", _) => "Java",
        ("python", _) => "Python",
        ("typescript", Some("js" | "jsx")) => "JavaScript",
        ("typescript", _) => "TypeScript",
        (other, _) => other,
    }
    .to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::atomic::AtomicBool;

    use index::{full_run, IndexStore, RunEvents, RunResult};
    use ir::{
        Binding, BlockKind, Def, DefKind, Edge, FileSymbols, FlowBlock, FlowEvent, FlowFunction,
        FrontendError, LineRange, Picked, Role, SymbolTable,
    };
    use serde_json::json;

    /// Every file defines `f`; `FAIL` fails extraction. `lower` answers by marker in the
    /// source, else lowers `f` with one def and one use of `x`.
    struct Stub;

    impl Frontend for Stub {
        fn language(&self) -> &'static str {
            "stub"
        }

        fn extensions(&self) -> &'static [&'static str] {
            &["stub"]
        }

        fn extract(&self, path: &str, source: &str) -> Result<FileSymbols, FrontendError> {
            if source.contains("FAIL") {
                return Err(FrontendError::Parse {
                    path: path.to_owned(),
                    message: "FAIL".to_owned(),
                });
            }
            Ok(FileSymbols {
                language: "stub".to_owned(),
                path: path.to_owned(),
                defs: vec![Def {
                    kind: DefKind::Function,
                    qualified_name: "f".to_owned(),
                    parent: None,
                    range: LineRange { start: 1, end: 3 },
                }],
                imports: Vec::new(),
                refs: Vec::new(),
            })
        }

        fn resolve(&self, _: &[FileSymbols], _: &SymbolTable) -> Vec<Edge> {
            Vec::new()
        }

        fn lower(&self, _: &str, source: &str, at: Locate) -> Option<Result<Lowered, FlowError>> {
            let refusal = [
                ("PANIC", None),
                ("NOID", Some(FlowError::NoIdentifier)),
                ("NOTIN", Some(FlowError::NotInFunction { name: "x".into() })),
                (
                    "NOTLOCAL",
                    Some(FlowError::NotLocal {
                        name: "x".into(),
                        function: "f".into(),
                    }),
                ),
                ("FUNCGONE", Some(FlowError::FunctionGone)),
                ("VARGONE", Some(FlowError::VariableGone)),
            ]
            .into_iter()
            .find(|(marker, _)| source.contains(marker));
            match refusal {
                Some((_, None)) => panic!("boom"),
                Some((_, Some(e))) => Some(Err(e)),
                None => Some(Ok(Lowered {
                    function: tiny(),
                    picked: match at {
                        Locate::At(_) => Picked::Event(0),
                        Locate::Function { .. } => Picked::Binding(0),
                    },
                })),
            }
        }
    }

    fn tiny() -> FlowFunction {
        let block = |kind, lines: Option<(u32, u32)>| FlowBlock {
            kind,
            lines: lines.map(|(start, end)| LineRange { start, end }),
            first_line: String::new(),
        };
        let event = |role, line| FlowEvent {
            block: 1,
            binding: 0,
            role,
            pos: Pos { line, character: 4 },
            end_char: 5,
            capture: false,
        };
        FlowFunction {
            qualified_name: "f".to_owned(),
            blocks: vec![
                block(BlockKind::Entry, None),
                block(BlockKind::Basic, Some((2, 3))),
                block(BlockKind::Exit, None),
            ],
            branches: vec![(0, 1), (1, 2)],
            bindings: vec![Binding {
                name: "x".to_owned(),
                decl: Pos {
                    line: 2,
                    character: 4,
                },
            }],
            events: vec![event(Role::Def, 2), event(Role::Use, 3)],
        }
    }

    struct NoEvents;

    impl RunEvents for NoEvents {
        fn on_started(&self) {}
        fn on_scanned(&self, _: usize, _: usize) {}
        fn on_file_done(&self, _: usize, _: usize) {}
        fn on_finished(&self, _: &RunResult) {}
    }

    struct Workspace {
        dir: PathBuf,
        snapshot: std::sync::Arc<Snapshot>,
        registry: FrontendRegistry,
    }

    impl Drop for Workspace {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.dir);
        }
    }

    impl Workspace {
        fn new(name: &str) -> Self {
            let dir =
                std::env::temp_dir().join(format!("server-flow-{}-{name}", std::process::id()));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).unwrap();
            let dir = dir.canonicalize().unwrap();
            for (file, source) in [
                ("ok.stub", "ok"),
                ("noid.stub", "NOID"),
                ("notin.stub", "NOTIN"),
                ("notlocal.stub", "NOTLOCAL"),
                ("funcgone.stub", "FUNCGONE"),
                ("vargone.stub", "VARGONE"),
                ("panic.stub", "PANIC"),
                ("broken.stub", "FAIL"),
                ("excluded.stub", "ok"),
            ] {
                fs::write(dir.join(file), source).unwrap();
            }
            fs::write(dir.join("big.stub"), vec![b'a'; 1_048_577]).unwrap();
            let registry = FrontendRegistry::new(vec![Box::new(Stub)]);
            let roots = vec![dir.clone()];
            let exclude = ["excluded.stub".to_owned()];
            let cancel = AtomicBool::new(false);
            let result = full_run(&registry, &roots, &exclude, &cancel, &NoEvents).unwrap();
            let store = IndexStore::new();
            store.publish(result.graph, &result.cache);
            Self {
                dir,
                snapshot: store.snapshot().unwrap(),
                registry,
            }
        }

        fn call(&self, method: &str, params: Value) -> Answer<Value> {
            answer(method, params, &self.snapshot, &self.registry)
        }

        fn trace(&self, path: &Path) -> Value {
            let params = json!({"path": path, "line": 1, "character": 4});
            self.call(FLOW_TRACE, params).unwrap()
        }

        fn retrace(&self, function_id: &str) -> Value {
            let params = json!({"functionId": function_id, "variableKey": "x#1"});
            self.call(FLOW_RETRACE, params).unwrap()
        }
    }

    fn fn_id(path: &str) -> String {
        NodeId::new(NodeKind::Function, path, "f").to_string()
    }

    #[test]
    fn not_indexed_before_any_snapshot() {
        for method in [FLOW_TRACE, FLOW_RETRACE] {
            let err = handle(method, json!({}), None).unwrap_err();
            assert_eq!(err, (NOT_INDEXED, "NotIndexed".to_owned()));
        }
    }

    #[test]
    fn files_the_snapshot_did_not_index_are_refused() {
        let ws = Workspace::new("refused");
        for file in ["big.stub", "excluded.stub"] {
            assert_eq!(
                ws.trace(&ws.dir.join(file)),
                json!({"kind": "fileNotIndexed", "file": file})
            );
        }
        let outside = std::env::temp_dir().join("elsewhere/a.stub");
        assert_eq!(
            ws.trace(&outside),
            json!({"kind": "fileNotIndexed", "file": outside.to_string_lossy()})
        );
        assert_eq!(
            ws.trace(&ws.dir.join("broken.stub")),
            json!({"kind": "fileFailed", "file": "broken.stub"})
        );
        assert_eq!(
            ws.trace(&ws.dir.join("a.rb")),
            json!({"kind": "unsupportedLanguage", "language": null})
        );
        let err = ws.call(FLOW_TRACE, json!({"path": 1})).unwrap_err();
        assert_eq!(err.0, INVALID_PARAMS);
    }

    #[test]
    fn frontend_refusals_map_to_their_kinds() {
        let ws = Workspace::new("refusals");
        let cases = [
            ("noid.stub", json!({"kind": "noIdentifier"})),
            ("notin.stub", json!({"kind": "notInFunction", "name": "x"})),
            (
                "notlocal.stub",
                json!({"kind": "notLocal", "name": "x", "function": "f"}),
            ),
        ];
        for (file, expected) in cases {
            assert_eq!(ws.trace(&ws.dir.join(file)), expected, "{file}");
        }
    }

    #[test]
    fn a_trace_carries_its_function_id_and_the_solver_fields() {
        let ws = Workspace::new("trace");
        let answer = ws.trace(&ws.dir.join("ok.stub"));
        assert_eq!(answer["kind"], "trace", "{answer}");
        let trace = &answer["trace"];
        assert_eq!(trace["functionId"], fn_id("ok.stub"));
        assert_eq!(trace["functionName"], "f");
        assert_eq!(trace["variableKey"], "x#1");
        assert_eq!(trace["status"], "hops");
        assert_eq!(
            trace["hops"],
            json!([{"index": 1, "defOrdinal": 0, "useOrdinal": 1}])
        );

        let again = ws.retrace(&fn_id("ok.stub"));
        assert_eq!(again["kind"], "trace", "{again}");
        assert_eq!(again["trace"]["functionId"], fn_id("ok.stub"));
    }

    #[test]
    fn retrace_refusals() {
        let ws = Workspace::new("retrace");
        assert_eq!(
            ws.retrace("nope"),
            json!({"kind": "functionGone", "function": null})
        );
        assert_eq!(
            ws.retrace(&NodeId::file("ok.stub").to_string()),
            json!({"kind": "functionGone", "function": null})
        );
        assert_eq!(
            ws.retrace(&fn_id("vargone.stub")),
            json!({"kind": "variableGone", "variable": "x", "function": "f"})
        );
        assert_eq!(
            ws.retrace(&fn_id("funcgone.stub")),
            json!({"kind": "functionGone", "function": "f"})
        );
    }

    #[test]
    fn a_panicking_lower_is_an_internal_error() {
        let ws = Workspace::new("panic");
        let params = json!({"path": ws.dir.join("panic.stub"), "line": 0, "character": 0});
        let (code, message) = ws.call(FLOW_TRACE, params).unwrap_err();
        assert_eq!(code, INTERNAL_ERROR);
        assert_eq!(message, "lower panicked: boom");
        let (code, _) = ws
            .call(
                FLOW_RETRACE,
                json!({"functionId": fn_id("panic.stub"), "variableKey": "x#1"}),
            )
            .unwrap_err();
        assert_eq!(code, INTERNAL_ERROR);
    }

    #[test]
    fn display_names() {
        assert_eq!(display_language("go", Some("go")), "Go");
        assert_eq!(display_language("typescript", Some("tsx")), "TypeScript");
        assert_eq!(display_language("typescript", Some("jsx")), "JavaScript");
        assert_eq!(display_language("python", Some("py")), "Python");
        assert_eq!(display_language("java", Some("java")), "Java");
    }
}
