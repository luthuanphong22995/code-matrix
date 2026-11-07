//! Phase 2: bind imports and refs at package (= directory) level, module-aware via `go.mod`.

use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

use ir::{Edge, EdgeKind, FileSymbols, NodeId, RefKind, SymbolTable};

pub fn resolve(root: &Path, files: &[FileSymbols], table: &SymbolTable) -> Vec<Edge> {
    let mut packages: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
    for file in files {
        packages
            .entry(dir(&file.path))
            .or_default()
            .push(&file.path);
    }
    let lookup = |package: &str, name: &str| {
        packages
            .get(package)?
            .iter()
            .find_map(|path| table.lookup_in(path, name))
            .cloned()
    };

    let mut edges = Vec::new();
    for file in files {
        let own = dir(&file.path);
        // ponytail: reads go.mod once per file; cache per dir if workspaces get large.
        let module = module_of(root, own);
        // Import path → workspace package dir, when it lies inside the module.
        let local = |spec: &str| {
            let (module_dir, module) = module.as_ref()?;
            let rest = spec.strip_prefix(module.as_str())?;
            (rest.is_empty() || rest.starts_with('/'))
                .then(|| join(module_dir, rest.trim_start_matches('/')))
        };

        for import in &file.imports {
            match local(&import.specifier).and_then(|package| packages.get(package.as_str())) {
                Some(paths) => edges.extend(paths.iter().map(|path| {
                    Edge::resolved(EdgeKind::Imports, file.file_id(), NodeId::file(path))
                })),
                None => edges.push(Edge::unresolved(
                    EdgeKind::Imports,
                    file.file_id(),
                    &import.specifier,
                )),
            }
        }

        for r in &file.refs {
            let kind = match r.kind {
                RefKind::Calls => EdgeKind::Calls,
                RefKind::References => EdgeKind::References,
            };
            // ponytail: the qualifier is the import path's last segment, so an aliased
            // import stays unresolved; add an alias to `RawImport` if that matters.
            let (bound, placeholder) = match r.target.rsplit_once('.') {
                None => (lookup(own, &r.target), r.target.as_str()),
                Some((qualifier, name)) => match file
                    .imports
                    .iter()
                    .find(|import| last_segment(&import.specifier) == qualifier)
                {
                    Some(import) => (
                        local(&import.specifier).and_then(|package| lookup(&package, name)),
                        r.target.as_str(),
                    ),
                    // A method call `x.m()`: no type inference, so placeholder `m`.
                    None => (None, name),
                },
            };
            let from = file.ref_source(r);
            edges.push(match bound {
                Some(to) => Edge::resolved(kind, from, to),
                None => Edge::unresolved(kind, from, placeholder),
            });
        }
    }
    edges
}

/// The nearest `go.mod` walking up from `root/dir` to `root`: its dir (relative to `root`)
/// and module path.
fn module_of(root: &Path, mut dir_path: &str) -> Option<(String, String)> {
    loop {
        if let Ok(text) = fs::read_to_string(root.join(dir_path).join("go.mod")) {
            let module = text
                .lines()
                .find_map(|line| line.trim().strip_prefix("module "))?;
            return Some((
                dir_path.to_owned(),
                module.trim().trim_matches('"').to_owned(),
            ));
        }
        if dir_path.is_empty() {
            return None;
        }
        dir_path = dir(dir_path);
    }
}

/// Directory of a workspace-relative path; `""` for the root.
fn dir(path: &str) -> &str {
    path.rsplit_once('/').map_or("", |(dir, _)| dir)
}

fn join(dir: &str, rest: &str) -> String {
    match (dir.is_empty(), rest.is_empty()) {
        (true, _) => rest.to_owned(),
        (_, true) => dir.to_owned(),
        _ => format!("{dir}/{rest}"),
    }
}

fn last_segment(import_path: &str) -> &str {
    import_path.rsplit('/').next().unwrap_or(import_path)
}
