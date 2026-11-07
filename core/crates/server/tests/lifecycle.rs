//! Binary-level lifecycle tests: spawn `code-matrix-server` and talk framed JSON-RPC to it.

mod common;

use common::{assert_error, Sidecar};
use serde_json::{json, Value};

const TMP: &str = env!("CARGO_TARGET_TMPDIR");
const MANIFEST: &str = env!("CARGO_MANIFEST_DIR");

#[test]
fn initialize_then_shutdown() {
    let mut s = Sidecar::spawn();
    assert_eq!(
        s.request(1, "initialize", json!({ "roots": [TMP] })),
        json!({"jsonrpc": "2.0", "id": 1, "result": {
            "serverVersion": env!("CARGO_PKG_VERSION"),
            "languages": ["go", "typescript", "python", "java"]
        }})
    );
    assert_eq!(
        s.recv(),
        json!({"jsonrpc": "2.0", "method": "$/log",
               "params": {"level": "info", "message": "initialized with 1 roots"}})
    );
    // No run starts: the next frame is the shutdown response, not a `$/status`.
    assert_eq!(
        s.request(2, "shutdown", Value::Null),
        json!({"jsonrpc": "2.0", "id": 2, "result": null})
    );
    assert_eq!(s.finish().0, 0);
}

#[test]
fn request_before_initialize_is_not_initialized() {
    let mut s = Sidecar::spawn();
    let response = s.request(1, "shutdown", Value::Null);
    assert_error(&response, json!(1), -32002);
    assert_eq!(response["error"]["message"], "NotInitialized");
    for (id, method) in [(4, "index/run"), (5, "index/cancel")] {
        let response = s.request(id, method, json!({ "roots": [TMP], "runId": 1 }));
        assert_error(&response, json!(id), -32002);
    }
    assert!(s.child.try_wait().unwrap().is_none(), "server exited");
    s.initialize(2, &[TMP]);
    s.request(3, "shutdown", Value::Null);
    assert_eq!(s.finish().0, 0);
}

#[test]
fn missing_root_is_invalid_roots() {
    let mut s = Sidecar::spawn();
    let response = s.request(
        1,
        "initialize",
        json!({ "roots": [TMP, "/does/not/exist"] }),
    );
    assert_error(&response, json!(1), -32001);
    assert_eq!(response["error"]["message"], "InvalidRoots");
    assert_eq!(response["error"]["data"], "/does/not/exist");
    assert_error(&s.request(2, "shutdown", Value::Null), json!(2), -32002);
    assert_eq!(s.finish().0, 1);
}

#[test]
fn two_roots_one_workspace_then_unknown_method() {
    let mut s = Sidecar::spawn();
    let notes = s.initialize(1, &[TMP, MANIFEST]);
    assert_eq!(notes[0]["params"]["message"], "initialized with 2 roots");
    assert_error(&s.request(2, "nope/nope", json!({})), json!(2), -32601);
    assert_eq!(s.finish().0, 1);
}

#[test]
fn invalid_json_is_parse_error() {
    let mut s = Sidecar::spawn();
    s.send_raw(b"{not json");
    assert_error(&s.recv(), Value::Null, -32700);
    s.initialize(1, &[TMP]);
    assert_eq!(s.finish().0, 1);
}

#[test]
fn second_initialize_is_invalid_request_and_notifications_get_no_reply() {
    let mut s = Sidecar::spawn();
    s.initialize(1, &[TMP]);
    let response = s.request(2, "initialize", json!({ "roots": [TMP] }));
    assert_error(&response, json!(2), -32600);
    s.send(json!({"jsonrpc": "2.0", "method": "$/cancelRequest", "params": {"id": 2}}));
    assert_eq!(
        s.request(3, "shutdown", Value::Null),
        json!({"jsonrpc": "2.0", "id": 3, "result": null})
    );
    assert_eq!(s.finish().0, 0);
}

#[test]
fn stdin_eof_without_shutdown_exits_non_zero() {
    let s = Sidecar::spawn();
    let (code, stderr) = s.finish();
    assert_ne!(code, 0);
    assert!(stderr.contains("without shutdown"), "{stderr}");
}
