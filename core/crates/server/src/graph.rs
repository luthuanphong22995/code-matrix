//! `graph/*` requests and the background index run (`code-graph/design/api.md § 1`,
//! `workspace-index/design/api.md § 1`).

use std::any::Any;
use std::io::{self, Write};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use frontend_go::GoFrontend;
use frontend_java::JavaFrontend;
use frontend_python::PythonFrontend;
use frontend_typescript::TypeScriptFrontend;
use index::{
    apply_changes, full_run, ChangeLine, FileCache, FrontendRegistry, IndexStore, RunEvents,
    RunResult,
};
use ir::{Graph, NodeId};
use rpc::framing::write_message;
use rpc::message::Notification;
use rpc::protocol::{
    GraphChangedParams, GraphExpandParams, GraphNeighbourhoodParams, GraphNodeParams,
    IndexDoneParams, IndexOutcome, IndexPhase, IndexProgressParams, LogLevel, LogParams,
    ServerState, StatusParams, GRAPH_CHANGED, GRAPH_EXPAND, GRAPH_FILES, GRAPH_NEIGHBOURHOOD,
    GRAPH_NODE, INDEX_DONE, INDEX_PROGRESS, INVALID_PARAMS, LOG, METHOD_NOT_FOUND, NOT_INDEXED,
    STATUS, UNKNOWN_NODE,
};
use serde_json::Value;

/// The one stdout writer shared by the dispatch loop and the run thread; `None` once
/// `shutdown` has been answered.
pub type Out = Arc<Mutex<Option<Box<dyn Write + Send>>>>;

pub fn out(writer: impl Write + Send + 'static) -> Out {
    Arc::new(Mutex::new(Some(Box::new(writer))))
}

/// Writes one whole frame under the lock; nothing once the writer is closed. With `close`,
/// the writer is closed under the same lock right after the frame.
pub fn send(out: &Out, body: &[u8], close: bool) -> io::Result<()> {
    let mut guard = out.lock().unwrap_or_else(PoisonError::into_inner);
    let result = match guard.as_mut() {
        Some(writer) => write_message(writer, body),
        None => Ok(()),
    };
    if close {
        *guard = None;
    }
    result
}

/// Sends a notification from the run thread; a write error means the client is gone.
fn notify(out: &Out, method: &str, params: serde_json::Result<Value>) {
    if let Ok(body) = params.and_then(|p| serde_json::to_vec(&Notification::new(method, p))) {
        let _ = send(out, &body, false);
    }
}

fn log(out: &Out, level: LogLevel, message: String) {
    notify(out, LOG, serde_json::to_value(LogParams { level, message }));
}

fn status(out: &Out, state: ServerState, detail: Option<String>) {
    notify(
        out,
        STATUS,
        serde_json::to_value(StatusParams { state, detail }),
    );
}

/// Go, TypeScript, Python and Java, in that order.
pub fn registry(roots: &[PathBuf]) -> FrontendRegistry {
    // ponytail: Go is single-root, so with several roots in-module imports outside the
    // first root become placeholders; make frontend-go map path prefix → root if it matters.
    let go_root = roots.first().cloned().unwrap_or_default();
    FrontendRegistry::new(vec![
        Box::new(GoFrontend::new(go_root)),
        Box::new(TypeScriptFrontend),
        Box::new(PythonFrontend),
        Box::new(JavaFrontend),
    ])
}

/// Answers `graph/files`, `graph/expand`, `graph/node` or `graph/neighbourhood` from `snapshot`.
pub fn handle(
    method: &str,
    params: Value,
    snapshot: Option<&Graph>,
) -> Result<Value, (i64, String)> {
    let graph = snapshot.ok_or((NOT_INDEXED, "NotIndexed".to_owned()))?;
    let bad_params = |e: serde_json::Error| (INVALID_PARAMS, e.to_string());
    let unknown = |_| (UNKNOWN_NODE, "UnknownNode".to_owned());
    let result = match method {
        GRAPH_FILES => serde_json::to_value(export::files_layer(graph)).map(|mut files| {
            // The panel picks scoped view from the whole graph's size (code-graph R13).
            files["total"] = graph.node_count().into();
            files
        }),
        GRAPH_EXPAND => {
            let params: GraphExpandParams = serde_json::from_value(params).map_err(bad_params)?;
            serde_json::to_value(export::expand(graph, &node_id(params.file_id)).map_err(unknown)?)
        }
        GRAPH_NODE => {
            let params: GraphNodeParams = serde_json::from_value(params).map_err(bad_params)?;
            serde_json::to_value(
                export::node_detail(graph, &node_id(params.node_id)).map_err(unknown)?,
            )
        }
        GRAPH_NEIGHBOURHOOD => {
            let params: GraphNeighbourhoodParams =
                serde_json::from_value(params).map_err(bad_params)?;
            serde_json::to_value(
                export::neighbourhood(graph, &node_id(params.node_id), params.hops)
                    .map_err(unknown)?,
            )
        }
        _ => return Err((METHOD_NOT_FOUND, format!("unknown method: {method}"))),
    };
    result.map_err(|e| (INVALID_PARAMS, e.to_string()))
}

