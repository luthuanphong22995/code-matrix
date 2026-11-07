//! Phase 2: bind every `.py` file's raw imports and refs across the workspace.

use std::collections::HashMap;

use ir::{DefKind, Edge, EdgeKind, FileSymbols, NodeId, RawRef, RefKind, SymbolTable};

/// What a name in a file's scope stands for.
enum Binding {
    /// A module, by its file path.
    Module(String),
    Def(NodeId),
}

pub fn resolve(files: &[FileSymbols], table: &SymbolTable) -> Vec<Edge> {
    let mut edges = Vec::new();
    for file in files {
        let file_id = file.file_id();
        let mut scope = HashMap::new();
        for import in &file.imports {
            let (module, target) = bind_import(&import.specifier, &file.path, table, &mut scope);
            edges.push(match target {
                Some(path) => {
                    Edge::resolved(EdgeKind::Imports, file_id.clone(), NodeId::file(&path))
                }
                None => Edge::unresolved(EdgeKind::Imports, file_id.clone(), module),
            });
        }
        for r in &file.refs {
            let kind = match r.kind {
                RefKind::Calls => EdgeKind::Calls,
                RefKind::References => EdgeKind::References,
            };
            let from = file.ref_source(r);
            edges.push(match bind_ref(file, r, &scope, table) {
                Some(to) => Edge::resolved(kind, from, to),
                // Bare name, or the last segment of an attribute target.
                None => Edge::unresolved(kind, from, r.target.rsplit('.').next().unwrap_or("")),
            });
        }
    }
    edges
}

/// Parses a specifier written by `extract`, adds its bindings to `scope` and returns the
/// module as written plus the file the import points at.
fn bind_import<'s>(
    spec: &'s str,
    importer: &str,
    table: &SymbolTable,
    scope: &mut HashMap<String, Binding>,
) -> (&'s str, Option<String>) {
    if let Some(rest) = spec.strip_prefix("import ") {
        let (module, alias) = split_as(rest);
        let file = module_file(table, importer, module);
        match (alias, &file) {
            (Some(alias), Some(path)) => {
                scope.insert(alias.to_owned(), Binding::Module(path.clone()));
            }
            (Some(_), None) => {}
            // `import a.b` binds `a`, through which `a.b` is reachable too.
            (None, _) => {
                let ends = module
                    .match_indices('.')
                    .map(|(i, _)| i)
                    .chain([module.len()]);
                for end in ends {
                    let prefix = &module[..end];
                    if let Some(path) = module_file(table, importer, prefix) {
                        scope.insert(prefix.to_owned(), Binding::Module(path));
                    }
                }
            }
        }
        return (module, file);
    }
    let Some((module, names)) = spec
        .strip_prefix("from ")
        .and_then(|r| r.split_once(" import "))
    else {
        return (spec, None);
    };
    let file = module_file(table, importer, module);
    if names == "*" {
        return (module, file);
    }
    let (name, alias) = split_as(names);
    let bound = alias.unwrap_or(name).to_owned();
    let submodule = if module.ends_with('.') {
        format!("{module}{name}")
    } else {
        format!("{module}.{name}")
    };
    if let Some(path) = module_file(table, importer, &submodule) {
        scope.insert(bound, Binding::Module(path.clone()));
        return (module, Some(path));
    }
    if let Some(id) = file.as_ref().and_then(|path| table.lookup_in(path, name)) {
        scope.insert(bound, Binding::Def(id.clone()));
    }
    (module, file)
}

fn split_as(clause: &str) -> (&str, Option<&str>) {
    match clause.split_once(" as ") {
        Some((name, alias)) => (name, Some(alias)),
        None => (clause, None),
    }
}

/// `a.b` → `a/b.py` else `a/b/__init__.py`, if among the extracted files. Relative modules
/// start at the importer's directory and go up one level per extra leading dot.
fn module_file(table: &SymbolTable, importer: &str, module: &str) -> Option<String> {
    let name = module.trim_start_matches('.');
    let dots = module.len() - name.len();
    let mut dir = "";
    if dots > 0 {
        dir = parent_dir(importer)?;
        for _ in 1..dots {
            dir = parent_dir(dir)?;
        }
    }
    let name = name.replace('.', "/");
    let path = match (dir, name.as_str()) {
        ("", name) => name.to_owned(),
        (dir, "") => dir.to_owned(),
        (dir, name) => format!("{dir}/{name}"),
    };
    let init = if path.is_empty() {
        "__init__.py".to_owned()
    } else {
        format!("{path}/__init__.py")
    };
    [(!path.is_empty()).then(|| format!("{path}.py")), Some(init)]
        .into_iter()
        .flatten()
        .find(|candidate| table.has_file(candidate))
}

/// `a/b/c.py` → `a/b`, `a` → ``, `` → none (above the workspace root).
fn parent_dir(path: &str) -> Option<&str> {
    if path.is_empty() {
        return None;
    }
    Some(path.rsplit_once('/').map_or("", |(dir, _)| dir))
}

fn bind_ref(
    file: &FileSymbols,
    r: &RawRef,
    scope: &HashMap<String, Binding>,
    table: &SymbolTable,
) -> Option<NodeId> {
    let target = r.target.as_str();
    if !target.contains('.') {
        // A dotless qualified name is a module-level def; those shadow imports.
        if let Some(id) = table.lookup_in(&file.path, target) {
            return Some(id.clone());
        }
        return scope.get(target).map(|binding| match binding {
            Binding::Module(path) => NodeId::file(path),
            Binding::Def(id) => id.clone(),
        });
    }
    if let Some(method) = target.strip_prefix("self.").filter(|m| !m.contains('.')) {
        let mut current = r.from;
        while let Some(index) = current {
            let def = file.defs.get(index)?;
            if def.kind == DefKind::Class {
                let name = format!("{}.{method}", def.qualified_name);
                return table.lookup_in(&file.path, &name).cloned();
            }
            current = def.parent;
        }
        return None;
    }
    // Longest prefix bound to a module, then the rest as a qualified name in its file.
    let mut end = target.len();
    while let Some(dot) = target[..end].rfind('.') {
        end = dot;
        if let Some(Binding::Module(path)) = scope.get(&target[..end]) {
            return table.lookup_in(path, &target[end + 1..]).cloned();
        }
    }
    None
}
