//! Phase 1: one `.java` file → `FileSymbols`, with package-qualified def names.

use std::cmp::Reverse;
use std::collections::HashMap;
use std::sync::OnceLock;

use ir::{Def, DefKind, FileSymbols, FrontendError, LineRange, RawImport, RawRef, RefKind};
use tree_sitter::{Language, Node, Parser, Query, QueryCursor, StreamingIterator};

/// Nodes between a type declaration and its members.
const BODY_KINDS: &[&str] = &[
    "class_body",
    "interface_body",
    "enum_body",
    "enum_body_declarations",
    "annotation_type_body",
];

struct Queries {
    defs: Query,
    imports: Query,
    calls: Query,
    refs: Query,
}

/// Type declarations that are `Class` defs (the `@type` captures of `defs.scm`).
const TYPE_KINDS: &[&str] = &[
    "class_declaration",
    "interface_declaration",
    "enum_declaration",
    "record_declaration",
    "annotation_type_declaration",
];

pub(crate) fn language() -> Language {
    tree_sitter_java::LANGUAGE.into()
}

/// The node above `decl` once the bodies between it and its enclosing type are skipped.
fn enclosing(decl: Node) -> Option<Node> {
    let mut up = decl.parent();
    while let Some(p) = up.filter(|p| BODY_KINDS.contains(&p.kind())) {
        up = p.parent();
    }
    up
}

/// A type or method declaration's def name: package- and enclosing-type-qualified. `None`
/// when anything but bodies separates it from its enclosing type (or the file, for a type),
/// as for members of anonymous and local classes, which are not defs.
pub(crate) fn qualified_name(decl: Node, source: &str) -> Option<String> {
    let name = text(decl.child_by_field_name("name")?, source);
    let up = enclosing(decl)?;
    let prefix = if up.kind() == "program" && TYPE_KINDS.contains(&decl.kind()) {
        let mut c = up.walk();
        let package = up
            .named_children(&mut c)
            .find(|n| n.kind() == "package_declaration")
            .and_then(|p| {
                let mut c = p.walk();
                let id = p
                    .named_children(&mut c)
                    .find(|n| matches!(n.kind(), "identifier" | "scoped_identifier"));
                id
            });
        package.map(|p| text(p, source).to_owned())
    } else if TYPE_KINDS.contains(&up.kind()) {
        Some(qualified_name(up, source)?)
    } else {
        return None;
    };
    Some(match prefix {
        Some(prefix) => format!("{prefix}.{name}"),
        None => name.to_owned(),
    })
}

fn queries() -> &'static Queries {
    static QUERIES: OnceLock<Queries> = OnceLock::new();
    QUERIES.get_or_init(|| {
        let query = |source| Query::new(&language(), source).expect("bundled query is valid");
        Queries {
            defs: query(include_str!("queries/defs.scm")),
            imports: query(include_str!("queries/imports.scm")),
            calls: query(include_str!("queries/calls.scm")),
            refs: query(include_str!("queries/refs.scm")),
        }
    })
}

/// `(capture name, node)` for every capture, outer nodes before the nodes they contain.
fn captures<'t>(
    query: &'static Query,
    root: Node<'t>,
    source: &str,
) -> Vec<(&'static str, Node<'t>)> {
    let mut cursor = QueryCursor::new();
    let mut matches = cursor.matches(query, root, source.as_bytes());
    let mut found = Vec::new();
    while let Some(m) = matches.next() {
        for capture in m.captures {
            found.push((query.capture_names()[capture.index as usize], capture.node));
        }
    }
    found.sort_by_key(|(_, node)| (node.start_byte(), Reverse(node.end_byte())));
    found
}

fn text<'s>(node: Node, source: &'s str) -> &'s str {
    &source[node.byte_range()]
}

fn lines(node: Node) -> LineRange {
    LineRange {
        start: node.start_position().row as u32 + 1,
        end: node.end_position().row as u32 + 1,
    }
}

fn first_error_line(node: Node) -> Option<usize> {
    if node.is_error() || node.is_missing() {
        return Some(node.start_position().row + 1);
    }
    if !node.has_error() {
        return None;
    }
    let mut cursor = node.walk();
    let line = node.children(&mut cursor).find_map(first_error_line);
    line
}

/// The class named by a `new` expression's type, without generic arguments.
fn new_type(ty: Node) -> Node {
    match ty.kind() {
        "generic_type" => ty.named_child(0).unwrap_or(ty),
        _ => ty,
    }
}

