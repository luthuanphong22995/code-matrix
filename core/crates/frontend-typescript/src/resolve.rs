//! Phase 2: module-path probing against the table (never the disk) and name binding.

use ir::{Edge, EdgeKind, FileSymbols, NodeId, RefKind, SymbolTable};

/// Per file in input order: one `Imports` edge per raw import, then one edge per raw ref.
pub fn resolve(files: &[FileSymbols], table: &SymbolTable) -> Vec<Edge> {
    let mut edges = Vec::new();
    for file in files {
        let file_id = file.file_id();
        for import in &file.imports {
            edges.push(match probe(&file.path, &import.specifier, table) {
                Some(target) => {
                    Edge::resolved(EdgeKind::Imports, file_id.clone(), NodeId::file(&target))
                }
                None => Edge::unresolved(EdgeKind::Imports, file_id.clone(), &import.specifier),
            });
        }
        for r in &file.refs {
            let kind = match r.kind {
                RefKind::Calls => EdgeKind::Calls,
                RefKind::References => EdgeKind::References,
            };
            let from = file.ref_source(r);
            // Target encoding: see `extract`'s module docs.
            let (name, binding) = r.target.split_once('@').unwrap_or((&r.target, ""));
            let bound = if r.target.contains('@') {
                binding.rsplit_once('#').and_then(|(spec, exported)| {
                    let target = probe(&file.path, spec, table)?;
                    table.lookup_in(&target, exported).or_else(|| {
                        // ponytail: name heuristic; record the default export in FileSymbols if it misses in practice
                        (exported == "default")
                            .then(|| table.lookup_in(&target, name))
                            .flatten()
                    })
                })
            } else {
                table.lookup_in(&file.path, name)
            };
            edges.push(match bound {
                Some(to) => Edge::resolved(kind, from, to.clone()),
                None => Edge::unresolved(kind, from, name),
            });
        }
    }
    edges
}

/// The file a relative specifier names, if it is one of this language's files.
fn probe(importer: &str, specifier: &str, table: &SymbolTable) -> Option<String> {
    if !specifier.starts_with("./") && !specifier.starts_with("../") {
        return None;
    }
    let dir = importer.rsplit_once('/').map_or("", |(dir, _)| dir);
    let mut parts: Vec<&str> = Vec::new();
    for part in dir.split('/').chain(specifier.split('/')) {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop()?; // above the workspace root
            }
            _ => parts.push(part),
        }
    }
    let base = parts.join("/");
    let mut candidates = vec![base.clone()];
    if let Some(stem) = base.strip_suffix(".js") {
        candidates.push(format!("{stem}.ts"));
    }
    for suffix in [
        ".ts",
        ".tsx",
        ".js",
        ".jsx",
        "/index.ts",
        "/index.tsx",
        "/index.js",
    ] {
        candidates.push(format!("{base}{suffix}"));
    }
    candidates.into_iter().find(|c| table.has_file(c))
}
