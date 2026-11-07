//! Binary-level `index/run` / `index/cancel` tests over `fixtures/go`; `index/filesChanged`
//! tests over a temp copy of `fixtures/typescript`.

mod common;

use std::fs;
use std::io::Write;
use std::path::PathBuf;

use common::{assert_error, copy_fixture, Sidecar, TempDir};
use rpc::framing::write_message;
use serde_json::{json, Value};

fn go() -> String {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../fixtures/go");
    path.canonicalize().unwrap().to_string_lossy().into_owned()
}

fn initialized() -> Sidecar {
    let mut s = Sidecar::spawn();
    s.initialize(1, &[&go()]);
    s
}

fn shutdown(mut s: Sidecar) {
    s.request(999, "shutdown", Value::Null);
    assert_eq!(s.finish().0, 0);
}

#[test]
fn invalid_root_starts_nothing() {
    let mut s = initialized();
    let response = s.request(
        2,
        "index/run",
        json!({ "roots": [go(), "/does/not/exist"] }),
    );
    assert_error(&response, json!(2), -32001);
    assert_eq!(response["error"]["message"], "InvalidRoots");
    assert_eq!(response["error"]["data"], "/does/not/exist");
    let (response, notes) = s.call(3, "index/cancel", json!({ "runId": 1 }));
    assert!(notes.is_empty(), "{notes:?}");
    assert_eq!(response["result"], json!({"cancelled": false}));
    assert_error(&s.request(4, "index/run", json!({})), json!(4), -32602);
    shutdown(s);
}

#[test]
fn a_second_run_supersedes_the_first() {
    let mut s = initialized();
    for id in [2, 3] {
        s.send(json!({"jsonrpc": "2.0", "id": id, "method": "index/run",
                      "params": { "roots": [go()] }}));
    }
    // Read until run 2 has ended (and, as it completes, its `graph/changed`).
    let mut messages = Vec::new();
    loop {
        let message = s.recv();
        let end = message["method"] == "graph/changed"
            && messages
                .iter()
                .any(|m: &Value| m["method"] == "index/done" && m["params"]["runId"] == 2);
        messages.push(message);
        if end {
            break;
        }
    }
    let run_ids: Vec<&Value> = messages
        .iter()
        .filter(|m| m.get("id").is_some())
        .map(|m| &m["result"]["runId"])
        .collect();
    assert_eq!(run_ids, [&json!(1), &json!(2)]);

    let done = |run: u64| -> Vec<usize> {
        messages
            .iter()
            .enumerate()
            .filter(|(_, m)| m["method"] == "index/done" && m["params"]["runId"] == run)
            .map(|(i, _)| i)
            .collect()
    };
    let (done1, done2) = (done(1), done(2));
    assert_eq!((done1.len(), done2.len()), (1, 1), "{messages:?}");
    let indexing: Vec<usize> = messages
        .iter()
        .enumerate()
        .filter(|(_, m)| m["method"] == "$/status" && m["params"]["state"] == "indexing")
        .map(|(i, _)| i)
        .collect();
    assert_eq!(indexing.len(), 2, "{messages:?}");
    assert!(done1[0] < indexing[1], "{messages:?}");
    assert_eq!(messages[done2[0]]["params"]["outcome"], "complete");

    // Every `graph/changed` directly follows (after nothing but itself) a complete run.
    for (i, m) in messages.iter().enumerate() {
        if m["method"] == "graph/changed" {
            let before = &messages[i - 1];
            assert_eq!(before["method"], "index/done", "{messages:?}");
            assert_eq!(before["params"]["outcome"], "complete", "{messages:?}");
        }
    }
    shutdown(s);
}

#[test]
fn cancelling_a_finished_or_unknown_run_is_false() {
    let mut s = initialized();
    let run_id = s.index_run(2, &[&go()], &[]);
    let notes = s.drain_run();
    assert!(notes
        .iter()
        .any(|n| n["method"] == "index/done" && n["params"]["runId"] == run_id));
    for (id, run) in [(3, run_id), (4, run_id + 7)] {
        let (response, _) = s.call(id, "index/cancel", json!({ "runId": run }));
        assert_eq!(
            response["result"],
            json!({"cancelled": false}),
            "{response}"
        );
    }
    shutdown(s);
}

