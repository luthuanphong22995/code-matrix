use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use frontend_python::PythonFrontend;
use ir::{FileSymbols, Frontend, FrontendError, NodeId, SymbolTable};

const BROKEN: &str = "broken.py";

fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../fixtures/python")
}

/// `(workspace-relative path, source)` of every `.py` file under the fixture, sorted.
fn fixture() -> Vec<(String, String)> {
    fn walk(dir: &Path, out: &mut Vec<PathBuf>) {
        for entry in fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                walk(&path, out);
            } else if path.extension().is_some_and(|e| e == "py") {
                out.push(path);
            }
        }
    }
    let root = root();
    let mut paths = Vec::new();
    walk(&root, &mut paths);
    let mut files: Vec<_> = paths
        .into_iter()
        .map(|p| {
            let rel = p
                .strip_prefix(&root)
                .unwrap()
                .to_string_lossy()
                .replace('\\', "/");
            (rel, fs::read_to_string(&p).unwrap())
        })
        .collect();
    files.sort();
    files
}

fn extracted() -> Vec<FileSymbols> {
    fixture()
        .into_iter()
        .filter(|(path, _)| path != BROKEN)
        .map(|(path, source)| PythonFrontend.extract(&path, &source).unwrap())
        .collect()
}

#[test]
fn extract_snapshots() {
    for symbols in extracted() {
        let name = format!("extract__{}", symbols.path.replace('/', "__"));
        insta::assert_debug_snapshot!(name, symbols);
    }
}

#[test]
fn resolve_snapshot() {
    let files = extracted();
    let table = SymbolTable::new(&files);
    let mut names: HashMap<NodeId, String> = HashMap::new();
    for file in &files {
        names.insert(file.file_id(), file.path.clone());
        for def in &file.defs {
            names.insert(
                def.id(&file.path),
                format!("{}::{}", file.path, def.qualified_name),
            );
        }
    }
    let name = |id: &NodeId, raw: Option<&str>| {
        raw.map(|r| format!("?{r}"))
            .or_else(|| names.get(id).cloned())
            .unwrap_or_else(|| format!("<unknown {id}>"))
    };
    let mut rows: Vec<String> = PythonFrontend
        .resolve(&files, &table)
        .iter()
        .map(|e| {
            format!(
                "{} | {} -> {} | {}",
                e.kind().as_str(),
                name(e.from(), None),
                name(e.to(), e.raw_name()),
                e.is_resolved()
            )
        })
        .collect();
    rows.sort();
    insta::assert_snapshot!("resolve_edges", rows.join("\n"));
}

#[test]
fn one_edge_per_raw_import_and_ref() {
    let files = extracted();
    let table = SymbolTable::new(&files);
    let edges = PythonFrontend.resolve(&files, &table);
    let total: usize = files.iter().map(|f| f.imports.len() + f.refs.len()).sum();
    assert_eq!(edges.len(), total);
    for file in &files {
        let mut ids = vec![file.file_id()];
        ids.extend((0..file.defs.len()).filter_map(|i| file.def_id(i)));
        let from_file = edges.iter().filter(|e| ids.contains(e.from())).count();
        assert_eq!(
            from_file,
            file.imports.len() + file.refs.len(),
            "{}",
            file.path
        );
    }
    for edge in edges.iter().filter(|e| !e.is_resolved()) {
        let raw = edge.raw_name().expect("unresolved edge has a raw name");
        assert_eq!(edge.to(), &NodeId::unresolved(raw));
    }
}

#[test]
fn parse_error_and_identity() {
    let source = fs::read_to_string(root().join(BROKEN)).unwrap();
    match PythonFrontend.extract(BROKEN, &source) {
        Err(FrontendError::Parse { path, message }) => {
            assert_eq!(path, BROKEN);
            assert!(message.contains("line 1"), "{message}");
        }
        other => panic!("expected a parse error, got {other:?}"),
    }
    assert_eq!(PythonFrontend.language(), "python");
    assert_eq!(PythonFrontend.extensions(), ["py"]);
}
