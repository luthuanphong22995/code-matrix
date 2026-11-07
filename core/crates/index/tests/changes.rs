mod fake_frontend;

use std::collections::{BTreeSet, HashSet};
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;

use fake_frontend::{FakeFrontend, NoEvents, TempDir};
use index::{apply_changes, full_run, ChangeLine, FileCache, FrontendRegistry, RunResult};
use ir::{
    Edge, EdgeKind, FileSymbols, Frontend, FrontendError, Graph, NodeId, NodeKind, SymbolTable,
};

fn registry() -> FrontendRegistry {
    FrontendRegistry::new(vec![Box::new(FakeFrontend)])
}

fn run(ws: &TempDir, exclude: &[&str]) -> RunResult {
    let exclude: Vec<String> = exclude.iter().map(|g| (*g).to_owned()).collect();
    full_run(
        &registry(),
        std::slice::from_ref(&ws.0),
        &exclude,
        &AtomicBool::new(false),
        &NoEvents,
    )
    .unwrap()
}

fn apply(cache: &mut FileCache, paths: &[PathBuf]) -> (Vec<ChangeLine>, Option<Graph>) {
    let outcome = apply_changes(&registry(), cache, paths);
    (outcome.lines, outcome.graph)
}

fn fn_id(path: &str, name: &str) -> NodeId {
    NodeId::new(NodeKind::Function, path, name)
}

type Edges = HashSet<(NodeId, NodeId, EdgeKind, bool)>;

/// Every file, def and placeholder id (as `store.rs` collects them) and every edge.
fn shape(graph: &Graph) -> (BTreeSet<NodeId>, Edges) {
    let mut ids = BTreeSet::new();
    let mut edges = HashSet::new();
    let mut stack: Vec<NodeId> = graph.files().into_iter().map(|n| n.id.clone()).collect();
    while let Some(id) = stack.pop() {
        for edge in graph.outbound(&id, None) {
            edges.insert((
                edge.from().clone(),
                edge.to().clone(),
                edge.kind(),
                edge.is_resolved(),
            ));
            if !edge.is_resolved() {
                ids.insert(edge.to().clone());
            }
        }
        stack.extend(graph.children(&id).map(|n| n.id.clone()));
        ids.insert(id);
    }
    (ids, edges)
}

/// `graph` and the cache's files equal a fresh full run over the same disk.
fn assert_matches_disk(ws: &TempDir, exclude: &[&str], cache: &FileCache, graph: &Graph) {
    let fresh = run(ws, exclude);
    assert_eq!(shape(graph), shape(&fresh.graph));
    assert_eq!(
        cache.files().keys().collect::<Vec<_>>(),
        fresh.cache.files().keys().collect::<Vec<_>>()
    );
}

fn workspace(name: &str) -> TempDir {
    let ws = TempDir::new(&format!("changes-{name}"));
    ws.write("a.fake", b"fn foo\n");
    ws.write("b.fake", b"fn b\ncall foo\n");
    ws
}

#[test]
fn a_rewritten_file_keeps_references_as_unresolved_edges() {
    let ws = workspace("rewrite");
    let mut cache = run(&ws, &[]).cache;
    ws.write("a.fake", b"fn bar\n");

    let (lines, graph) = apply(&mut cache, &[ws.0.join("a.fake")]);
    let graph = graph.unwrap();

    assert_eq!(lines, [ChangeLine::Reindexed("a.fake".into())]);
    assert!(graph.node(&fn_id("a.fake", "bar")).is_some());
    assert!(graph.node(&fn_id("a.fake", "foo")).is_none());
    let call = graph
        .outbound(&fn_id("b.fake", "b"), Some(EdgeKind::Calls))
        .next()
        .unwrap();
    assert!(!call.is_resolved());
    assert_eq!(call.raw_name(), Some("foo"));
    assert_matches_disk(&ws, &[], &cache, &graph);
}

#[test]
fn a_deleted_file_is_removed() {
    let ws = workspace("delete");
    let mut cache = run(&ws, &[]).cache;
    fs::remove_file(ws.0.join("a.fake")).unwrap();

    let (lines, graph) = apply(&mut cache, &[ws.0.join("a.fake")]);
    let graph = graph.unwrap();

    assert_eq!(lines, [ChangeLine::Removed("a.fake".into())]);
    assert!(graph.node(&NodeId::file("a.fake")).is_none());
    assert!(graph.node(&fn_id("a.fake", "foo")).is_none());
    assert_matches_disk(&ws, &[], &cache, &graph);
}

#[test]
fn a_rename_gives_the_same_graph_in_either_order() {
    let ws = workspace("rename");
    let result = run(&ws, &[]);
    let mut first = result.cache;
    let mut second = run(&ws, &[]).cache;
    fs::rename(ws.0.join("a.fake"), ws.0.join("c.fake")).unwrap();
    let (a, c) = (ws.0.join("a.fake"), ws.0.join("c.fake"));

    let (_, one) = apply(&mut first, &[a.clone(), c.clone()]);
    let (_, two) = apply(&mut second, &[c, a]);
    let (one, two) = (one.unwrap(), two.unwrap());

    assert_eq!(shape(&one), shape(&two));
    let files: Vec<&str> = one.files().iter().map(|n| n.name.as_str()).collect();
    assert_eq!(files, ["b.fake", "c.fake"]);
    assert_matches_disk(&ws, &[], &first, &one);
}

#[test]
fn a_file_grown_past_the_cap_is_skipped_and_dropped() {
    let ws = workspace("grow");
    let mut cache = run(&ws, &[]).cache;
    let mut big = b"fn foo\n".to_vec();
    big.resize(1_048_577, b'x');
    ws.write("a.fake", &big);

    let (lines, graph) = apply(&mut cache, &[ws.0.join("a.fake")]);
    let graph = graph.unwrap();

    assert_eq!(lines, [ChangeLine::Skipped("a.fake".into())]);
    assert!(graph.node(&NodeId::file("a.fake")).is_none());
    assert_matches_disk(&ws, &[], &cache, &graph);
}

