//! End-to-end `graph/*` over the real fixtures. Node ids come from responses, never hard-coded.

mod common;

use std::path::PathBuf;

use common::{assert_error, Sidecar};
use serde_json::{json, Value};

fn fixture(lang: &str) -> String {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../fixtures")
        .join(lang);
    path.canonicalize().unwrap().to_string_lossy().into_owned()
}

fn result(response: Value) -> Value {
    assert!(response.get("error").is_none(), "{response}");
    response["result"].clone()
}

fn items<'a>(slice: &'a Value, key: &str) -> &'a Vec<Value> {
    slice[key].as_array().unwrap()
}

fn node_named<'a>(slice: &'a Value, kind: &str, name: &str) -> &'a Value {
    items(slice, "nodes")
        .iter()
        .find(|n| n["kind"] == kind && n["name"] == name)
        .unwrap_or_else(|| panic!("no {kind} {name} in {slice}"))
}

/// Initialized over `lang`'s fixture with one completed run.
fn indexed(lang: &str) -> Sidecar {
    let mut s = Sidecar::spawn();
    s.initialize(1, &[&fixture(lang)]);
    s.index_run(100, &[&fixture(lang)], &[]);
    s.drain_run();
    s
}

fn go() -> Sidecar {
    indexed("go")
}

#[test]
fn go_run_notifications_in_order() {
    let mut s = Sidecar::spawn();
    s.initialize(1, &[&fixture("go")]);
    assert_eq!(s.index_run(2, &[&fixture("go")], &[]), 1);
    let notes = s.drain_run();
    let mut notes = notes.iter();
    let mut next = || notes.next().expect("more notifications");
    assert_eq!(next()["params"], json!({"state": "indexing"}));
    assert_eq!(
        next()["params"],
        json!({"level": "info", "message": "Index run started: 1 roots"})
    );
    let progress = next();
    assert_eq!(progress["method"], "index/progress");
    assert_eq!(
        progress["params"],
        json!({"runId": 1, "phase": "scanning", "done": 0, "total": 0})
    );
    // Indexing progress until the final count, which is always sent.
    let last = loop {
        let note = next();
        assert_eq!(note["method"], "index/progress", "{note}");
        assert_eq!(note["params"]["phase"], "indexing", "{note}");
        let params = &note["params"];
        if params["done"] == params["total"] {
            break params.clone();
        }
    };
    assert_eq!(last["total"], 5, "{last}");
    let failed = next();
    assert_eq!(failed["params"]["level"], "error");
    let message = failed["params"]["message"].as_str().unwrap();
    assert!(
        message.starts_with("Failed broken/broken.go: "),
        "{message}"
    );
    let complete = next()["params"]["message"].as_str().unwrap().to_owned();
    assert!(
        complete.starts_with("Index run complete: 4 indexed, 1 failed, 0 skipped in "),
        "{complete}"
    );
    assert_eq!(
        next()["params"],
        json!({"state": "ready", "detail": "Indexed 4 files, 1 failed"})
    );
    let done = next();
    assert_eq!(done["method"], "index/done");
    assert_eq!(
        (
            &done["params"]["runId"],
            &done["params"]["outcome"],
            &done["params"]["indexed"],
            &done["params"]["failed"],
            &done["params"]["skipped"]
        ),
        (
            &json!(1),
            &json!("complete"),
            &json!(4),
            &json!(1),
            &json!(0)
        )
    );
    assert!(done["params"]["durationMs"].is_u64(), "{done}");
    assert_eq!(
        *next(),
        json!({"jsonrpc": "2.0", "method": "graph/changed", "params": {"removedNodeIds": []}})
    );
    s.request(3, "shutdown", Value::Null);
    assert_eq!(s.finish().0, 0);
}

#[test]
fn graph_requests_before_any_run_are_not_indexed() {
    let mut s = Sidecar::spawn();
    s.initialize(1, &[&fixture("go")]);
    let response = s.request(2, "graph/files", Value::Null);
    assert_error(&response, json!(2), -32010);
    s.request(3, "shutdown", Value::Null);
    assert_eq!(s.finish().0, 0);
}

