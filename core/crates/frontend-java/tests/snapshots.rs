use std::fs;
use std::path::{Path, PathBuf};

use frontend_java::JavaFrontend;
use ir::{Edge, EdgeKind, FileSymbols, Frontend, FrontendError, Graph, NodeId, SymbolTable};

fn fixture_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../fixtures/java")
}

/// Workspace-relative paths of every `.java` file under `dir`, sorted.
fn java_files(root: &Path, dir: &Path, out: &mut Vec<String>) {
    for entry in fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            java_files(root, &path, out);
        } else if path.extension().is_some_and(|ext| ext == "java") {
            let relative = path.strip_prefix(root).unwrap().to_str().unwrap();
            out.push(relative.replace('\\', "/"));
        }
    }
}

/// Every fixture file except `broken/`, extracted.
fn extract_fixture() -> Vec<FileSymbols> {
    let root = fixture_root();
    let mut paths = Vec::new();
    java_files(&root, &root, &mut paths);
    paths.retain(|path| !path.starts_with("broken/"));
    paths.sort();
    paths
        .iter()
        .map(|path| {
            let source = fs::read_to_string(root.join(path)).unwrap();
            JavaFrontend.extract(path, &source).unwrap()
        })
        .collect()
}

fn resolve_fixture() -> (Vec<FileSymbols>, Vec<Edge>) {
    let files = extract_fixture();
    let edges = JavaFrontend.resolve(&files, &SymbolTable::new(&files));
    (files, edges)
}

#[test]
fn file_symbols_snapshots() {
    for file in extract_fixture() {
        insta::assert_yaml_snapshot!(file.path.replace('/', "__"), file);
    }
}

#[test]
fn resolved_edges_snapshot() {
    let (files, edges) = resolve_fixture();
    let mut graph = Graph::new();
    for file in &files {
        graph.insert_file_symbols(file);
    }
    graph.insert_edges(edges.clone());
    let name = |id: &NodeId| {
        graph
            .node(id)
            .map_or("?", |node| node.name.as_str())
            .to_owned()
    };
    let mut lines: Vec<String> = edges
        .iter()
        .map(|edge| {
            let unresolved = if edge.is_resolved() {
                ""
            } else {
                " [unresolved]"
            };
            format!(
                "{} {} -> {}{unresolved}",
                edge.kind().as_str(),
                name(edge.from()),
                name(edge.to()),
            )
        })
        .collect();
    lines.sort();
    insta::assert_snapshot!("edges", lines.join("\n"));
}

#[test]
fn one_edge_per_raw_import_and_ref() {
    let (files, edges) = resolve_fixture();
    let raw: usize = files.iter().map(|f| f.imports.len() + f.refs.len()).sum();
    assert_eq!(edges.len(), raw);
    for edge in edges.iter().filter(|edge| !edge.is_resolved()) {
        assert_eq!(edge.to(), &NodeId::unresolved(edge.raw_name().unwrap()));
    }
}

#[test]
fn misplaced_type_binds_by_declared_package() {
    let (files, edges) = resolve_fixture();
    let mover = files
        .iter()
        .find(|f| f.path == "src/misplaced/Mover.java")
        .unwrap();
    let app = files.iter().find(|f| f.path.ends_with("App.java")).unwrap();
    let move_def = mover
        .defs
        .iter()
        .position(|d| d.qualified_name == "com.example.util.Mover.move")
        .unwrap();
    let has = |kind, from: &NodeId, to: NodeId| {
        edges
            .iter()
            .any(|e| e.kind() == kind && e.from() == from && e.to() == &to && e.is_resolved())
    };
    assert!(has(EdgeKind::Imports, &app.file_id(), mover.file_id()));
    let main = app
        .defs
        .iter()
        .position(|d| d.qualified_name == "com.example.App.main")
        .unwrap();
    assert!(has(
        EdgeKind::Calls,
        &app.def_id(main).unwrap(),
        mover.def_id(move_def).unwrap()
    ));
}

#[test]
fn syntax_error_is_a_parse_error_naming_the_path() {
    let source = fs::read_to_string(fixture_root().join("broken/Broken.java")).unwrap();
    match JavaFrontend.extract("broken/Broken.java", &source) {
        Err(FrontendError::Parse { path, message }) => {
            assert_eq!(path, "broken/Broken.java");
            assert!(message.contains("line"), "{message}");
        }
        Ok(_) => panic!("broken source extracted"),
    }
}

#[test]
fn language_and_extensions() {
    assert_eq!(JavaFrontend.language(), "java");
    assert_eq!(JavaFrontend.extensions(), &["java"]);
}
