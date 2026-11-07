//! Spawns `code-matrix-server` and talks framed JSON-RPC to it.
// Each test binary uses a different subset of the helpers.
#![allow(dead_code)]

use std::fs;
use std::io::BufReader;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};

use rpc::framing::{read_message, write_message};
use serde_json::{json, Value};

pub struct Sidecar {
    pub child: Child,
    stdout: BufReader<ChildStdout>,
}

impl Sidecar {
    pub fn spawn() -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_code-matrix-server"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let stdout = BufReader::new(child.stdout.take().unwrap());
        Self { child, stdout }
    }

    pub fn send_raw(&mut self, body: &[u8]) {
        write_message(self.child.stdin.as_mut().unwrap(), body).unwrap();
    }

    pub fn send(&mut self, msg: Value) {
        self.send_raw(&serde_json::to_vec(&msg).unwrap());
    }

    pub fn request(&mut self, id: i64, method: &str, params: Value) -> Value {
        self.send(json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params}));
        self.recv()
    }

    pub fn recv(&mut self) -> Value {
        let body = read_message(&mut self.stdout).unwrap().expect("a message");
        serde_json::from_slice(&body).unwrap()
    }

    /// Sends a request and reads past notifications to its response; returns the response
    /// and the notifications read before it.
    pub fn call(&mut self, id: i64, method: &str, params: Value) -> (Value, Vec<Value>) {
        self.send(json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params}));
        let mut notes = Vec::new();
        loop {
            let message = self.recv();
            if message.get("id").is_some() {
                assert_eq!(message["id"], id, "{message}");
                return (message, notes);
            }
            notes.push(message);
        }
    }

    /// Successful `initialize`; returns the one notification after its response
    /// (`$/log initialized…`). No run starts.
    pub fn initialize(&mut self, id: i64, roots: &[&str]) -> Vec<Value> {
        let response = self.request(id, "initialize", json!({ "roots": roots }));
        assert!(response.get("result").is_some(), "{response}");
        let note = self.recv();
        assert_eq!(note["method"], "$/log", "{note}");
        vec![note]
    }

    /// Successful `index/run`; returns its `runId`.
    pub fn index_run(&mut self, id: i64, roots: &[&str], exclude: &[&str]) -> u64 {
        let (response, notes) = self.call(
            id,
            "index/run",
            json!({ "roots": roots, "exclude": exclude }),
        );
        assert!(notes.is_empty(), "{notes:?}");
        response["result"]["runId"]
            .as_u64()
            .unwrap_or_else(|| panic!("{response}"))
    }

    /// Reads notifications through `graph/changed`, asserting `indexing` precedes `ready`.
    pub fn drain_run(&mut self) -> Vec<Value> {
        let mut notes = Vec::new();
        loop {
            let note = self.recv();
            assert!(note.get("id").is_none(), "unexpected response {note}");
            let done = note["method"] == "graph/changed";
            notes.push(note);
            if done {
                break;
            }
        }
        let state = |s: &str| {
            notes
                .iter()
                .position(|n| n["method"] == "$/status" && n["params"]["state"] == s)
                .unwrap_or_else(|| panic!("no {s} status in {notes:?}"))
        };
        assert!(state("indexing") < state("ready"), "{notes:?}");
        notes
    }

    /// Closes stdin, asserts stdout holds nothing more, returns (exit code, stderr).
    pub fn finish(mut self) -> (i32, String) {
        drop(self.child.stdin.take());
        assert_eq!(read_message(&mut self.stdout).unwrap(), None);
        let out = self.child.wait_with_output().unwrap();
        (
            out.status.code().unwrap(),
            String::from_utf8(out.stderr).unwrap(),
        )
    }
}

/// A directory under the system temp dir, removed on drop.
pub struct TempDir(pub PathBuf);

impl TempDir {
    /// `rel` under the directory, as a string for JSON params.
    pub fn path(&self, rel: &str) -> String {
        self.0.join(rel).to_string_lossy().into_owned()
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// A fresh copy of `fixtures/<lang>`, canonicalized, unique per call.
pub fn copy_fixture(lang: &str) -> TempDir {
    static NEXT: AtomicUsize = AtomicUsize::new(0);
    let n = NEXT.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!("server-{lang}-{}-{n}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    let from = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../fixtures")
        .join(lang);
    copy(&from, &dir);
    TempDir(dir.canonicalize().unwrap())
}

fn copy(from: &Path, to: &Path) {
    fs::create_dir_all(to).unwrap();
    for entry in fs::read_dir(from).unwrap() {
        let entry = entry.unwrap();
        let target = to.join(entry.file_name());
        if entry.file_type().unwrap().is_dir() {
            copy(&entry.path(), &target);
        } else {
            fs::copy(entry.path(), target).unwrap();
        }
    }
}

pub fn assert_error(response: &Value, id: Value, code: i64) {
    assert_eq!(response["jsonrpc"], "2.0");
    assert_eq!(response["id"], id, "{response}");
    assert_eq!(response["error"]["code"], code, "{response}");
}
