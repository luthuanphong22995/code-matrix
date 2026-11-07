mod fake_frontend;

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use fake_frontend::{FakeFrontend, NoEvents, TempDir};
use index::{
    disk_path, full_run, graph_path, FrontendRegistry, IndexStore, RunEvents, RunResult, Skipped,
};
use ir::{Edge, EdgeKind, FileSymbols, Frontend, FrontendError, NodeId, NodeKind, SymbolTable};

fn registry() -> FrontendRegistry {
    FrontendRegistry::new(vec![Box::new(FakeFrontend)])
}

fn run(roots: &[&Path]) -> RunResult {
    run_excluding(roots, &[])
}

fn run_excluding(roots: &[&Path], exclude: &[&str]) -> RunResult {
    let roots: Vec<PathBuf> = roots.iter().map(|r| r.to_path_buf()).collect();
    let exclude: Vec<String> = exclude.iter().map(|g| (*g).to_owned()).collect();
    full_run(
        &registry(),
        &roots,
        &exclude,
        &AtomicBool::new(false),
        &NoEvents,
    )
    .unwrap()
}

fn fn_id(path: &str, name: &str) -> NodeId {
    NodeId::new(NodeKind::Function, path, name)
}

#[test]
fn selects_extracts_and_accounts_for_every_file() {
    let ws = TempDir::new("select");
    ws.write("a.fake", b"fn alpha\ncall beta\ncall big\n");
    ws.write("b.fake", b"fn beta\n");
    ws.write("sub/c.fake", b"fn gamma\n");
    ws.write("notes.txt", b"fn text\n");
    ws.write(".gitignore", b"ignored.fake\n");
    ws.write("ignored.fake", b"fn ignored\n");
    ws.write("bad.fake", b"fn bad\nFAIL\n");
    let mut big = b"fn big\n".to_vec();
    big.resize(1_048_577, b'x');
    ws.write("big.fake", &big);

    let result = run(&[&ws.0]);
    let graph = &result.graph;

    // `bad.fake` keeps its bare file node but is not counted as indexed.
    assert_eq!(result.indexed, 3);
    assert_eq!(graph.files().len(), 4);
    let failed: Vec<&str> = result.failed.iter().map(|(p, _)| p.as_str()).collect();
    assert_eq!(failed, ["bad.fake"]);
    assert_eq!(result.skipped, [("big.fake".to_owned(), Skipped::TooLarge)]);

    let bad = graph.node(&NodeId::file("bad.fake")).unwrap();
    assert_eq!(bad.kind, NodeKind::File);
    assert_eq!(graph.children(&NodeId::file("bad.fake")).count(), 0);
    assert!(graph.node(&NodeId::file("sub/c.fake")).is_some());
    for absent in ["big.fake", "ignored.fake", "notes.txt"] {
        assert!(graph.node(&NodeId::file(absent)).is_none(), "{absent}");
    }

    let calls: Vec<_> = graph
        .outbound(&fn_id("a.fake", "alpha"), Some(EdgeKind::Calls))
        .collect();
    assert_eq!(calls.len(), 2);
    let beta = calls.iter().find(|e| e.is_resolved()).unwrap();
    assert_eq!(beta.to(), &fn_id("b.fake", "beta"));
    let big = calls.iter().find(|e| !e.is_resolved()).unwrap();
    assert_eq!(big.raw_name(), Some("big"));

    // The cache holds exactly the graph's files, the failed one included.
    let cached: Vec<&str> = result.cache.files().keys().map(String::as_str).collect();
    assert_eq!(cached, ["a.fake", "b.fake", "bad.fake", "sub/c.fake"]);
    assert!(result.cache.files()["bad.fake"].defs.is_empty());
    assert_eq!(result.cache.roots(), std::slice::from_ref(&ws.0));
}

#[test]
fn ignore_files_above_the_git_root_do_not_apply() {
    let ws = TempDir::new("nested-git");
    ws.write(".gitignore", b"*\n");
    ws.write("repo/.git/HEAD", b"ref: refs/heads/main\n");
    ws.write("repo/.gitignore", b"ignored.fake\n");
    ws.write("repo/a.fake", b"fn alpha\n");
    ws.write("repo/ignored.fake", b"fn ignored\n");
    let result = run(&[&ws.0.join("repo")]);
    let paths: Vec<&str> = result
        .graph
        .files()
        .iter()
        .map(|n| n.name.as_str())
        .collect();
    assert_eq!(paths, ["a.fake"]);
}

