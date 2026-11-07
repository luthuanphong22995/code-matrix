//! Phase 1: one recursive tree walk carrying the enclosing-def stack.
//!
//! # `RawRef::target` encoding
//!
//! `RawImport` carries only the specifier and `resolve` never sees source, so the binding a
//! ref gets from this file's import map is encoded into its target:
//! - `name` — bare identifier, binds only to this file's top-level def `name`;
//! - `name@spec#exported` — head identifier bound by an import from `spec` (`exported` is
//!   `default` for a default import; for a namespace member `ns.m` both are `m`);
//! - `name@` — member call on a non-namespace receiver (`obj.m()`, `this.m()`): never bound.
//!
//! The placeholder for an unbound ref is always the part before the first `@`. Private to
//! this crate: only `resolve` reads it.

use std::collections::HashMap;

use ir::{Def, DefKind, FileSymbols, FrontendError, LineRange, RawImport, RawRef, RefKind};
use tree_sitter::{Language, Node, Parser};

use crate::LANGUAGE;

pub fn extract(path: &str, source: &str, language: Language) -> Result<FileSymbols, FrontendError> {
    let error = |message: String| FrontendError::Parse {
        path: path.to_owned(),
        message,
    };
    let mut parser = Parser::new();
    parser
        .set_language(&language)
        .map_err(|e| error(e.to_string()))?;
    let tree = parser
        .parse(source, None)
        .ok_or_else(|| error("parser returned no tree".to_owned()))?;
    let root = tree.root_node();
    if let Some(bad) = first_error(root) {
        let what = if bad.is_missing() {
            "missing"
        } else {
            "syntax error"
        };
        return Err(error(format!(
            "{what} at line {}",
            bad.start_position().row + 1
        )));
    }

    let mut walker = Walker {
        src: source,
        bindings: HashMap::new(),
        stack: Vec::new(),
        symbols: FileSymbols {
            language: LANGUAGE.to_owned(),
            path: path.to_owned(),
            defs: Vec::new(),
            imports: Vec::new(),
            refs: Vec::new(),
        },
    };
    // ES imports are top-level only; collect them first so refs above them still bind.
    let mut cursor = root.walk();
    for statement in root.named_children(&mut cursor) {
        if statement.kind() == "import_statement" {
            walker.bind_imports(statement);
        }
    }
    walker.walk(root);
    Ok(walker.symbols)
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

fn span(node: Node) -> LineRange {
    LineRange {
        start: node.start_position().row as u32 + 1,
        end: node.end_position().row as u32 + 1,
    }
}

/// The def `node` is, as `(kind, name)`; `top_level` is whether no def encloses it. The one
/// home of the def-recognition rules, shared by `extract` and `flow`.
pub(crate) fn def_of(node: Node, src: &str, top_level: bool) -> Option<(DefKind, String)> {
    let text = |n: Node| n.utf8_text(src.as_bytes()).unwrap_or_default().to_owned();
    let named = |kind| node.child_by_field_name("name").map(|n| (kind, text(n)));
    match node.kind() {
        "class_declaration"
        | "abstract_class_declaration"
        | "interface_declaration"
        | "enum_declaration" => named(DefKind::Class),
        "function_declaration" | "generator_function_declaration" => named(DefKind::Function),
        "method_definition" if node.parent().is_some_and(|p| p.kind() == "class_body") => {
            named(DefKind::Function)
        }
        "variable_declarator" if top_level => {
            let name = node.child_by_field_name("name")?;
            let value = node.child_by_field_name("value")?;
            (name.kind() == "identifier"
                && matches!(value.kind(), "arrow_function" | "function_expression"))
            .then(|| (DefKind::Function, text(name)))
        }
        // `export default function () {}` / `export default class {}`: the value is the def.
        "function_expression" | "class" => {
            let parent = node.parent().filter(|p| p.kind() == "export_statement")?;
            let mut cursor = parent.walk();
            let is_default = parent.children(&mut cursor).any(|c| c.kind() == "default");
            let kind = match node.kind() {
                "class" => DefKind::Class,
                _ => DefKind::Function,
            };
            (is_default && parent.child_by_field_name("value") == Some(node))
                .then(|| (kind, "default".to_owned()))
        }
        _ => None,
    }
}

/// What a local name is bound to by an import.
enum Binding {
    /// Named or default import: `(specifier, exported name)`.
    Item(String, String),
    /// `import * as ns from "spec"`.
    Namespace(String),
}

struct Walker<'s> {
    src: &'s str,
    bindings: HashMap<String, Binding>,
    /// Indices into `symbols.defs` of the enclosing defs, innermost last.
    stack: Vec<usize>,
    symbols: FileSymbols,
}