/// Whether `node` is the class of a `new T()` — a call, not also a reference.
fn is_new_type(node: Node) -> bool {
    let outer = node
        .parent()
        .filter(|p| p.kind() == "generic_type")
        .unwrap_or(node);
    outer
        .parent()
        .filter(|p| p.kind() == "object_creation_expression")
        .and_then(|p| p.child_by_field_name("type"))
        .is_some_and(|ty| ty == outer && new_type(outer) == node)
}

pub fn extract(path: &str, source: &str) -> Result<FileSymbols, FrontendError> {
    let parse_error = |message: String| FrontendError::Parse {
        path: path.to_owned(),
        message,
    };
    let mut parser = Parser::new();
    parser
        .set_language(&language())
        .expect("tree-sitter-java grammar is compatible");
    let tree = parser
        .parse(source, None)
        .ok_or_else(|| parse_error("parser produced no tree".to_owned()))?;
    let root = tree.root_node();
    if root.has_error() {
        let line = first_error_line(root).unwrap_or(1);
        return Err(parse_error(format!("syntax error at line {line}")));
    }
    let queries = queries();

    let mut defs: Vec<Def> = Vec::new();
    let mut by_name: HashMap<String, usize> = HashMap::new();
    // Declaration node id → def index; overloads map to the first declaration's def.
    let mut def_of: HashMap<usize, usize> = HashMap::new();
    for (capture, node) in captures(&queries.defs, root, source) {
        if capture == "package" {
            continue;
        }
        // Members of anonymous and local classes are not nodes.
        let Some(qualified_name) = qualified_name(node, source) else {
            continue;
        };
        // Outer declarations come first, so an enclosing type already has its def.
        let parent = enclosing(node).and_then(|p| def_of.get(&p.id()).copied());
        let index = *by_name.entry(qualified_name.clone()).or_insert_with(|| {
            defs.push(Def {
                kind: if capture == "type" {
                    DefKind::Class
                } else {
                    DefKind::Function
                },
                qualified_name,
                parent,
                range: lines(node),
            });
            defs.len() - 1
        });
        def_of.insert(node.id(), index);
    }

    let from = |node: Node| {
        let mut up = node.parent();
        while let Some(p) = up {
            if let Some(&index) = def_of.get(&p.id()) {
                return Some(index);
            }
            up = p.parent();
        }
        None
    };

    let imports = captures(&queries.imports, root, source)
        .into_iter()
        .map(|(_, node)| {
            let mut cursor = node.walk();
            let specifier = node
                .children(&mut cursor)
                .filter(|child| !child.is_extra())
                .map(|child| match child.kind() {
                    "import" | ";" => "",
                    "static" => "static ",
                    _ => text(child, source),
                })
                .collect();
            RawImport {
                specifier,
                span: lines(node),
            }
        })
        .collect();

    let mut refs: Vec<(usize, RawRef)> = Vec::new();
    for (_, node) in captures(&queries.calls, root, source) {
        let target = if node.kind() == "object_creation_expression" {
            let Some(ty) = node.child_by_field_name("type") else {
                continue;
            };
            format!("new {}", text(new_type(ty), source))
        } else {
            let Some(name) = node.child_by_field_name("name") else {
                continue;
            };
            match node.child_by_field_name("object") {
                Some(object) => format!("{}.{}", text(object, source), text(name, source)),
                None => text(name, source).to_owned(),
            }
        };
        refs.push((
            node.start_byte(),
            raw_ref(RefKind::Calls, from(node), target, node),
        ));
    }
    for (_, node) in captures(&queries.refs, root, source) {
        let in_name_or_decl = node
            .parent()
            .is_some_and(|p| matches!(p.kind(), "scoped_type_identifier" | "type_parameter"));
        let target = text(node, source);
        if in_name_or_decl || is_new_type(node) || target == "var" {
            continue;
        }
        refs.push((
            node.start_byte(),
            raw_ref(RefKind::References, from(node), target.to_owned(), node),
        ));
    }
    refs.sort_by_key(|(start, _)| *start);

    Ok(FileSymbols {
        language: "java".to_owned(),
        path: path.to_owned(),
        defs,
        imports,
        refs: refs.into_iter().map(|(_, r)| r).collect(),
    })
}

fn raw_ref(kind: RefKind, from: Option<usize>, target: String, node: Node) -> RawRef {
    RawRef {
        kind,
        from,
        target,
        span: lines(node),
    }
}