#[test]
fn go_files_layer() {
    let mut s = go();
    let files = result(s.request(2, "graph/files", Value::Null));
    let mut paths: Vec<&str> = items(&files, "nodes")
        .iter()
        .filter(|n| n["kind"] == "file")
        .map(|n| n["name"].as_str().unwrap())
        .collect();
    paths.sort_unstable();
    assert_eq!(
        paths,
        [
            "broken/broken.go",
            "config.go",
            "internal/db/conn.go",
            "main.go",
            "util.go"
        ]
    );
    assert!(items(&files, "nodes")
        .iter()
        .all(|n| n["kind"] == "file" || n["kind"] == "unresolved"));
    assert!(items(&files, "edges")
        .iter()
        .all(|e| e["kind"] == "imports"));

    let id = |name: &str| node_named(&files, "file", name)["id"].clone();
    let fmt = node_named(&files, "unresolved", "fmt")["id"].clone();
    let edges: Vec<(Value, Value, Value)> = items(&files, "edges")
        .iter()
        .map(|e| {
            (
                e["fromId"].clone(),
                e["toId"].clone(),
                e["resolved"].clone(),
            )
        })
        .collect();
    assert_eq!(edges.len(), 2, "{files}");
    assert!(edges.contains(&(id("config.go"), id("internal/db/conn.go"), json!(true))));
    assert!(edges.contains(&(id("main.go"), fmt, json!(false))));
    let total = files["total"].as_u64().unwrap();
    assert!(
        total > items(&files, "nodes").len() as u64,
        "total counts symbols: {files}"
    );
    s.request(3, "shutdown", Value::Null);
    assert_eq!(s.finish().0, 0);
}

#[test]
fn go_expand_and_node() {
    let mut s = go();
    let files = result(s.request(2, "graph/files", Value::Null));
    let config = result(s.request(
        3,
        "graph/expand",
        json!({"fileId": node_named(&files, "file", "config.go")["id"]}),
    ));
    let parse_config = node_named(&config, "function", "parseConfig")["id"].clone();
    assert!(items(&config, "edges")
        .iter()
        .any(|e| e["kind"] == "contains" && e["toId"] == parse_config));

    let main_go = result(s.request(
        4,
        "graph/expand",
        json!({"fileId": node_named(&files, "file", "main.go")["id"]}),
    ));
    let main = node_named(&main_go, "function", "main")["id"].clone();
    assert!(
        items(&config, "edges").iter().all(|e| e["fromId"] != main),
        "config.go's expansion has main's call into it"
    );
    let fetch = node_named(&main_go, "unresolved", "fetchData")["id"].clone();
    let calls = |to: &Value| {
        items(&main_go, "edges")
            .iter()
            .find(|e| e["kind"] == "calls" && e["fromId"] == main && e["toId"] == *to)
            .unwrap_or_else(|| panic!("no main → {to} in {main_go}"))["resolved"]
            .clone()
    };
    assert_eq!(calls(&parse_config), json!(true));
    assert_eq!(calls(&fetch), json!(false));

    let detail = result(s.request(5, "graph/node", json!({"nodeId": parse_config})));
    let inbound_calls: Vec<&Value> = items(&detail, "inbound")
        .iter()
        .filter(|e| e["kind"] == "calls")
        .collect();
    assert_eq!(inbound_calls.len(), 1, "{detail}");
    assert_eq!(inbound_calls[0]["fromId"], main);
    let mut far_ends: Vec<&str> = items(&detail, "inbound")
        .iter()
        .map(|e| (e, "fromId"))
        .chain(items(&detail, "outbound").iter().map(|e| (e, "toId")))
        .filter(|(e, _)| e["kind"] != "contains")
        .map(|(e, end)| e[end].as_str().unwrap())
        .collect();
    far_ends.sort_unstable();
    far_ends.dedup();
    let linked: Vec<&str> = items(&detail, "linked")
        .iter()
        .map(|n| n["id"].as_str().unwrap())
        .collect();
    assert_eq!(linked, far_ends, "{detail}");
    assert!(linked.contains(&main.as_str().unwrap()));

    let hood = result(s.request(
        9,
        "graph/neighbourhood",
        json!({"nodeId": parse_config, "hops": 1}),
    ));
    // parseConfig, its file config.go, its caller main, and main's file main.go (ancestor).
    let config_go = &node_named(&files, "file", "config.go")["id"];
    let main_go_id = &node_named(&files, "file", "main.go")["id"];
    for want in [&parse_config, &main, config_go, main_go_id] {
        assert!(
            items(&hood, "nodes").iter().any(|n| n["id"] == *want),
            "{want} not in {hood}"
        );
    }
    assert_error(
        &s.request(
            10,
            "graph/neighbourhood",
            json!({"nodeId": "nope", "hops": 1}),
        ),
        json!(10),
        -32011,
    );

    let unknown = s.request(6, "graph/expand", json!({"fileId": "nope"}));
    assert_error(&unknown, json!(6), -32011);
    assert_eq!(unknown["error"]["message"], "UnknownNode");
    assert_error(
        &s.request(7, "graph/expand", json!({"fileId": parse_config})),
        json!(7),
        -32011,
    );
    s.request(8, "shutdown", Value::Null);
    assert_eq!(s.finish().0, 0);
}

#[test]
fn other_languages_smoke() {
    for lang in ["typescript", "python", "java"] {
        let mut s = indexed(lang);
        let files = result(s.request(2, "graph/files", Value::Null));
        assert!(
            items(&files, "nodes").iter().any(|n| n["kind"] == "file"),
            "{lang}: {files}"
        );
        s.request(3, "shutdown", Value::Null);
        assert_eq!(s.finish().0, 0, "{lang}");
    }
}