#[test]
fn unselected_new_files_change_nothing_and_newly_ignored_ones_are_removed() {
    let ws = workspace("ignored");
    ws.write(".gitignore", b"ign.fake\n");
    let result = run(&ws, &["excl.fake"]);
    let mut cache = result.cache;
    for name in ["ign.fake", "excl.fake", ".hidden.fake", "notes.txt"] {
        ws.write(name, b"fn new\n");
    }

    let paths: Vec<PathBuf> = ["ign.fake", "excl.fake", ".hidden.fake", "notes.txt"]
        .iter()
        .map(|name| ws.0.join(name))
        .collect();
    let (lines, graph) = apply(&mut cache, &paths);
    assert!(lines.is_empty(), "{lines:?}");
    assert!(graph.is_none());
    assert_matches_disk(&ws, &["excl.fake"], &cache, &result.graph);

    ws.write(".gitignore", b"ign.fake\na.fake\n");
    let (lines, graph) = apply(&mut cache, &[ws.0.join("a.fake")]);
    assert_eq!(lines, [ChangeLine::Removed("a.fake".into())]);
    assert_matches_disk(&ws, &["excl.fake"], &cache, &graph.unwrap());
}

#[test]
fn a_file_that_fails_keeps_its_bare_node() {
    let ws = workspace("fail");
    let mut cache = run(&ws, &[]).cache;
    ws.write("a.fake", b"fn foo\nFAIL\n");

    let (lines, graph) = apply(&mut cache, &[ws.0.join("a.fake")]);
    let graph = graph.unwrap();

    assert!(
        matches!(&lines[..], [ChangeLine::Failed(path, _)] if path == "a.fake"),
        "{lines:?}"
    );
    assert!(graph.node(&NodeId::file("a.fake")).is_some());
    assert_eq!(graph.children(&NodeId::file("a.fake")).count(), 0);
    assert_matches_disk(&ws, &[], &cache, &graph);
}

#[test]
fn the_failed_set_follows_breaks_and_fixes() {
    let ws = workspace("failed-set");
    ws.write("c.fake", b"FAIL\n");
    let mut cache = run(&ws, &[]).cache;
    assert_eq!(cache.failed(), &BTreeSet::from(["c.fake".to_owned()]));

    ws.write("c.fake", b"fn c\n");
    ws.write("a.fake", b"FAIL\n");
    apply(&mut cache, &[ws.0.join("c.fake"), ws.0.join("a.fake")]);
    assert_eq!(cache.failed(), &BTreeSet::from(["a.fake".to_owned()]));

    fs::remove_file(ws.0.join("a.fake")).unwrap();
    apply(&mut cache, &[ws.0.join("a.fake")]);
    assert!(cache.failed().is_empty());
}

/// `FakeFrontend` that counts `extract` calls.
struct Counting(Arc<AtomicUsize>);

impl Frontend for Counting {
    fn language(&self) -> &'static str {
        FakeFrontend.language()
    }

    fn extensions(&self) -> &'static [&'static str] {
        FakeFrontend.extensions()
    }

    fn extract(&self, path: &str, source: &str) -> Result<FileSymbols, FrontendError> {
        self.0.fetch_add(1, Ordering::SeqCst);
        FakeFrontend.extract(path, source)
    }

    fn resolve(&self, files: &[FileSymbols], table: &SymbolTable) -> Vec<Edge> {
        FakeFrontend.resolve(files, table)
    }
}

#[test]
fn only_the_named_file_is_parsed() {
    let ws = workspace("count");
    ws.write("sub/c.fake", b"fn c\n");
    let count = Arc::new(AtomicUsize::new(0));
    let registry = FrontendRegistry::new(vec![Box::new(Counting(count.clone()))]);
    let mut cache = full_run(
        &registry,
        std::slice::from_ref(&ws.0),
        &[],
        &AtomicBool::new(false),
        &NoEvents,
    )
    .unwrap()
    .cache;
    assert_eq!(count.swap(0, Ordering::SeqCst), 3);
    ws.write("a.fake", b"fn bar\n");

    let outcome = apply_changes(&registry, &mut cache, &[ws.0.join("a.fake")]);

    assert_eq!(count.load(Ordering::SeqCst), 1);
    assert_matches_disk(&ws, &[], &cache, &outcome.graph.unwrap());
}

#[test]
fn a_deleted_directory_removes_every_entry_under_it() {
    let ws = workspace("dir");
    ws.write("sub/x.fake", b"fn x\n");
    ws.write("sub/deep/y.fake", b"fn y\n");
    ws.write("subway.fake", b"fn s\n");
    let mut cache = run(&ws, &[]).cache;
    fs::remove_dir_all(ws.0.join("sub")).unwrap();

    let (lines, graph) = apply(&mut cache, &[ws.0.join("sub")]);

    assert_eq!(
        lines,
        [
            ChangeLine::Removed("sub/deep/y.fake".into()),
            ChangeLine::Removed("sub/x.fake".into())
        ]
    );
    assert_matches_disk(&ws, &[], &cache, &graph.unwrap());
}

#[test]
fn a_path_outside_every_root_changes_nothing() {
    let ws = workspace("outside");
    let result = run(&ws, &[]);
    let mut cache = result.cache;

    let (lines, graph) = apply(&mut cache, &[PathBuf::from("/elsewhere/z.fake")]);

    assert!(lines.is_empty());
    assert!(graph.is_none());
    assert_matches_disk(&ws, &[], &cache, &result.graph);
}
