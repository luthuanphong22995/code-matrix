//! Phase 1: one `.go` file → `FileSymbols`, pure and without filesystem access.

use std::sync::LazyLock;

use ir::{Def, DefKind, FileSymbols, FrontendError, LineRange, RawImport, RawRef, RefKind};
use tree_sitter::{Node, Parser, Query, QueryCursor, StreamingIterator};

fn query(source: &str) -> Query {
    Query::new(&tree_sitter_go::LANGUAGE.into(), source).expect("valid Go query")
}

static DEFS: LazyLock<Query> = LazyLock::new(|| query(include_str!("queries/defs.scm")));
static IMPORTS: LazyLock<Query> = LazyLock::new(|| query(include_str!("queries/imports.scm")));
static CALLS: LazyLock<Query> = LazyLock::new(|| query(include_str!("queries/calls.scm")));
static REFS: LazyLock<Query> = LazyLock::new(|| query(include_str!("queries/refs.scm")));

/// Go's predeclared types and builtin functions: not workspace code, so never a raw ref.
const PREDECLARED: &[&str] = &[
    "any",
    "bool",
    "byte",
    "comparable",
    "complex64",
    "complex128",
    "error",
    "float32",
    "float64",
    "int",
    "int8",
    "int16",
    "int32",
    "int64",
    "rune",
    "string",
    "uint",
    "uint8",
    "uint16",
    "uint32",
    "uint64",
    "uintptr",
    "append",
    "cap",
    "clear",
    "close",
    "complex",
    "copy",
    "delete",
    "imag",
    "len",
    "make",
    "max",
    "min",
    "new",
    "panic",
    "print",
    "println",
    "real",
    "recover",
];

pub fn extract(path: &str, source: &str) -> Result<FileSymbols, FrontendError> {
    let mut parser = Parser::new();
    parser
        .set_language(&tree_sitter_go::LANGUAGE.into())
        .expect("tree-sitter-go is ABI compatible");
    // ponytail: any syntax error drops the whole file's symbols; extract the error-free
    // parts if partial files matter.
    let tree = parser
        .parse(source, None)
        .filter(|tree| !tree.root_node().has_error())
        .ok_or_else(|| FrontendError::Parse {
            path: path.to_owned(),
            message: "syntax error".to_owned(),
        })?;
    let root = tree.root_node();
    let text = |node: Node| &source[node.byte_range()];

    // Classes first, so a method's parent index is always earlier.
    let mut classes = Vec::new();
    let mut functions = Vec::new();
    for captures in query_matches(&DEFS, root, source) {
        let get = |name: &str| {
            captures
                .iter()
                .find(|(n, _)| *n == name)
                .map(|&(_, node)| node)
        };
        let Some(name) = get("name").map(text) else {
            continue;
        };
        if let Some(node) = get("class") {
            classes.push((name.to_owned(), node));
        } else if let Some(node) = get("method") {
            let receiver = get("receiver").map_or("", |r| receiver_type(text(r)));
            functions.push((
                Some(receiver.to_owned()),
                format!("{receiver}.{name}"),
                node,
            ));
        } else if let Some(node) = get("function") {
            functions.push((None, name.to_owned(), node));
        }
    }
    let mut defs: Vec<Def> = classes
        .iter()
        .map(|(name, node)| Def {
            kind: DefKind::Class,
            qualified_name: name.clone(),
            parent: None,
            range: lines(*node),
        })
        .collect();
    defs.extend(functions.iter().map(|(receiver, name, node)| {
        Def {
            kind: DefKind::Function,
            qualified_name: name.clone(),
            parent: receiver
                .as_ref()
                .and_then(|r| classes.iter().position(|(class, _)| class == r)),
            range: lines(*node),
        }
    }));
    let spans: Vec<_> = classes
        .iter()
        .map(|(_, node)| node.byte_range())
        .chain(functions.iter().map(|(_, _, node)| node.byte_range()))
        .collect();
    let enclosing = |node: Node| {
        spans
            .iter()
            .position(|span| span.contains(&node.start_byte()))
    };

    let imports = query_matches(&IMPORTS, root, source)
        .into_iter()
        .flatten()
        .map(|(_, node)| RawImport {
            specifier: text(node).trim_matches(['"', '`']).to_owned(),
            span: lines(node),
        })
        .collect();

    let mut refs = Vec::new();
    let mut push = |kind, node: Node, target: String| {
        if !PREDECLARED.contains(&target.as_str()) {
            refs.push(RawRef {
                kind,
                from: enclosing(node),
                target,
                span: lines(node),
            });
        }
    };
    for (_, node) in query_matches(&CALLS, root, source).into_iter().flatten() {
        let target = match (
            node.child_by_field_name("operand"),
            node.child_by_field_name("field"),
        ) {
            (Some(operand), Some(field)) => format!("{}.{}", text(operand), text(field)),
            _ => text(node).to_owned(),
        };
        push(RefKind::Calls, node, target);
    }
    for (_, node) in query_matches(&REFS, root, source).into_iter().flatten() {
        if is_type_use(node) {
            push(RefKind::References, node, text(node).to_owned());
        }
    }

    Ok(FileSymbols {
        language: "go".to_owned(),
        path: path.to_owned(),
        defs,
        imports,
        refs,
    })
}

/// Each match's `(capture name, node)` pairs, in document order.
fn query_matches<'t>(
    query: &'static Query,
    root: Node<'t>,
    source: &str,
) -> Vec<Vec<(&'static str, Node<'t>)>> {
    let mut cursor = QueryCursor::new();
    let mut it = cursor.matches(query, root, source.as_bytes());
    let mut found = Vec::new();
    while let Some(m) = it.next() {
        found.push(
            m.captures
                .iter()
                .map(|c| (query.capture_names()[c.index as usize], c.node))
                .collect(),
        );
    }
    found
}

/// `*List[T]` → `List`.
pub(crate) fn receiver_type(written: &str) -> &str {
    let name = written.trim_start_matches(|c: char| c == '*' || c.is_whitespace());
    name.split('[').next().unwrap_or(name).trim()
}

/// False for a declared type name, a method receiver's type, and the `type_identifier`
/// inside a `qualified_type` (the qualified type is captured whole).
fn is_type_use(node: Node) -> bool {
    let Some(parent) = node.parent() else {
        return true;
    };
    if parent.kind() == "qualified_type"
        || (matches!(parent.kind(), "type_spec" | "type_alias")
            && parent.child_by_field_name("name") == Some(node))
    {
        return false;
    }
    let mut ancestor = Some(parent);
    while let Some(current) = ancestor {
        let up = current.parent();
        if current.kind() == "parameter_list"
            && up.is_some_and(|up| {
                up.kind() == "method_declaration"
                    && up.child_by_field_name("receiver") == Some(current)
            })
        {
            return false;
        }
        ancestor = up;
    }
    true
}

fn lines(node: Node) -> LineRange {
    LineRange {
        start: node.start_position().row as u32 + 1,
        end: node.end_position().row as u32 + 1,
    }
}