/// `NodeId` has no public string constructor; it deserializes transparently from one.
pub(crate) fn node_id(id: String) -> NodeId {
    serde_json::from_value(Value::String(id)).expect("NodeId is a transparent string")
}

/// Minimum gap between two `index/progress indexing` notifications.
const PROGRESS_EVERY: Duration = Duration::from_millis(100);

/// Reports one run's progress and outcome; built inside the run thread.
struct Reporter {
    run_id: u64,
    roots: usize,
    out: Out,
    done: AtomicUsize,
    total: AtomicUsize,
    last_progress: Mutex<Instant>,
    started: Instant,
}

impl Reporter {
    fn new(run_id: u64, roots: usize, out: Out) -> Self {
        let now = Instant::now();
        Self {
            run_id,
            roots,
            out,
            done: AtomicUsize::new(0),
            total: AtomicUsize::new(0),
            last_progress: Mutex::new(now),
            started: now,
        }
    }

    fn progress(&self, phase: IndexPhase, done: usize, total: usize) {
        let params = IndexProgressParams {
            run_id: self.run_id,
            phase,
            done,
            total,
        };
        notify(&self.out, INDEX_PROGRESS, serde_json::to_value(params));
    }

    fn done(&self, outcome: IndexOutcome, indexed: usize, failed: usize, skipped: usize) {
        let params = IndexDoneParams {
            run_id: self.run_id,
            outcome,
            indexed,
            failed,
            skipped,
            duration_ms: u64::try_from(self.started.elapsed().as_millis()).unwrap_or(u64::MAX),
        };
        notify(&self.out, INDEX_DONE, serde_json::to_value(params));
    }

    /// Publishes `result`, with the changes queued meanwhile applied, only if this run's
    /// `swap(true)` wins over any `index/cancel`; otherwise reports the run cancelled and
    /// drops the queue. Holds `live.cache` throughout, so no single-file publish interleaves.
    fn finish(&self, result: Option<RunResult>, cancel: &AtomicBool, live: &Live) {
        let (mut cache, queue) = live.end_run();
        let Some(result) = result.filter(|_| !cancel.swap(true, Ordering::SeqCst)) else {
            let message = format!(
                "Index run cancelled after {} of {} files",
                self.done.load(Ordering::Relaxed),
                self.total.load(Ordering::Relaxed)
            );
            log(&self.out, LogLevel::Info, message);
            status(&self.out, ServerState::Ready, None);
            self.done(IndexOutcome::Cancelled, 0, 0, 0);
            return;
        };
        for (path, reason) in &result.failed {
            let message = format!("Failed {path}: {reason}");
            log(&self.out, LogLevel::Error, message);
        }
        for (path, _) in &result.skipped {
            let message = format!("Skipped {path}: file exceeds 1 MB");
            log(&self.out, LogLevel::Warn, message);
        }
        let (indexed, failed, skipped) =
            (result.indexed, result.failed.len(), result.skipped.len());
        let message = format!(
            "Index run complete: {indexed} indexed, {failed} failed, {skipped} skipped in {:.1} s",
            self.started.elapsed().as_secs_f64()
        );
        log(&self.out, LogLevel::Info, message);
        let RunResult {
            graph,
            cache: mut run_cache,
            ..
        } = result;
        let applied = if queue.is_empty() {
            None
        } else {
            apply(&self.out, &mut run_cache, &queue)
        };
        let removed = live.store.publish(applied.unwrap_or(graph), &run_cache);
        let mut detail = format!("Indexed {indexed} files");
        if failed > 0 {
            detail.push_str(&format!(", {failed} failed"));
        }
        status(&self.out, ServerState::Ready, Some(detail));
        self.done(IndexOutcome::Complete, indexed, failed, skipped);
        graph_changed(&self.out, &removed);
        *cache = Some(run_cache);
    }
}