#[test]
fn excluded_files_are_not_indexed_or_logged() {
    let mut s = initialized();
    s.index_run(2, &[&go()], &["**/util.go"]);
    let notes = s.drain_run();
    assert!(
        notes.iter().all(|n| !n.to_string().contains("util.go")),
        "{notes:?}"
    );
    let (files, _) = s.call(3, "graph/files", Value::Null);
    let names: Vec<&Value> = files["result"]["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|n| &n["name"])
        .collect();
    assert!(!names.contains(&&json!("util.go")), "{names:?}");
    assert!(names.contains(&&json!("main.go")), "{names:?}");
    shutdown(s);
}

fn result(response: Value) -> Value {
    assert!(response.get("error").is_none(), "{response}");
    response["result"].clone()
}

/// The id of the `kind` node named `name` in a `graph/files` / `graph/expand` slice.
fn id_of(slice: &Value, kind: &str, name: &str) -> Value {
    slice["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|n| n["kind"] == kind && n["name"] == name)
        .unwrap_or_else(|| panic!("no {kind} {name} in {slice}"))["id"]
        .clone()
}

fn files_changed(path: &str, kind: &str) -> Value {
    json!({"jsonrpc": "2.0", "method": "index/filesChanged",
           "params": { "changes": [{ "path": path, "type": kind }] }})
}

/// Reads notifications through the next `graph/changed`.
fn until_graph_changed(s: &mut Sidecar) -> Vec<Value> {
    let mut notes = Vec::new();
    loop {
        let note = s.recv();
        let done = note["method"] == "graph/changed";
        notes.push(note);
        if done {
            return notes;
        }
    }
}

/// Initialized over a temp copy of `fixtures/typescript` with one completed run.
fn ts_indexed() -> (Sidecar, TempDir) {
    let ws = copy_fixture("typescript");
    let root = ws.0.to_string_lossy().into_owned();
    let mut s = Sidecar::spawn();
    s.initialize(1, &[&root]);
    s.index_run(2, &[&root], &[]);
    s.drain_run();
    (s, ws)
}

fn expand(s: &mut Sidecar, id: i64, file: &str) -> Value {
    let files = result(s.request(id, "graph/files", Value::Null));
    let file_id = id_of(&files, "file", file);
    result(s.request(id + 1, "graph/expand", json!({ "fileId": file_id })))
}

#[test]
fn a_changed_file_is_reindexed_and_announced() {
    let (mut s, ws) = ts_indexed();
    let parse_env = id_of(&expand(&mut s, 3, "src/config.ts"), "function", "parseEnv");
    let config = ws.0.join("src/config.ts");
    let source = fs::read_to_string(&config).unwrap();
    fs::write(&config, source.replace("parseEnv", "readEnv")).unwrap();

    s.send(files_changed(&ws.path("src/config.ts"), "changed"));
    let notes = until_graph_changed(&mut s);

    // Nothing but the file's line and the announcement: no `$/status`, no progress.
    assert_eq!(notes.len(), 2, "{notes:?}");
    assert_eq!(
        notes[0]["params"],
        json!({"level": "info", "message": "Re-indexed src/config.ts"})
    );
    let removed = notes[1]["params"]["removedNodeIds"].as_array().unwrap();
    assert!(removed.contains(&parse_env), "{notes:?}");
    let config = expand(&mut s, 5, "src/config.ts");
    id_of(&config, "function", "readEnv");
    assert!(
        !config.to_string().contains(r#""name":"parseEnv""#),
        "{config}"
    );
    shutdown(s);
}

#[test]
fn a_deleted_file_is_removed_and_announced() {
    let (mut s, ws) = ts_indexed();
    let files = result(s.request(3, "graph/files", Value::Null));
    let util = id_of(&files, "file", "src/util/index.ts");
    fs::remove_file(ws.0.join("src/util/index.ts")).unwrap();

    s.send(files_changed(&ws.path("src/util/index.ts"), "deleted"));
    let notes = until_graph_changed(&mut s);

    assert_eq!(notes.len(), 2, "{notes:?}");
    assert_eq!(
        notes[0]["params"],
        json!({"level": "info", "message": "Removed src/util/index.ts"})
    );
    let removed = notes[1]["params"]["removedNodeIds"].as_array().unwrap();
    assert!(removed.contains(&util), "{notes:?}");
    shutdown(s);
}

#[test]
fn a_change_during_a_run_joins_its_single_publish() {
    let (mut s, ws) = ts_indexed();
    let config = ws.0.join("src/config.ts");
    let mut source = fs::read_to_string(&config).unwrap();
    source.push_str("export function freshFn(): void {}\n");
    fs::write(&config, source).unwrap();

    // Both in one write, so the change arrives while the run is pending.
    let run = json!({"jsonrpc": "2.0", "id": 3, "method": "index/run",
                     "params": { "roots": [ws.0] }});
    let mut bytes = Vec::new();
    write_message(&mut bytes, &serde_json::to_vec(&run).unwrap()).unwrap();
    let change = files_changed(&ws.path("src/config.ts"), "changed");
    write_message(&mut bytes, &serde_json::to_vec(&change).unwrap()).unwrap();
    let stdin = s.child.stdin.as_mut().unwrap();
    stdin.write_all(&bytes).unwrap();
    stdin.flush().unwrap();

    let messages = until_graph_changed(&mut s);
    assert_eq!(messages[0]["result"]["runId"], 2, "{messages:?}");
    let done = messages
        .iter()
        .position(|m| m["method"] == "index/done")
        .unwrap_or_else(|| panic!("no index/done in {messages:?}"));
    assert_eq!(messages[done]["params"]["outcome"], "complete");
    let reindexed = messages
        .iter()
        .position(|m| m["params"]["message"] == "Re-indexed src/config.ts")
        .unwrap_or_else(|| panic!("queued change not applied: {messages:?}"));
    assert!(reindexed < done, "{messages:?}");

    // No second `graph/changed` (or anything else) before the next response.
    let (files, notes) = s.call(4, "graph/files", Value::Null);
    assert!(notes.is_empty(), "{notes:?}");
    let file_id = id_of(&result(files), "file", "src/config.ts");
    let (config, notes) = s.call(5, "graph/expand", json!({ "fileId": file_id }));
    assert!(notes.is_empty(), "{notes:?}");
    id_of(&result(config), "function", "freshFn");
    shutdown(s);
}

#[test]
fn changes_without_a_complete_graph_are_ignored() {
    let mut s = Sidecar::spawn();
    let main = PathBuf::from(go()).join("main.go");
    let change = files_changed(&main.to_string_lossy(), "changed");
    s.send(change.clone());
    s.initialize(1, &[&go()]);
    s.send(change);
    s.send(json!({"jsonrpc": "2.0", "method": "index/filesChanged", "params": {"changes": 5}}));
    let (response, notes) = s.call(2, "graph/files", Value::Null);
    assert!(notes.is_empty(), "{notes:?}");
    assert_error(&response, json!(2), -32010);
    shutdown(s);
}