#[test]
fn multiple_roots_build_one_graph_with_unique_paths() {
    let ws = TempDir::new("roots");
    ws.write("one/app/x.fake", b"fn x\ncall z\n");
    ws.write("two/app/y.fake", b"fn y\n");
    ws.write("lib/z.fake", b"fn z\n");

    let result = run(&[
        &ws.0.join("one/app"),
        &ws.0.join("two/app"),
        &ws.0.join("lib"),
    ]);

    let paths: Vec<&str> = result
        .graph
        .files()
        .iter()
        .map(|n| n.name.as_str())
        .collect();
    assert_eq!(paths, ["app/x.fake", "app~2/y.fake", "lib/z.fake"]);
    let call = result
        .graph
        .outbound(&fn_id("app/x.fake", "x"), Some(EdgeKind::Calls))
        .next()
        .unwrap();
    assert_eq!(call.to(), &fn_id("lib/z.fake", "z"));
}

#[test]
fn exclude_globs_keep_files_out_of_every_list() {
    let ws = TempDir::new("exclude");
    ws.write("a.fake", b"fn alpha\n");
    ws.write("skip.fake", b"FAIL\n");
    ws.write("src/gen/g.fake", b"fn gen\n");
    let mut big = b"fn big\n".to_vec();
    big.resize(1_048_577, b'x');
    ws.write("src/gen/big.fake", &big);

    let result = run_excluding(&[&ws.0], &["**/gen/**", "skip.fake", "[bad"]);

    let paths: Vec<&str> = result
        .graph
        .files()
        .iter()
        .map(|n| n.name.as_str())
        .collect();
    assert_eq!(paths, ["a.fake"]);
    assert!(result.failed.is_empty());
    assert!(result.skipped.is_empty());
    assert_eq!(result.indexed, 1);
}

/// Records events in order; files-done values separately (workers race on order).
#[derive(Default)]
struct Recorder {
    events: Mutex<Vec<String>>,
    done: Mutex<Vec<usize>>,
}

impl RunEvents for Recorder {
    fn on_started(&self) {
        self.events.lock().unwrap().push("started".to_owned());
    }

    fn on_scanned(&self, skipped: usize, total: usize) {
        self.events
            .lock()
            .unwrap()
            .push(format!("scanned {skipped} {total}"));
    }

    fn on_file_done(&self, done: usize, total: usize) {
        assert!(done <= total);
        self.done.lock().unwrap().push(done);
    }

    fn on_finished(&self, result: &RunResult) {
        self.events.lock().unwrap().push(format!(
            "finished {} {} {}",
            result.indexed,
            result.failed.len(),
            result.skipped.len()
        ));
    }
}

#[test]
fn events_bracket_the_run_and_count_progress() {
    let ws = TempDir::new("events");
    ws.write("a.fake", b"fn a\n");
    ws.write("b.fake", b"fn b\n");
    ws.write("c.fake", b"fn c\n");
    ws.write("bad.fake", b"FAIL\n");
    let mut big = b"fn big\n".to_vec();
    big.resize(1_048_577, b'x');
    ws.write("big.fake", &big);

    let recorder = Recorder::default();
    let result = full_run(
        &registry(),
        std::slice::from_ref(&ws.0),
        &[],
        &AtomicBool::new(false),
        &recorder,
    )
    .unwrap();

    assert_eq!(
        *recorder.events.lock().unwrap(),
        ["started", "scanned 1 5", "finished 3 1 1"]
    );
    let mut done = recorder.done.lock().unwrap().clone();
    done.sort_unstable();
    assert_eq!(done, [2, 3, 4, 5]);
    assert_eq!((result.indexed, result.failed.len()), (3, 1));
}

