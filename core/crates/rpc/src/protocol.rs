//! The shell's protocol (`design/api.md § 1`). `03-sidecar-lifecycle` mirrors these in TypeScript.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

pub const INITIALIZE: &str = "initialize";
pub const SHUTDOWN: &str = "shutdown";
pub const STATUS: &str = "$/status";
pub const LOG: &str = "$/log";
pub const GRAPH_FILES: &str = "graph/files";
pub const GRAPH_EXPAND: &str = "graph/expand";
pub const GRAPH_NODE: &str = "graph/node";
pub const GRAPH_NEIGHBOURHOOD: &str = "graph/neighbourhood";
pub const GRAPH_CHANGED: &str = "graph/changed";
pub const INDEX_RUN: &str = "index/run";
pub const INDEX_CANCEL: &str = "index/cancel";
pub const INDEX_PROGRESS: &str = "index/progress";
pub const INDEX_DONE: &str = "index/done";
pub const INDEX_FILES_CHANGED: &str = "index/filesChanged";
pub const FLOW_TRACE: &str = "flow/trace";
pub const FLOW_RETRACE: &str = "flow/retrace";

pub const PARSE_ERROR: i64 = -32700;
pub const INVALID_REQUEST: i64 = -32600;
pub const METHOD_NOT_FOUND: i64 = -32601;
pub const INVALID_PARAMS: i64 = -32602;
pub const INTERNAL_ERROR: i64 = -32603;
pub const INVALID_ROOTS: i64 = -32001;
pub const NOT_INITIALIZED: i64 = -32002;
pub const NOT_INDEXED: i64 = -32010;
pub const UNKNOWN_NODE: i64 = -32011;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InitializeParams {
    pub roots: Vec<PathBuf>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InitializeResult {
    pub server_version: String,
    pub languages: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusParams {
    pub state: ServerState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ServerState {
    Ready,
    Indexing,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogParams {
    pub level: LogLevel,
    pub message: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LogLevel {
    Info,
    Warn,
    Error,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphExpandParams {
    pub file_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphNodeParams {
    pub node_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphNeighbourhoodParams {
    pub node_id: String,
    pub hops: u8,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphChangedParams {
    pub removed_node_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexRunParams {
    pub roots: Vec<PathBuf>,
    /// Root-relative globs to leave out (`files.exclude`).
    #[serde(default)]
    pub exclude: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexRunResult {
    pub run_id: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexCancelParams {
    pub run_id: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexCancelResult {
    pub cancelled: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexProgressParams {
    pub run_id: u64,
    pub phase: IndexPhase,
    pub done: usize,
    pub total: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum IndexPhase {
    Scanning,
    Indexing,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexDoneParams {
    pub run_id: u64,
    pub outcome: IndexOutcome,
    pub indexed: usize,
    pub failed: usize,
    pub skipped: usize,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum IndexOutcome {
    Complete,
    Cancelled,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexFilesChangedParams {
    pub changes: Vec<FileChangeParams>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChangeParams {
    /// Absolute.
    pub path: PathBuf,
    /// Reported, but the sidecar re-syncs the path with disk whatever it is.
    #[serde(rename = "type")]
    pub kind: FileChangeKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FileChangeKind {
    Created,
    Changed,
    Deleted,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlowTraceParams {
    /// Absolute.
    pub path: PathBuf,
    /// 0-based.
    pub line: u32,
    /// 0-based UTF-16.
    pub character: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlowRetraceParams {
    pub function_id: String,
    pub variable_key: String,
}

/// A trace, or why there is none (`data-flow/design/api.md § 2`). `trace` is the solver's
/// trace plus `functionId`, kept untyped so `rpc` depends on nothing project-internal.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum FlowTraceResult {
    Trace { trace: serde_json::Value },
    UnsupportedLanguage { language: Option<String> },
    FileNotIndexed { file: String },
    FileFailed { file: String },
    NoIdentifier,
    NotInFunction { name: String },
    NotLocal { name: String, function: String },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum FlowRetraceResult {
    Trace { trace: serde_json::Value },
    FunctionGone { function: Option<String> },
    VariableGone { variable: String, function: String },
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::de::DeserializeOwned;
    use std::fmt::Debug;

    /// Serializes to exactly `json` and parses back to `value`.
    fn fixture<T: Serialize + DeserializeOwned + PartialEq + Debug>(value: T, json: &str) {
        assert_eq!(serde_json::to_string(&value).unwrap(), json);
        assert_eq!(serde_json::from_str::<T>(json).unwrap(), value);
    }

    #[test]
    fn initialize_params() {
        fixture(
            InitializeParams {
                roots: vec!["/a".into(), "/b c".into()],
            },
            r#"{"roots":["/a","/b c"]}"#,
        );
    }

    #[test]
    fn initialize_result() {
        fixture(
            InitializeResult {
                server_version: "0.1.0".into(),
                languages: ["go", "typescript", "python", "java"]
                    .map(String::from)
                    .into(),
            },
            r#"{"serverVersion":"0.1.0","languages":["go","typescript","python","java"]}"#,
        );
    }

    #[test]
    fn status_params() {
        fixture(
            StatusParams {
                state: ServerState::Ready,
                detail: None,
            },
            r#"{"state":"ready"}"#,
        );
        fixture(
            StatusParams {
                state: ServerState::Indexing,
                detail: None,
            },
            r#"{"state":"indexing"}"#,
        );
        fixture(
            StatusParams {
                state: ServerState::Indexing,
                detail: Some("3/10 files".into()),
            },
            r#"{"state":"indexing","detail":"3/10 files"}"#,
        );
    }

    #[test]
    fn log_params() {
        for (level, name) in [
            (LogLevel::Info, "info"),
            (LogLevel::Warn, "warn"),
            (LogLevel::Error, "error"),
        ] {
            fixture(
                LogParams {
                    level,
                    message: "m".into(),
                },
                &format!(r#"{{"level":"{name}","message":"m"}}"#),
            );
        }
    }

    #[test]
    fn graph_params() {
        fixture(
            GraphExpandParams {
                file_id: "a".into(),
            },
            r#"{"fileId":"a"}"#,
        );
        fixture(
            GraphNodeParams {
                node_id: "a".into(),
            },
            r#"{"nodeId":"a"}"#,
        );
        fixture(
            GraphNeighbourhoodParams {
                node_id: "a".into(),
                hops: 2,
            },
            r#"{"nodeId":"a","hops":2}"#,
        );
        fixture(
            GraphChangedParams {
                removed_node_ids: vec![],
            },
            r#"{"removedNodeIds":[]}"#,
        );
        fixture(
            GraphChangedParams {
                removed_node_ids: vec!["x".into(), "y".into()],
            },
            r#"{"removedNodeIds":["x","y"]}"#,
        );
    }

    #[test]
    fn index_params() {
        fixture(
            IndexRunParams {
                roots: vec!["/a".into()],
                exclude: vec!["**/.git".into()],
            },
            r#"{"roots":["/a"],"exclude":["**/.git"]}"#,
        );
        assert_eq!(
            serde_json::from_str::<IndexRunParams>(r#"{"roots":[]}"#)
                .unwrap()
                .exclude,
            Vec::<String>::new()
        );
        fixture(IndexRunResult { run_id: 1 }, r#"{"runId":1}"#);
        fixture(IndexCancelParams { run_id: 2 }, r#"{"runId":2}"#);
        fixture(
            IndexCancelResult { cancelled: true },
            r#"{"cancelled":true}"#,
        );
        fixture(
            IndexProgressParams {
                run_id: 1,
                phase: IndexPhase::Scanning,
                done: 0,
                total: 0,
            },
            r#"{"runId":1,"phase":"scanning","done":0,"total":0}"#,
        );
        fixture(
            IndexProgressParams {
                run_id: 1,
                phase: IndexPhase::Indexing,
                done: 3,
                total: 5,
            },
            r#"{"runId":1,"phase":"indexing","done":3,"total":5}"#,
        );
        for (outcome, name) in [
            (IndexOutcome::Complete, "complete"),
            (IndexOutcome::Cancelled, "cancelled"),
        ] {
            fixture(
                IndexDoneParams {
                    run_id: 1,
                    outcome,
                    indexed: 4,
                    failed: 1,
                    skipped: 0,
                    duration_ms: 12,
                },
                &format!(
                    r#"{{"runId":1,"outcome":"{name}","indexed":4,"failed":1,"skipped":0,"durationMs":12}}"#
                ),
            );
        }
    }

    #[test]
    fn files_changed_params() {
        fixture(
            IndexFilesChangedParams {
                changes: vec![FileChangeParams {
                    path: "/w/a.ts".into(),
                    kind: FileChangeKind::Deleted,
                }],
            },
            r#"{"changes":[{"path":"/w/a.ts","type":"deleted"}]}"#,
        );
        for (kind, name) in [
            (FileChangeKind::Created, "created"),
            (FileChangeKind::Changed, "changed"),
        ] {
            assert_eq!(
                serde_json::to_string(&kind).unwrap(),
                format!(r#""{name}""#)
            );
        }
    }

    #[test]
    fn flow_params() {
        fixture(
            FlowTraceParams {
                path: "/w/a.go".into(),
                line: 3,
                character: 7,
            },
            r#"{"path":"/w/a.go","line":3,"character":7}"#,
        );
        fixture(
            FlowRetraceParams {
                function_id: "f".into(),
                variable_key: "x#1".into(),
            },
            r#"{"functionId":"f","variableKey":"x#1"}"#,
        );
    }

    #[test]
    fn flow_results() {
        fixture(
            FlowTraceResult::Trace {
                trace: serde_json::json!({"functionId": "f"}),
            },
            r#"{"kind":"trace","trace":{"functionId":"f"}}"#,
        );
        fixture(
            FlowTraceResult::UnsupportedLanguage { language: None },
            r#"{"kind":"unsupportedLanguage","language":null}"#,
        );
        fixture(
            FlowTraceResult::UnsupportedLanguage {
                language: Some("Go".into()),
            },
            r#"{"kind":"unsupportedLanguage","language":"Go"}"#,
        );
        fixture(
            FlowTraceResult::FileNotIndexed {
                file: "a.go".into(),
            },
            r#"{"kind":"fileNotIndexed","file":"a.go"}"#,
        );
        fixture(
            FlowTraceResult::FileFailed {
                file: "a.go".into(),
            },
            r#"{"kind":"fileFailed","file":"a.go"}"#,
        );
        fixture(FlowTraceResult::NoIdentifier, r#"{"kind":"noIdentifier"}"#);
        fixture(
            FlowTraceResult::NotInFunction { name: "x".into() },
            r#"{"kind":"notInFunction","name":"x"}"#,
        );
        fixture(
            FlowTraceResult::NotLocal {
                name: "x".into(),
                function: "f".into(),
            },
            r#"{"kind":"notLocal","name":"x","function":"f"}"#,
        );
        fixture(
            FlowRetraceResult::Trace {
                trace: serde_json::json!({}),
            },
            r#"{"kind":"trace","trace":{}}"#,
        );
        fixture(
            FlowRetraceResult::FunctionGone { function: None },
            r#"{"kind":"functionGone","function":null}"#,
        );
        fixture(
            FlowRetraceResult::FunctionGone {
                function: Some("f".into()),
            },
            r#"{"kind":"functionGone","function":"f"}"#,
        );
        fixture(
            FlowRetraceResult::VariableGone {
                variable: "x".into(),
                function: "f".into(),
            },
            r#"{"kind":"variableGone","variable":"x","function":"f"}"#,
        );
    }
}