fn graph_changed(out: &Out, removed: &[NodeId]) {
    let removed_node_ids = removed.iter().map(ToString::to_string).collect();
    let params = serde_json::to_value(GraphChangedParams { removed_node_ids });
    notify(out, GRAPH_CHANGED, params);
}

/// Applies `paths` to `cache` and logs one line per affected file; the new graph if the
/// cache changed. A panic logs `Re-index failed` and yields no graph.
fn apply(out: &Out, cache: &mut FileCache, paths: &[PathBuf]) -> Option<Graph> {
    let registry = registry(cache.roots());
    // ponytail: a panic may leave the cache partly re-synced; the next change of those paths
    // re-syncs them. Apply to a clone if that ever shows.
    let outcome = match catch_unwind(AssertUnwindSafe(|| apply_changes(&registry, cache, paths))) {
        Ok(outcome) => outcome,
        Err(panic) => {
            let message = format!("Re-index failed: {}", panic_message(&*panic));
            log(out, LogLevel::Error, message);
            return None;
        }
    };
    for line in outcome.lines {
        let (level, message) = match line {
            ChangeLine::Reindexed(path) => (LogLevel::Info, format!("Re-indexed {path}")),
            ChangeLine::Removed(path) => (LogLevel::Info, format!("Removed {path}")),
            ChangeLine::Failed(path, reason) => {
                (LogLevel::Error, format!("Failed {path}: {reason}"))
            }
            ChangeLine::Skipped(path) => {
                (LogLevel::Warn, format!("Skipped {path}: file exceeds 1 MB"))
            }
        };
        log(out, level, message);
    }
    outcome.graph
}

/// The published graph plus what keeps it current. Lock order is always `cache` then
/// `pending`; the dispatch thread only ever takes `pending`, briefly, so it never waits on
/// a resolve. Every publish happens under `cache`.
#[derive(Default)]
pub struct Live {
    pub store: IndexStore,
    /// The last complete run's per-file symbols, kept current by single-file applies.
    cache: Mutex<Option<FileCache>>,
    pub pending: Mutex<Pending>,
}

/// Runs started and not yet ended, and the paths changed meanwhile.
#[derive(Default)]
pub struct Pending {
    pub runs: usize,
    pub queue: Vec<PathBuf>,
}

impl Live {
    /// Ends a run: the `cache` guard (held until the run has published) and the queue,
    /// taken with `runs` decremented.
    fn end_run(&self) -> (MutexGuard<'_, Option<FileCache>>, Vec<PathBuf>) {
        let cache = self.cache.lock().unwrap_or_else(PoisonError::into_inner);
        let mut pending = self.pending.lock().unwrap_or_else(PoisonError::into_inner);
        pending.runs -= 1;
        (cache, std::mem::take(&mut pending.queue))
    }
}

/// Re-syncs `paths` on a new thread against the last complete run's cache, then publishes
/// and announces the graph if it changed. Nothing without a complete run.
pub fn spawn_apply(live: Arc<Live>, paths: Vec<PathBuf>, out: Out) {
    // ponytail: one thread per notification (applies are order-independent and idempotent);
    // one worker fed by a channel if the thread churn shows.
    thread::spawn(move || {
        let mut cache = live.cache.lock().unwrap_or_else(PoisonError::into_inner);
        let Some(cache) = cache.as_mut() else {
            return;
        };
        if let Some(graph) = apply(&out, cache, &paths) {
            let removed = live.store.publish(graph, cache);
            graph_changed(&out, &removed);
        }
    });
}

impl RunEvents for Reporter {
    fn on_started(&self) {
        status(&self.out, ServerState::Indexing, None);
        let message = format!("Index run started: {} roots", self.roots);
        log(&self.out, LogLevel::Info, message);
        self.progress(IndexPhase::Scanning, 0, 0);
    }

    fn on_scanned(&self, skipped: usize, total: usize) {
        self.done.store(skipped, Ordering::Relaxed);
        self.total.store(total, Ordering::Relaxed);
        *self
            .last_progress
            .lock()
            .unwrap_or_else(PoisonError::into_inner) = Instant::now();
        self.progress(IndexPhase::Indexing, skipped, total);
    }

    fn on_file_done(&self, done: usize, total: usize) {
        self.done.fetch_max(done, Ordering::Relaxed);
        let mut last = self
            .last_progress
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        if done == total || last.elapsed() >= PROGRESS_EVERY {
            *last = Instant::now();
            self.progress(IndexPhase::Indexing, done, total);
        }
    }

