use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use frontend_go::GoFrontend;
use ir::{EdgeKind, FileSymbols, Frontend, FrontendError, Graph, NodeId, NodeKind, SymbolTable};

fn fixture_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../fixtures/go")
}

/// Workspace-relative paths of the fixture's `.go` files, sorted, without `broken/`.
fn go_files(root: &Path, dir: &Path, out: &mut Vec<String>) {
    for entry in fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        let rel = path
            .strip_prefix(root)
            .unwrap()
            .to_str()
            .unwrap()
            .replace('\\', "/");
        if path.is_dir() && rel != "broken" {
            go_files(root, &path, out);
        } else if rel.ends_with(".go") {
            out.push(rel);
        }
    }
}

fn extract_fixture(frontend: &GoFrontend) -> Vec<FileSymbols> {
    let root = fixture_root();
    let mut paths = Vec::new();
    go_files(&root, &root, &mut paths);
    paths.sort();
    paths
        .iter()
        .map(|path| {
            let source = fs::read_to_string(root.join(path)).unwrap();
            frontend.extract(path, &source).unwrap()
        })
        .collect()
}

#[test]
fn extract_and_resolve_snapshots() {
    let frontend = GoFrontend::new(fixture_root());
    let files = extract_fixture(&frontend);
    for file in &files {
        insta::assert_yaml_snapshot!(file.path.replace(['/', '.'], "_"), file);
    }

    let edges = frontend.resolve(&files, &SymbolTable::new(&files));
    let mut graph = Graph::new();
    let mut names: HashMap<NodeId, String> = HashMap::new();
    for file in &files {
        graph.insert_file_symbols(file);
        names.insert(file.file_id(), file.path.clone());
        for (index, def) in file.defs.iter().enumerate() {
            names.insert(
                file.def_id(index).unwrap(),
                format!("{}::{}", file.path, def.qualified_name),
            );
        }
    }
    let contains: Vec<_> = names
        .keys()
        .flat_map(|id| graph.outbound(id, Some(EdgeKind::Contains)).cloned())
        .collect();
    let mut lines: Vec<_> = contains
        .iter()
        .chain(&edges)
        .map(|edge| {
            let name = |id: &NodeId| names.get(id).cloned();
            let to = name(edge.to())
                .or_else(|| edge.raw_name().map(|raw| format!("?{raw}")))
                .unwrap();
            (
                edge.kind().as_str(),
                name(edge.from()).unwrap(),
                to,
                edge.is_resolved(),
            )
        })
        .collect();
    lines.sort();
    let rendered: Vec<_> = lines
        .iter()
        .map(|(kind, from, to, resolved)| {
            format!("kind: {kind}, from: {from}, to: {to}, resolved: {resolved}")
        })
        .collect();
    insta::assert_snapshot!("edges", rendered.join("\n"));
}

#[test]
fn one_edge_per_ref_and_at_least_one_per_import() {
    let frontend = GoFrontend::new(fixture_root());
    let files = extract_fixture(&frontend);
    let table = SymbolTable::new(&files);
    let edges = frontend.resolve(&files, &table);

    let refs: usize = files.iter().map(|file| file.refs.len()).sum();
    let ref_edges = edges
        .iter()
        .filter(|edge| matches!(edge.kind(), EdgeKind::Calls | EdgeKind::References))
        .count();
    assert_eq!(ref_edges, refs);

    for (index, file) in files.iter().enumerate() {
        for import in &file.imports {
            // Resolve with this one import alone, so its edges are exactly the Imports edges.
            let mut alone = files.clone();
            alone[index].imports = vec![import.clone()];
            alone[index].refs.clear();
            let imports = frontend
                .resolve(&alone, &table)
                .into_iter()
                .filter(|edge| edge.kind() == EdgeKind::Imports && edge.from() == &file.file_id())
                .count();
            assert!(imports >= 1, "{} import {}", file.path, import.specifier);
        }
    }
}

#[test]
fn broken_file_is_a_parse_error_and_a_bare_file_node() {
    let path = "broken/broken.go";
    let source = fs::read_to_string(fixture_root().join(path)).unwrap();
    let frontend = GoFrontend::new(fixture_root());
    match frontend.extract(path, &source) {
        Err(FrontendError::Parse { path: p, .. }) => assert_eq!(p, path),
        other => panic!("expected a parse error, got {other:?}"),
    }

    let mut graph = Graph::new();
    graph.insert_file_symbols(&FileSymbols {
        language: "go".into(),
        path: path.into(),
        defs: vec![],
        imports: vec![],
        refs: vec![],
    });
    let files = graph.files();
    assert_eq!(files.len(), 1);
    assert_eq!(files[0].kind, NodeKind::File);
    assert_eq!(graph.children(&NodeId::file(path)).count(), 0);
}

#[test]
fn extract_is_pure() {
    let frontend = GoFrontend::new(fixture_root());
    let source = fs::read_to_string(fixture_root().join("config.go")).unwrap();
    assert_eq!(
        frontend.extract("config.go", &source).unwrap(),
        frontend.extract("config.go", &source).unwrap()
    );
}
