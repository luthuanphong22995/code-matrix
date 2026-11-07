//! Phase 1: one `.py` file → `FileSymbols`.

use std::collections::HashMap;
use std::sync::LazyLock;

use ir::{Def, DefKind, FileSymbols, FrontendError, LineRange, RawImport, RawRef, RefKind};
use tree_sitter::{Language, Node, Parser, Query, QueryCursor, StreamingIterator};

static LANGUAGE: LazyLock<Language> = LazyLock::new(|| tree_sitter_python::LANGUAGE.into());

fn query(source: &str) -> Query {
    Query::new(&LANGUAGE, source).expect("bundled query compiles")
}

static DEFS: LazyLock<Query> = LazyLock::new(|| query(include_str!("queries/defs.scm")));
static IMPORTS: LazyLock<Query> = LazyLock::new(|| query(include_str!("queries/imports.scm")));
static CALLS: LazyLock<Query> = LazyLock::new(|| query(include_str!("queries/calls.scm")));
static REFS: LazyLock<Query> = LazyLock::new(|| query(include_str!("queries/refs.scm")));

pub fn extract(path: &str, source: &str) -> Result<FileSymbols, FrontendError> {
    let parse_error = |message: String| FrontendError::Parse {
        path: path.to_owned(),
        message,
    };
    let mut parser = Parser::new();
    parser
        .set_language(&LANGUAGE)
        .map_err(|e| parse_error(e.to_string()))?;
    let tree = parser
        .parse(source, None)
        .ok_or_else(|| parse_error("parser returned no tree".to_owned()))?;
    let root = tree.root_node();
    if root.has_error() {
        let line = first_error(root).map_or(1, |n| n.start_position().row + 1);
        return Err(parse_error(format!("syntax error at line {line}")));
    }

    let mut defs: Vec<Def> = Vec::new();
    // tree-sitter node id → index in `defs`.
    let mut def_index = HashMap::new();
    for (capture, node) in captures(&DEFS, root, source) {
        let name = node
            .child_by_field_name("name")
            .map_or_else(String::new, |n| text(n, source));
        let parent = enclosing(node, &def_index);
        let qualified_name = match parent {
            Some(p) => format!("{}.{name}", defs[p].qualified_name),
            None => name,
        };
        let kind = if capture == "class" {
            DefKind::Class
        } else {
            DefKind::Function
        };
        def_index.insert(node.id(), defs.len());
        defs.push(Def {
            kind,
            qualified_name,
            parent,
            range: lines(node),
        });
    }

    let imports = captures(&IMPORTS, root, source)
        .into_iter()
        .flat_map(|(_, node)| {
            let span = lines(node);
            import_specifiers(node, source)
                .into_iter()
                .map(move |specifier| RawImport { specifier, span })
        })
        .collect();

    let mut refs = Vec::new();
    for (_, node) in captures(&CALLS, root, source) {
        refs.push(RawRef {
            kind: RefKind::Calls,
            from: enclosing(node, &def_index),
            target: text(node, source),
            span: lines(node),
        });
    }
    for (_, node) in captures(&REFS, root, source) {
        let from = enclosing(node, &def_index);
        let mut names = Vec::new();
        type_names(node, &mut names);
        refs.extend(names.into_iter().map(|n| RawRef {
            kind: RefKind::References,
            from,
            target: text(n, source),
            span: lines(n),
        }));
    }

    Ok(FileSymbols {
        language: "python".to_owned(),
        path: path.to_owned(),
        defs,
        imports,
        refs,
    })
}

/// All captures of `query` under `root`, in source order.
fn captures<'q, 't>(query: &'q Query, root: Node<'t>, source: &'t str) -> Vec<(&'q str, Node<'t>)> {
    let names = query.capture_names();
    let mut out = Vec::new();
    let mut cursor = QueryCursor::new();
    let mut matches = cursor.matches(query, root, source.as_bytes());
    while let Some(m) = matches.next() {
        out.extend(m.captures.iter().map(|c| (names[c.index as usize], c.node)));
    }
    out.sort_by_key(|(_, node)| node.start_byte());
    out
}

/// Index of the nearest def strictly enclosing `node`.
fn enclosing(node: Node, def_index: &HashMap<usize, usize>) -> Option<usize> {
    let mut current = node.parent();
    while let Some(n) = current {
        if let Some(&index) = def_index.get(&n.id()) {
            return Some(index);
        }
        current = n.parent();
    }
    None
}

/// One normalized specifier per imported name (see the proposal's import encoding).
fn import_specifiers(node: Node, source: &str) -> Vec<String> {
    let mut cursor = node.walk();
    let names = node.children_by_field_name("name", &mut cursor);
    if node.kind() == "import_statement" {
        return names
            .map(|n| format!("import {}", clause(n, source)))
            .collect();
    }
    let module = if node.kind() == "future_import_statement" {
        "__future__".to_owned()
    } else {
        node.child_by_field_name("module_name")
            .map_or_else(String::new, |n| text(n, source))
    };
    let mut specs: Vec<String> = names
        .map(|n| format!("from {module} import {}", clause(n, source)))
        .collect();
    let mut cursor = node.walk();
    if node
        .named_children(&mut cursor)
        .any(|n| n.kind() == "wildcard_import")
    {
        specs.push(format!("from {module} import *"));
    }
    specs
}

/// `a.b` or `a.b as x`.
fn clause(node: Node, source: &str) -> String {
    match (
        node.child_by_field_name("name"),
        node.child_by_field_name("alias"),
    ) {
        (Some(name), Some(alias)) if node.kind() == "aliased_import" => {
            format!("{} as {}", text(name, source), text(alias, source))
        }
        _ => text(node, source),
    }
}

/// Names referenced by a base-class list or annotation: identifiers and dotted names,
/// descending into generics (`List[User]` → `List`, `User`); keyword args are skipped.
fn type_names<'t>(node: Node<'t>, out: &mut Vec<Node<'t>>) {
    match node.kind() {
        "identifier" | "attribute" => out.push(node),
        "keyword_argument" => {}
        _ => {
            let mut cursor = node.walk();
            for child in node.named_children(&mut cursor) {
                type_names(child, out);
            }
        }
    }
}

fn first_error(node: Node) -> Option<Node> {
    if node.is_error() || node.is_missing() {
        return Some(node);
    }
    if !node.has_error() {
        return None;
    }
    let mut cursor = node.walk();
    let children: Vec<Node> = node.children(&mut cursor).collect();
    children.into_iter().find_map(first_error)
}

/// Source text with whitespace removed, so multi-line dotted names read `a.b.c`.
fn text(node: Node, source: &str) -> String {
    source[node.byte_range()].split_whitespace().collect()
}

fn lines(node: Node) -> LineRange {
    LineRange {
        start: node.start_position().row as u32 + 1,
        end: node.end_position().row as u32 + 1,
    }
}