    fn on_finished(&self, _: &RunResult) {}
}

/// Runs `roots` on a new thread once `previous` has finished, so runs never overlap and a
/// superseded run's `index/done` precedes this run's first notification. Exactly one
/// `index/done` per run; only a run that completes and wins the `cancel` swap publishes.
#[allow(clippy::too_many_arguments)]
pub fn spawn_run(
    registry: FrontendRegistry,
    roots: Vec<PathBuf>,
    exclude: Vec<String>,
    run_id: u64,
    cancel: Arc<AtomicBool>,
    previous: Option<JoinHandle<()>>,
    live: Arc<Live>,
    out: Out,
) -> JoinHandle<()> {
    thread::spawn(move || {
        if let Some(previous) = previous {
            let _ = previous.join();
        }
        let reporter = Reporter::new(run_id, roots.len(), out.clone());
        let run = || full_run(&registry, &roots, &exclude, &cancel, &reporter);
        match catch_unwind(AssertUnwindSafe(run)) {
            Ok(result) => reporter.finish(result, &cancel, &live),
            Err(panic) => {
                // Held to the end like a run's publish; the queue is dropped.
                let _ended = live.end_run();
                let message = format!("Index run failed: {}", panic_message(&*panic));
                log(&out, LogLevel::Error, message);
                status(
                    &out,
                    ServerState::Ready,
                    Some("Index run failed".to_owned()),
                );
                reporter.done(IndexOutcome::Cancelled, 0, 0, 0);
            }
        }
    })
}

