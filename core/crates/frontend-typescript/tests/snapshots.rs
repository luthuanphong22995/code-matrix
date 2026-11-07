use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use frontend_typescript::TypeScriptFrontend;
use ir::{Edge, FileSymbols, Frontend, FrontendError, NodeId, SymbolTable};

const BROKEN: &str = "broken/syntax-error.ts";

fn fixture_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../fixtures/typescript")
}

/// Every fixture file as (`/`-separated path relative to the root, source), sorted.
fn fixture_files() -> Vec<(String, String)> {
    fn walk(root: &Path, dir: &Path, out: &mut Vec<(String, String)>) {
        for entry in fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                walk(root, &path, out);
            } else {
                let rel = path.strip_prefix(root).unwrap();
                let rel: Vec<_> = rel.iter().map(|p| p.to_str().unwrap()).collect();
                out.push((rel.join("/"), fs::read_to_string(&path).unwrap()));
            }
        }
    }
    let root = fixture_root();
    let mut files = Vec::new();
    walk(&root, &root, &mut files);
    files.sort();
    files
}

fn good_files() -> Vec<FileSymbols> {
    fixture_files()
        .into_iter()
        .filter(|(path, _)| path != BROKEN)
        .map(|(path, source)| TypeScriptFrontend.extract(&path, &source).unwrap())
        .collect()
}

#[test]
fn file_symbols() {
    for symbols in good_files() {
        insta::assert_yaml_snapshot!(symbols.path.replace('/', "__"), symbols);
    }
}

#[test]
fn resolved_edges() {
    let files = good_files();
    let edges = TypeScriptFrontend.resolve(&files, &SymbolTable::new(&files));

    let mut names: HashMap<NodeId, String> = HashMap::new();
    for file in &files {
        names.insert(file.file_id(), file.path.clone());
        for (i, def) in file.defs.iter().enumerate() {
            names.insert(file.def_id(i).unwrap(), def.qualified_name.clone());
        }
    }
    let name = |id: &NodeId| names[id].clone();
    let mut lines: Vec<String> = edges
        .iter()
        .map(|e: &Edge| {
            let (to, state) = match e.raw_name() {
                Some(raw) => (raw.to_owned(), "unresolved"),
                None => (name(e.to()), "resolved"),
            };
            format!("{} {} -> {to} ({state})", e.kind().as_str(), name(e.from()))
        })
        .collect();
    lines.sort();
    insta::assert_snapshot!(lines.join("\n"));
}

#[test]
fn one_edge_per_raw_item() {
    let files = good_files();
    let edges = TypeScriptFrontend.resolve(&files, &SymbolTable::new(&files));
    let raw: usize = files.iter().map(|f| f.imports.len() + f.refs.len()).sum();
    assert_eq!(edges.len(), raw);

    let mut edges = edges.iter();
    for file in &files {
        for import in &file.imports {
            let edge = edges.next().unwrap();
            assert_eq!(edge.kind(), ir::EdgeKind::Imports);
            assert_eq!(edge.from(), &file.file_id());
            if !edge.is_resolved() {
                assert_eq!(edge.raw_name(), Some(import.specifier.as_str()));
            }
        }
        for r in &file.refs {
            let edge = edges.next().unwrap();
            let kind = match r.kind {
                ir::RefKind::Calls => ir::EdgeKind::Calls,
                ir::RefKind::References => ir::EdgeKind::References,
            };
            assert_eq!(edge.kind(), kind);
            assert_eq!(edge.from(), &file.ref_source(r));
            if !edge.is_resolved() {
                let name = r.target.split('@').next().unwrap();
                assert_eq!(edge.raw_name(), Some(name));
            }
        }
    }
}

#[test]
fn parse_error_and_identity() {
    assert_eq!(TypeScriptFrontend.language(), "typescript");
    assert_eq!(TypeScriptFrontend.extensions(), ["ts", "tsx", "js", "jsx"]);

    let source = fs::read_to_string(fixture_root().join(BROKEN)).unwrap();
    let Err(FrontendError::Parse { path, message }) = TypeScriptFrontend.extract(BROKEN, &source)
    else {
        panic!("expected a parse error");
    };
    assert_eq!(path, BROKEN);
    assert!(message.contains("line"), "{message}");
}