#[test]
fn a_run_cancelled_before_it_starts_returns_no_graph() {
    let ws = TempDir::new("cancel-before");
    ws.write("a.fake", b"fn a\n");

    let recorder = Recorder::default();
    let result = full_run(
        &registry(),
        std::slice::from_ref(&ws.0),
        &[],
        &AtomicBool::new(true),
        &recorder,
    );

    assert!(result.is_none());
    assert_eq!(*recorder.events.lock().unwrap(), ["started"]);
}

/// `FakeFrontend` that sets `cancel` when it extracts a file containing `STOP`.
struct Cancelling(Arc<AtomicBool>);

impl Frontend for Cancelling {
    fn language(&self) -> &'static str {
        FakeFrontend.language()
    }

    fn extensions(&self) -> &'static [&'static str] {
        FakeFrontend.extensions()
    }

    fn extract(&self, path: &str, source: &str) -> Result<FileSymbols, FrontendError> {
        if source.contains("STOP") {
            self.0.store(true, Ordering::SeqCst);
        }
        FakeFrontend.extract(path, source)
    }

    fn resolve(&self, files: &[FileSymbols], table: &SymbolTable) -> Vec<Edge> {
        FakeFrontend.resolve(files, table)
    }
}

#[test]
fn a_run_cancelled_mid_extraction_returns_no_graph() {
    let ws = TempDir::new("cancel-mid");
    ws.write("a.fake", b"fn a\n");
    ws.write("stop.fake", b"STOP\n");
    ws.write("z.fake", b"fn z\n");

    let cancel = Arc::new(AtomicBool::new(false));
    let registry = FrontendRegistry::new(vec![Box::new(Cancelling(cancel.clone()))]);
    let recorder = Recorder::default();
    let result = full_run(
        &registry,
        std::slice::from_ref(&ws.0),
        &[],
        &cancel,
        &recorder,
    );

    assert!(result.is_none());
    assert_eq!(*recorder.events.lock().unwrap(), ["started", "scanned 0 3"]);
}

#[test]
fn publish_reports_removed_node_ids() {
    let ws = TempDir::new("store");
    ws.write("a.fake", b"fn alpha\ncall shared\n");
    ws.write("b.fake", b"fn beta\ncall shared\ncall nowhere\n");

    let store = IndexStore::new();
    assert!(store.snapshot().is_none());
    let first = run(&[&ws.0]);
    assert!(store.publish(first.graph, &first.cache).is_empty());
    assert!(store.snapshot().is_some());

    fs::remove_file(ws.0.join("b.fake")).unwrap();
    ws.write("c.fake", b"FAIL\n");
    let second = run(&[&ws.0]);
    let removed = store.publish(second.graph, &second.cache);

    let mut expected = vec![
        NodeId::file("b.fake"),
        fn_id("b.fake", "beta"),
        NodeId::unresolved("nowhere"),
    ];
    expected.sort();
    assert_eq!(removed, expected);
    let current = store.snapshot().unwrap();
    assert!(current.graph.node(&NodeId::unresolved("shared")).is_some());
    assert_eq!(current.failed, ["c.fake".to_owned()].into());
    assert_eq!(current.roots, std::slice::from_ref(&ws.0));
}

#[test]
fn graph_and_disk_paths_round_trip_for_one_root() {
    let roots = [PathBuf::from("/ws/app")];
    let abs = Path::new("/ws/app/src/a.fake");
    assert_eq!(graph_path(&roots, abs).as_deref(), Some("src/a.fake"));
    assert_eq!(disk_path(&roots, "src/a.fake").unwrap(), abs);
    assert_eq!(graph_path(&roots, Path::new("/elsewhere/a.fake")), None);
}

#[test]
fn graph_and_disk_paths_round_trip_for_same_basename_roots() {
    let roots = [PathBuf::from("/one/app"), PathBuf::from("/two/app")];
    let first = Path::new("/one/app/x.fake");
    let second = Path::new("/two/app/y.fake");
    assert_eq!(graph_path(&roots, first).as_deref(), Some("app/x.fake"));
    assert_eq!(graph_path(&roots, second).as_deref(), Some("app~2/y.fake"));
    assert_eq!(disk_path(&roots, "app/x.fake").unwrap(), first);
    assert_eq!(disk_path(&roots, "app~2/y.fake").unwrap(), second);
    assert_eq!(disk_path(&roots, "lib/z.fake"), None);
}