pub(crate) fn panic_message(panic: &(dyn Any + Send)) -> &str {
    panic
        .downcast_ref::<&str>()
        .copied()
        .or_else(|| panic.downcast_ref::<String>().map(String::as_str))
        .unwrap_or("unknown panic")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn not_indexed_before_first_graph() {
        for method in [GRAPH_FILES, GRAPH_EXPAND, GRAPH_NODE, GRAPH_NEIGHBOURHOOD] {
            let err = handle(
                method,
                json!({"fileId": "a", "nodeId": "a", "hops": 1}),
                None,
            )
            .unwrap_err();
            assert_eq!(err, (NOT_INDEXED, "NotIndexed".to_owned()));
        }
    }

    #[test]
    fn unknown_node_and_bad_params() {
        let graph = Graph::new();
        let err = handle(GRAPH_EXPAND, json!({"fileId": "nope"}), Some(&graph)).unwrap_err();
        assert_eq!(err, (UNKNOWN_NODE, "UnknownNode".to_owned()));
        let err = handle(GRAPH_NODE, json!({"nodeId": "nope"}), Some(&graph)).unwrap_err();
        assert_eq!(err, (UNKNOWN_NODE, "UnknownNode".to_owned()));
        let err = handle(
            GRAPH_NEIGHBOURHOOD,
            json!({"nodeId": "nope", "hops": 1}),
            Some(&graph),
        )
        .unwrap_err();
        assert_eq!(err, (UNKNOWN_NODE, "UnknownNode".to_owned()));
        let err = handle(GRAPH_EXPAND, json!({}), Some(&graph)).unwrap_err();
        assert_eq!(err.0, INVALID_PARAMS);
        let err = handle(GRAPH_NEIGHBOURHOOD, json!({"nodeId": "a"}), Some(&graph)).unwrap_err();
        assert_eq!(err.0, INVALID_PARAMS);
        let files = handle(GRAPH_FILES, Value::Null, Some(&graph)).unwrap();
        assert_eq!(files, json!({"nodes": [], "edges": [], "total": 0}));
    }

    struct Shared(Arc<Mutex<Vec<u8>>>);

    impl Write for Shared {
        fn write(&mut self, data: &[u8]) -> io::Result<usize> {
            self.0.lock().unwrap().write(data)
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    fn result() -> RunResult {
        RunResult {
            graph: Graph::new(),
            indexed: 0,
            failed: Vec::new(),
            skipped: Vec::new(),
            cache: FileCache::default(),
        }
    }

    /// One run in flight with `queue` pending.
    fn live(queue: Vec<PathBuf>) -> Live {
        let live = Live::default();
        *live.pending.lock().unwrap() = Pending { runs: 1, queue };
        live
    }

    /// `finish`'s output as text.
    fn finish_on(live: &Live, result: RunResult, cancel: &AtomicBool) -> String {
        let buf = Arc::new(Mutex::new(Vec::new()));
        Reporter::new(7, 1, out(Shared(buf.clone()))).finish(Some(result), cancel, live);
        let bytes = buf.lock().unwrap().clone();
        String::from_utf8(bytes).unwrap()
    }

    /// `finish`'s output as text, and whether it published.
    fn finish(cancel: &AtomicBool) -> (String, bool) {
        let live = live(Vec::new());
        let text = finish_on(&live, result(), cancel);
        (text, live.store.snapshot().is_some())
    }

    struct NoEvents;

    impl RunEvents for NoEvents {
        fn on_started(&self) {}
        fn on_scanned(&self, _: usize, _: usize) {}
        fn on_file_done(&self, _: usize, _: usize) {}
        fn on_finished(&self, _: &RunResult) {}
    }

    /// A completed run over a temp workspace holding `a.ts` with `function foo`.
    fn ts_run(name: &str) -> (PathBuf, RunResult) {
        let dir = std::env::temp_dir().join(format!("server-graph-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("a.ts"), "export function foo(): void {}\n").unwrap();
        let roots = vec![dir.clone()];
        let cancel = AtomicBool::new(false);
        let result = full_run(&registry(&roots), &roots, &[], &cancel, &NoEvents).unwrap();
        (dir, result)
    }

    #[test]
    fn a_change_queued_during_a_run_is_published_with_it_once() {
        let (dir, result) = ts_run("queued");
        std::fs::write(dir.join("a.ts"), "export function bar(): void {}\n").unwrap();
        let live = live(vec![dir.join("a.ts")]);

        let text = finish_on(&live, result, &AtomicBool::new(false));

        assert_eq!(text.matches(GRAPH_CHANGED).count(), 1, "{text}");
        let reindexed = text.find("Re-indexed a.ts").expect("a Re-indexed line");
        assert!(reindexed < text.find(GRAPH_CHANGED).unwrap(), "{text}");
        let snapshot = live.store.snapshot().unwrap();
        assert_eq!(snapshot.roots, std::slice::from_ref(&dir));
        let names: Vec<&str> = snapshot
            .graph
            .children(&NodeId::file("a.ts"))
            .map(|n| n.name.as_str())
            .collect();
        assert_eq!(names, ["bar"]);
        let pending = live.pending.lock().unwrap();
        assert!(pending.queue.is_empty());
        assert_eq!(pending.runs, 0);
        let cache = live.cache.lock().unwrap();
        assert_eq!(cache.as_ref().unwrap().roots(), std::slice::from_ref(&dir));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_cancelled_run_drops_its_queue() {
        let (dir, result) = ts_run("dropped");
        let live = live(vec![dir.join("a.ts")]);
        *live.cache.lock().unwrap() = Some(FileCache::default());

        let text = finish_on(&live, result, &AtomicBool::new(true));

        assert!(!text.contains(GRAPH_CHANGED), "{text}");
        assert!(live.store.snapshot().is_none());
        let pending = live.pending.lock().unwrap();
        assert!(pending.queue.is_empty());
        assert_eq!(pending.runs, 0);
        let cache = live.cache.lock().unwrap();
        assert!(cache.as_ref().unwrap().roots().is_empty(), "cache replaced");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_cancel_that_swapped_first_wins_over_publish() {
        let cancel = AtomicBool::new(false);
        assert!(
            !cancel.swap(true, Ordering::SeqCst),
            "index/cancel answers true"
        );
        let (text, published) = finish(&cancel);
        assert!(!published);
        assert!(text.contains(r#""outcome":"cancelled""#), "{text}");
        assert!(!text.contains(GRAPH_CHANGED), "{text}");
        assert!(
            text.contains("Index run cancelled after 0 of 0 files"),
            "{text}"
        );
    }

    #[test]
    fn a_published_run_makes_a_later_cancel_answer_false() {
        let cancel = AtomicBool::new(false);
        let (text, published) = finish(&cancel);
        assert!(published);
        assert!(text.contains(r#""outcome":"complete""#), "{text}");
        assert!(text.contains(GRAPH_CHANGED), "{text}");
        assert!(
            cancel.swap(true, Ordering::SeqCst),
            "index/cancel answers false"
        );
    }

    #[test]
    fn closed_writer_drops_frames() {
        let buf = Arc::new(Mutex::new(Vec::new()));
        let out = out(Shared(buf.clone()));
        send(&out, b"1", true).unwrap();
        let len = buf.lock().unwrap().len();
        assert!(len > 0);
        status(&out, ServerState::Ready, None);
        assert_eq!(buf.lock().unwrap().len(), len);
    }
}