impl Walker<'_> {
    fn text(&self, node: Node) -> &str {
        node.utf8_text(self.src.as_bytes()).unwrap_or_default()
    }

    /// A string literal's contents, without its quotes.
    fn string(&self, node: Node) -> Option<String> {
        let text = self.text(node);
        (node.kind() == "string" && text.len() >= 2).then(|| text[1..text.len() - 1].to_owned())
    }

    fn bind_imports(&mut self, statement: Node) {
        let Some(spec) = statement
            .child_by_field_name("source")
            .and_then(|s| self.string(s))
        else {
            return;
        };
        let mut cursor = statement.walk();
        let Some(clause) = statement
            .named_children(&mut cursor)
            .find(|c| c.kind() == "import_clause")
        else {
            return;
        };
        let mut cursor = clause.walk();
        for part in clause.named_children(&mut cursor) {
            match part.kind() {
                "identifier" => {
                    let local = self.text(part).to_owned();
                    self.bindings
                        .insert(local, Binding::Item(spec.clone(), "default".to_owned()));
                }
                "namespace_import" => {
                    let mut c = part.walk();
                    let id = part
                        .named_children(&mut c)
                        .find(|n| n.kind() == "identifier");
                    if let Some(id) = id {
                        let local = self.text(id).to_owned();
                        self.bindings
                            .insert(local, Binding::Namespace(spec.clone()));
                    }
                }
                "named_imports" => {
                    let mut c = part.walk();
                    for specifier in part.named_children(&mut c) {
                        let Some(name) = specifier.child_by_field_name("name") else {
                            continue;
                        };
                        let exported = self.text(name).to_owned();
                        let local = specifier
                            .child_by_field_name("alias")
                            .map_or(exported.clone(), |a| self.text(a).to_owned());
                        self.bindings
                            .insert(local, Binding::Item(spec.clone(), exported));
                    }
                }
                _ => {}
            }
        }
    }

    /// Target for a bare identifier `name`.
    fn bare(&self, name: &str) -> String {
        match self.bindings.get(name) {
            None => name.to_owned(),
            Some(Binding::Item(spec, exported)) => format!("{name}@{spec}#{exported}"),
            // Calling the namespace object itself: nothing to bind it to.
            Some(Binding::Namespace(_)) => format!("{name}@"),
        }
    }

    /// Target for `receiver.member`.
    fn member(&self, receiver: Node, member: &str) -> String {
        match (receiver.kind(), self.bindings.get(self.text(receiver))) {
            ("identifier", Some(Binding::Namespace(spec))) => format!("{member}@{spec}#{member}"),
            _ => format!("{member}@"),
        }
    }

    fn push_ref(&mut self, kind: RefKind, target: String, node: Node) {
        self.symbols.refs.push(RawRef {
            kind,
            from: self.stack.last().copied(),
            target,
            span: span(node),
        });
    }

    fn push_import(&mut self, spec: String, node: Node) {
        self.symbols.imports.push(RawImport {
            specifier: spec,
            span: span(node),
        });
    }

    /// A ref for `callee` when it is an identifier or a member with an identifier property.
    fn callee_ref(&mut self, kind: RefKind, callee: Node) {
        match callee.kind() {
            "identifier" => {
                let target = self.bare(self.text(callee));
                self.push_ref(kind, target, callee);
            }
            "member_expression" => {
                let (Some(object), Some(property)) = (
                    callee.child_by_field_name("object"),
                    callee.child_by_field_name("property"),
                ) else {
                    return;
                };
                if property.kind() == "property_identifier" {
                    let target = self.member(object, self.text(property));
                    self.push_ref(kind, target, callee);
                }
            }
            _ => {}
        }
    }

    fn walk(&mut self, node: Node) {
        if let Some((kind, name)) = def_of(node, self.src, self.stack.is_empty()) {
            return self.def(kind, name, node);
        }
        match node.kind() {
            "import_statement" => {
                if let Some(spec) = node
                    .child_by_field_name("source")
                    .and_then(|s| self.string(s))
                {
                    self.push_import(spec, node);
                }
                return;
            }
            "export_statement" => {
                if let Some(spec) = node
                    .child_by_field_name("source")
                    .and_then(|s| self.string(s))
                {
                    self.push_import(spec, node);
                    return;
                }
                // A default-exported function or class: walk only the def, not its siblings.
                let top_level = self.stack.is_empty();
                if let Some(value) = node
                    .child_by_field_name("value")
                    .filter(|v| def_of(*v, self.src, top_level).is_some())
                {
                    return self.walk(value);
                }
            }
            "call_expression" => {
                if let Some(callee) = node.child_by_field_name("function") {
                    if callee.kind() == "identifier" && self.text(callee) == "require" {
                        let spec = node
                            .child_by_field_name("arguments")
                            .and_then(|a| a.named_child(0))
                            .and_then(|a| self.string(a));
                        if let Some(spec) = spec {
                            self.push_import(spec, node);
                        }
                        return;
                    }
                    self.callee_ref(RefKind::Calls, callee);
                }
            }
            "new_expression" => {
                if let Some(callee) = node
                    .child_by_field_name("constructor")
                    .filter(|c| c.kind() == "identifier")
                {
                    self.callee_ref(RefKind::Calls, callee);
                }
            }
            "extends_clause" => {
                if let Some(value) = node.child_by_field_name("value") {
                    self.callee_ref(RefKind::References, value);
                }
            }
            "type_identifier" => {
                let target = self.bare(self.text(node));
                return self.push_ref(RefKind::References, target, node);
            }
            "nested_type_identifier" => {
                if let (Some(module), Some(name)) = (
                    node.child_by_field_name("module"),
                    node.child_by_field_name("name"),
                ) {
                    let target = self.member(module, self.text(name));
                    self.push_ref(RefKind::References, target, node);
                }
                return;
            }
            // Declared names, not uses.
            "type_alias_declaration" | "type_parameter" => {
                let name = node.child_by_field_name("name");
                return self.walk_children(node, name);
            }
            _ => {}
        }
        self.walk_children(node, None);
    }

    fn walk_children(&mut self, node: Node, skip: Option<Node>) {
        let mut cursor = node.walk();
        let children: Vec<Node> = node.children(&mut cursor).collect();
        for child in children {
            if Some(child) != skip {
                self.walk(child);
            }
        }
    }

    /// Records a def for `node`, then walks `node` minus its `name` inside it.
    fn def(&mut self, kind: DefKind, name: String, node: Node) {
        let parent = self.stack.last().copied();
        let qualified_name = match parent {
            Some(p) => format!("{}.{name}", self.symbols.defs[p].qualified_name),
            None => name,
        };
        self.symbols.defs.push(Def {
            kind,
            qualified_name,
            parent,
            range: span(node),
        });
        self.stack.push(self.symbols.defs.len() - 1);
        let name = node.child_by_field_name("name");
        self.walk_children(node, name);
        self.stack.pop();
    }
}
