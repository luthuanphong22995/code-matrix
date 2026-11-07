//! End-to-end `flow/*` over the real binary and a copy of `fixtures/go`, plus the Go data-flow
//! fixture `config.go` under `flow/`.

mod common;

use std::collections::BTreeSet;
use std::fs;
use std::path::PathBuf;

use common::{assert_error, copy_fixture, Sidecar, TempDir};
use serde_json::{json, Value};

/// Initialized over a copy of `fixtures/go` (plus `flow/config.go`) with one completed run.
fn indexed() -> (Sidecar, TempDir) {
    let ws = copy_fixture("go");
    fs::create_dir_all(ws.0.join("flow")).unwrap();
    let config = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../frontend-go/tests/fixtures/flow/config.go");
    fs::copy(config, ws.0.join("flow/config.go")).unwrap();
    let root = ws.path("");
    let mut s = Sidecar::spawn();
    s.initialize(1, &[&root]);
    s.index_run(2, &[&root], &[]);
    s.drain_run();
    (s, ws)
}

fn result(response: Value) -> Value {
    assert!(response.get("error").is_none(), "{response}");
    response["result"].clone()
}

fn trace_at(s: &mut Sidecar, id: i64, path: &str, line: u32, character: u32) -> Value {
    let params = json!({"path": path, "line": line, "character": character});
    result(s.request(id, "flow/trace", params))
}

#[test]
fn errors_before_a_snapshot_and_on_bad_params() {
    let ws = copy_fixture("go");
    let root = ws.path("");
    let mut s = Sidecar::spawn();
    let params = json!({"path": ws.path("main.go"), "line": 0, "character": 0});
    assert_error(
        &s.request(1, "flow/trace", params.clone()),
        json!(1),
        -32002,
    );
    s.initialize(2, &[&root]);
    let response = s.request(3, "flow/trace", params);
    assert_error(&response, json!(3), -32010);
    assert_eq!(response["error"]["message"], "NotIndexed");
    let retrace = json!({"functionId": "x", "variableKey": "x#1"});
    assert_error(&s.request(4, "flow/retrace", retrace), json!(4), -32010);

    s.index_run(5, &[&root], &[]);
    s.drain_run();
    assert_error(
        &s.request(6, "flow/trace", json!({"path": 1})),
        json!(6),
        -32602,
    );
    assert_error(&s.request(7, "flow/retrace", json!({})), json!(7), -32602);
    s.request(8, "shutdown", Value::Null);
    assert_eq!(s.finish().0, 0);
}

#[test]
fn refusals_after_a_run() {
    let (mut s, ws) = indexed();
    // Python and JS now lower, so a file missing from the graph is not indexed.
    assert_eq!(
        trace_at(&mut s, 10, &ws.path("x.py"), 0, 0),
        json!({"kind": "fileNotIndexed", "file": "x.py"})
    );
    assert_eq!(
        trace_at(&mut s, 11, &ws.path("x.js"), 0, 0),
        json!({"kind": "fileNotIndexed", "file": "x.js"})
    );
    assert_eq!(
        trace_at(&mut s, 12, &ws.path("x.rb"), 0, 0),
        json!({"kind": "unsupportedLanguage", "language": null})
    );
    assert_eq!(
        trace_at(&mut s, 13, &ws.path("broken/broken.go"), 0, 0),
        json!({"kind": "fileFailed", "file": "broken/broken.go"})
    );
    assert_eq!(
        trace_at(&mut s, 14, &ws.path("new.go"), 0, 0),
        json!({"kind": "fileNotIndexed", "file": "new.go"})
    );
    let retrace = json!({"functionId": "nope", "variableKey": "x#1"});
    assert_eq!(
        result(s.request(15, "flow/retrace", retrace)),
        json!({"kind": "functionGone", "function": null})
    );
    s.request(16, "shutdown", Value::Null);
    assert_eq!(s.finish().0, 0);
}

/// `(def line, use line)` of every hop.
fn hop_lines(trace: &Value) -> BTreeSet<(u64, u64)> {
    let line = |ordinal: &Value| {
        trace["occurrences"]
            .as_array()
            .unwrap()
            .iter()
            .find(|o| o["ordinal"] == *ordinal)
            .unwrap()["line"]
            .as_u64()
            .unwrap()
    };
    trace["hops"]
        .as_array()
        .unwrap()
        .iter()
        .map(|h| (line(&h["defOrdinal"]), line(&h["useOrdinal"])))
        .collect()
}

#[test]
fn go_trace_and_retrace() {
    let (mut s, ws) = indexed();
    // The read of `total` in `return total` on line 18 (0-based 17), after two tabs.
    let answer = trace_at(&mut s, 10, &ws.path("flow/config.go"), 17, 9);
    assert_eq!(answer["kind"], "trace", "{answer}");
    let trace = &answer["trace"];
    assert_eq!(trace["variable"], "total");
    assert_eq!(trace["functionName"], "parseConfig");
    assert!(trace["functionId"].is_string(), "{trace}");
    let expected = BTreeSet::from([(12, 14), (14, 14), (12, 18), (14, 18)]);
    assert_eq!(hop_lines(trace), expected);

    let node = result(s.request(11, "graph/node", json!({"nodeId": trace["functionId"]})));
    assert!(node.to_string().contains("parseConfig"), "{node}");

    let params = json!({"functionId": trace["functionId"], "variableKey": trace["variableKey"]});
    let again = result(s.request(12, "flow/retrace", params));
    assert_eq!(again["kind"], "trace", "{again}");
    assert_eq!(again["trace"]["functionId"], trace["functionId"]);
    assert_eq!(hop_lines(&again["trace"]), expected);
    s.request(13, "shutdown", Value::Null);
    assert_eq!(s.finish().0, 0);
}

#[test]
fn a_trace_during_a_run_answers_from_the_previous_snapshot() {
    let (mut s, ws) = indexed();
    let root = ws.path("");
    s.index_run(10, &[&root], &[]);
    let params = json!({"path": ws.path("broken/broken.go"), "line": 0, "character": 0});
    let (response, _) = s.call(11, "flow/trace", params);
    assert_eq!(
        result(response),
        json!({"kind": "fileFailed", "file": "broken/broken.go"})
    );
    s.call(12, "shutdown", Value::Null);
    assert_eq!(s.finish().0, 0);
}
