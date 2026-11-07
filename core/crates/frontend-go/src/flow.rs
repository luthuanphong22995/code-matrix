//! Data flow: lower one Go function or method into `ir::flow`'s blocks, bindings and
//! def/use events, around a source position or by qualified name and variable key.

use std::collections::HashMap;

use ir::flow::variable_key;
use ir::{
    Binding, BlockKind, FlowBlock, FlowError, FlowEvent, FlowFunction, LineRange, Locate, Lowered,
    Picked, Pos, Role,
};
use tree_sitter::{Node, Parser};

use crate::extract::receiver_type;

/// Branch target placeholder for `Exit`, which is only appended (last) at the end.
const EXIT: usize = usize::MAX;

pub(crate) fn lower(source: &str, at: Locate) -> Result<Lowered, FlowError> {
    let mut parser = Parser::new();
    parser
        .set_language(&tree_sitter_go::LANGUAGE.into())
        .expect("tree-sitter-go is ABI compatible");
    let tree = parser.parse(source, None).expect("parser has a language");
    let root = tree.root_node();
    let decls = || {
        let mut c = root.walk();
        root.named_children(&mut c)
            .filter(|n| matches!(n.kind(), "function_declaration" | "method_declaration"))
            .collect::<Vec<_>>()
    };
    match at {
        Locate::At(pos) => {
            let off = byte_at(source, pos).ok_or(FlowError::NoIdentifier)?;
            let tok = token_at(root, off, source).ok_or(FlowError::NoIdentifier)?;
            let name = source[tok.byte_range()].to_owned();
            let func = decls()
                .into_iter()
                .find(|d| d.byte_range().contains(&tok.start_byte()))
                .ok_or(FlowError::NotInFunction { name: name.clone() })?;
            let (function, hits) = Lowerer::run(func, source);
            match hits.get(&tok.start_byte()) {
                Some(&e) => Ok(Lowered {
                    function,
                    picked: Picked::Event(e),
                }),
                None => Err(FlowError::NotLocal {
                    name,
                    function: function.qualified_name,
                }),
            }
        }
        Locate::Function {
            qualified_name,
            variable_key: key,
        } => {
            let func = decls()
                .into_iter()
                .find(|d| qualified_name_of(*d, source) == qualified_name)
                .ok_or(FlowError::FunctionGone)?;
            let (function, _) = Lowerer::run(func, source);
            let b = (0..function.bindings.len())
                .find(|&b| variable_key(&function, b) == key)
                .ok_or(FlowError::VariableGone)?;
            Ok(Lowered {
                function,
                picked: Picked::Binding(b),
            })
        }
    }
}

/// Same as `extract`: function = identifier, method = `receiver_type(receiver).name`.
fn qualified_name_of(decl: Node, source: &str) -> String {
    let text = |n: Node| &source[n.byte_range()];
    let name = decl.child_by_field_name("name").map_or("", text);
    let receiver = decl
        .child_by_field_name("receiver")
        .and_then(|r| r.named_child(0))
        .and_then(|p| p.child_by_field_name("type"));
    match receiver {
        Some(r) => format!("{}.{name}", receiver_type(text(r))),
        None => name.to_owned(),
    }
}

/// UTF-16 `Pos` → byte offset, clamped to the line's end. `None` past the last line.
fn byte_at(source: &str, pos: Pos) -> Option<usize> {
    let start = line_starts(source)
        .get(pos.line.checked_sub(1)? as usize)
        .copied()?;
    let mut units = 0;
    for (i, ch) in source[start..].char_indices() {
        if units >= pos.character || ch == '\n' || ch == '\r' {
            return Some(start + i);
        }
        units += ch.len_utf16() as u32;
    }
    Some(source.len())
}

fn line_starts(source: &str) -> Vec<usize> {
    std::iter::once(0)
        .chain(source.match_indices('\n').map(|(i, _)| i + 1))
        .collect()
}

/// The identifier or keyword leaf touching `off`, preferring one that contains it over one
/// ending exactly at it.
fn token_at<'t>(n: Node<'t>, off: usize, source: &str) -> Option<Node<'t>> {
    if n.child_count() == 0 {
        let text = &source[n.byte_range()];
        let word = text.starts_with(|c: char| c.is_alphabetic() || c == '_')
            && text.chars().all(|c| c.is_alphanumeric() || c == '_');
        return (word && !n.kind().contains("literal")).then_some(n);
    }
    let mut best = None;
    let mut c = n.walk();
    for child in n.children(&mut c) {
        if child.start_byte() <= off && off <= child.end_byte() {
            if let Some(t) = token_at(child, off, source) {
                if off < t.end_byte() {
                    return Some(t);
                }
                best = Some(t);
            }
        }
    }
    best
}

/// Named children with their field names.
fn fields(n: Node) -> Vec<(Option<&'static str>, Node)> {
    let mut out = Vec::new();
    let mut c = n.walk();
    if c.goto_first_child() {
        loop {
            if c.node().is_named() {
                out.push((c.field_name(), c.node()));
            }
            if !c.goto_next_sibling() {
                break;
            }
        }
    }
    out
}

/// The statements of a `block` or a clause: its field-less named children, with
/// `statement_list` flattened and comments dropped.
fn stmts(n: Node) -> Vec<Node> {
    let mut out = Vec::new();
    for (field, c) in fields(n) {
        match (field, c.kind()) {
            (Some(_), _) | (_, "comment") => {}
            (None, "statement_list") => out.extend(stmts(c)),
            _ => out.push(c),
        }
    }
    out
}

fn named(n: Option<Node>) -> Vec<Node> {
    n.map(|n| {
        let mut c = n.walk();
        n.named_children(&mut c).collect()
    })
    .unwrap_or_default()
}

/// A declaration's `name` fields.
fn names(n: Node) -> Vec<Node> {
    let mut c = n.walk();
    n.children_by_field_name("name", &mut c).collect()
}

fn has_define(n: Node) -> bool {
    let mut c = n.walk();
    let found = n.children(&mut c).any(|c| c.kind() == ":=");
    found
}

/// A `for`, `switch` or `select` that `break` / `continue` can target.
struct Jump {
    label: Option<String>,
    is_loop: bool,
    breaks: Vec<usize>,
    continues: Vec<usize>,
}

struct Lowerer<'s> {
    src: &'s str,
    starts: Vec<usize>,
    f: FlowFunction,
    /// Blocks flowing into the next statement.
    preds: Vec<usize>,
    /// The block the next statement may append to, when `preds` is exactly it.
    open: Option<usize>,
    /// `None` shadows an outer binding with a non-binding (a local `const`).
    scopes: Vec<Vec<(String, Option<usize>)>>,
    /// Identifier start byte → its event (a capture's for references inside a literal).
    hits: HashMap<usize, usize>,
    /// (outermost literal start byte, binding) → capture event.
    captures: HashMap<(usize, usize), usize>,
    jumps: Vec<Jump>,
    labels: HashMap<String, usize>,
    gotos: Vec<(usize, String)>,
    pending_label: Option<String>,
}

impl<'s> Lowerer<'s> {
    fn run(decl: Node, src: &'s str) -> (FlowFunction, HashMap<usize, usize>) {
        let mut l = Lowerer {
            src,
            starts: line_starts(src),
            f: FlowFunction {
                qualified_name: qualified_name_of(decl, src),
                blocks: vec![FlowBlock {
                    kind: BlockKind::Entry,
                    lines: None,
                    first_line: String::new(),
                }],
                branches: Vec::new(),
                bindings: Vec::new(),
                events: Vec::new(),
            },
            preds: vec![0],
            open: Some(0),
            scopes: vec![Vec::new()],
            hits: HashMap::new(),
            captures: HashMap::new(),
            jumps: Vec::new(),
            labels: HashMap::new(),
            gotos: Vec::new(),
            pending_label: None,
        };
        for list in ["receiver", "parameters", "result"] {
            for p in named(decl.child_by_field_name(list)) {
                for id in names(p) {
                    l.declare_def(id);
                }
            }
        }
        l.open = None;
        // The body shares the parameters' scope.
        if let Some(body) = decl.child_by_field_name("body") {
            for s in stmts(body) {
                l.stmt(s);
            }
        }
        l.finish()
    }

    fn finish(mut self) -> (FlowFunction, HashMap<usize, usize>) {
        let exit = self.f.blocks.len();
        self.f.blocks.push(FlowBlock {
            kind: BlockKind::Exit,
            lines: None,
            first_line: String::new(),
        });
        for p in std::mem::take(&mut self.preds) {
            self.edge(p, EXIT);
        }
        for (from, label) in std::mem::take(&mut self.gotos) {
            if let Some(&to) = self.labels.get(&label) {
                self.edge(from, to);
            }
        }
        for (_, to) in &mut self.f.branches {
            if *to == EXIT {
                *to = exit;
            }
        }
        for b in &mut self.f.blocks {
            if let Some(r) = b.lines {
                let row = r.start as usize - 1;
                let end = self.starts.get(row + 1).copied().unwrap_or(self.src.len());
                b.first_line = self.src[self.starts[row]..end].trim().to_owned();
            }
        }
        (self.f, self.hits)
    }

    fn edge(&mut self, from: usize, to: usize) {
        if !self.f.branches.contains(&(from, to)) {
            self.f.branches.push((from, to));
        }
    }

    /// Put rows `start..=end` (0-based) in the current block, starting a new one unless the
    /// flow is a straight line from the open block.
    fn touch(&mut self, start: usize, end: usize) -> usize {
        let b = match (self.preds.as_slice(), self.open) {
            ([p], Some(o)) if *p == o => o,
            _ => {
                let b = self.f.blocks.len();
                self.f.blocks.push(FlowBlock {
                    kind: BlockKind::Basic,
                    lines: None,
                    first_line: String::new(),
                });
                for p in std::mem::take(&mut self.preds) {
                    self.edge(p, b);
                }
                b
            }
        };
        let (start, end) = (start as u32 + 1, end as u32 + 1);
        let lines = &mut self.f.blocks[b].lines;
        *lines = Some(match *lines {
            Some(r) => LineRange {
                start: r.start.min(start),
                end: r.end.max(end),
            },
            None => LineRange { start, end },
        });
        self.preds = vec![b];
        self.open = Some(b);
        b
    }

    fn touch_node(&mut self, n: Node) -> usize {
        self.touch(n.start_position().row, n.end_position().row)
    }

    /// Ends straight-line flow: the next statement starts a new block.
    fn branch_from(&mut self, preds: Vec<usize>) {
        let mut preds = preds;
        preds.sort_unstable();
        preds.dedup();
        self.preds = preds;
        self.open = None;
    }

    fn pos(&self, byte: usize) -> Pos {
        let row = self.starts.partition_point(|&s| s <= byte) - 1;
        Pos {
            line: row as u32 + 1,
            character: self.src[self.starts[row]..byte].encode_utf16().count() as u32,
        }
    }

    fn emit(
        &mut self,
        start: usize,
        end: usize,
        binding: usize,
        role: Role,
        capture: bool,
    ) -> usize {
        let pos = self.pos(start);
        let end_char = self.pos(end).character;
        self.f.events.push(FlowEvent {
            block: self.open.expect("statement touched its block"),
            binding,
            role,
            pos,
            end_char,
            capture,
        });
        self.f.events.len() - 1
    }

    fn occurrence(&mut self, id: Node, binding: usize, role: Role) {
        let e = self.emit(id.start_byte(), id.end_byte(), binding, role, false);
        self.hits.insert(id.start_byte(), e);
    }

    fn text(&self, n: Node) -> &'s str {
        &self.src[n.byte_range()]
    }

    fn lookup(&self, name: &str) -> Option<usize> {
        self.scopes
            .iter()
            .rev()
            .find_map(|s| s.iter().rev().find(|(n, _)| n == name).map(|&(_, b)| b))
            .flatten()
    }

    /// A `:=` / `var` / parameter name: the same-scope binding, or a new one. Then its def.
    fn declare_def(&mut self, id: Node) {
        let name = self.text(id);
        if name == "_" {
            return;
        }
        let scope = self.scopes.last().expect("a scope");
        let b = match scope.iter().find(|(n, _)| n == name) {
            Some(&(_, Some(b))) => b,
            _ => {
                self.f.bindings.push(Binding {
                    name: name.to_owned(),
                    decl: self.pos(id.start_byte()),
                });
                let b = self.f.bindings.len() - 1;
                self.scopes
                    .last_mut()
                    .expect("a scope")
                    .push((name.to_owned(), Some(b)));
                b
            }
        };
        self.occurrence(id, b, Role::Def);
    }

    fn reference(&mut self, id: Node, role: Role) {
        let name = self.text(id);
        if name == "_" {
            return;
        }
        if let Some(b) = self.lookup(name) {
            self.occurrence(id, b, role);
        }
    }

    /// Evaluate an expression: every identifier naming a binding is a use.
    fn expr(&mut self, n: Node) {
        match n.kind() {
            "identifier" => self.reference(n, Role::Use),
            "func_literal" => {
                let mut local = vec![Vec::new()];
                self.capture(n, n, &mut local);
            }
            _ => {
                for (field, c) in fields(n) {
                    if !matches!(field, Some("type" | "field" | "key" | "label")) {
                        self.expr(c);
                    }
                }
            }
        }
    }

    fn expr_field(&mut self, n: Node, field: &str) {
        if let Some(c) = n.child_by_field_name(field) {
            self.expr(c);
        }
    }

    /// `left = right` / `left op= right`: operand uses, the right side, then the defs.
    fn assign(&mut self, left: Option<Node>, right: Option<Node>, compound: bool) {
        let left = named(left);
        for &l in &left {
            if l.kind() != "identifier" {
                self.expr(l);
            } else if compound {
                self.reference(l, Role::Use);
            }
        }
        if let Some(r) = right {
            self.expr(r);
        }
        for l in left {
            if l.kind() == "identifier" {
                self.reference(l, Role::Def);
            }
        }
    }

    /// `left := right`.
    fn define(&mut self, left: Option<Node>, right: Option<Node>) {
        if let Some(r) = right {
            self.expr(r);
        }
        for id in named(left) {
            if id.kind() == "identifier" {
                self.declare_def(id);
            }
        }
    }

    fn stmt(&mut self, n: Node) {
        let field = |f| n.child_by_field_name(f);
        match n.kind() {
            "block" => {
                self.scopes.push(Vec::new());
                for s in stmts(n) {
                    self.stmt(s);
                }
                self.scopes.pop();
            }
            "short_var_declaration" => {
                self.touch_node(n);
                self.define(field("left"), field("right"));
            }
            "var_declaration" | "const_declaration" => {
                self.touch_node(n);
                for spec in fields(n).into_iter().flat_map(|(_, s)| match s.kind() {
                    "var_spec_list" | "const_spec_list" => named(Some(s)),
                    _ => vec![s],
                }) {
                    if spec.kind() == "comment" {
                        continue;
                    }
                    self.expr_field(spec, "value");
                    for id in names(spec) {
                        if spec.kind() == "var_spec" {
                            self.declare_def(id);
                        } else {
                            let name = self.text(id).to_owned();
                            self.scopes.last_mut().expect("a scope").push((name, None));
                        }
                    }
                }
            }
            "assignment_statement" => {
                self.touch_node(n);
                let compound = field("operator").is_some_and(|o| self.text(o) != "=");
                self.assign(field("left"), field("right"), compound);
            }
            "inc_statement" | "dec_statement" => {
                self.touch_node(n);
                match n.named_child(0) {
                    Some(id) if id.kind() == "identifier" => {
                        self.reference(id, Role::Use);
                        self.reference(id, Role::Def);
                    }
                    Some(e) => self.expr(e),
                    None => {}
                }
            }
            "if_statement" => self.if_(n),
            "for_statement" => self.for_(n),
            "expression_switch_statement" | "type_switch_statement" | "select_statement" => {
                self.switch(n)
            }
            "labeled_statement" => {
                let label = field("label").map(|l| self.text(l).to_owned());
                self.open = None;
                let row = n.start_position().row;
                let b = self.touch(row, row);
                if let Some(label) = &label {
                    self.labels.insert(label.clone(), b);
                }
                if let Some(inner) = stmts(n).into_iter().next() {
                    if matches!(
                        inner.kind(),
                        "for_statement"
                            | "expression_switch_statement"
                            | "type_switch_statement"
                            | "select_statement"
                    ) {
                        self.pending_label = label;
                    }
                    self.stmt(inner);
                    self.pending_label = None;
                }
            }
            "return_statement" => {
                let b = self.touch_node(n);
                self.expr(n);
                self.edge(b, EXIT);
                self.branch_from(Vec::new());
            }
            "break_statement" | "continue_statement" => {
                let b = self.touch_node(n);
                let label = n.named_child(0).map(|l| self.text(l));
                let is_break = n.kind() == "break_statement";
                if let Some(j) = self.jumps.iter_mut().rev().find(|j| match label {
                    Some(l) => j.label.as_deref() == Some(l),
                    None => is_break || j.is_loop,
                }) {
                    if is_break {
                        j.breaks.push(b);
                    } else {
                        j.continues.push(b);
                    }
                }
                self.branch_from(Vec::new());
            }
            "goto_statement" => {
                let b = self.touch_node(n);
                if let Some(l) = n.named_child(0) {
                    self.gotos.push((b, self.text(l).to_owned()));
                }
                self.branch_from(Vec::new());
            }
            "empty_statement" | "comment" => {}
            // expression, send, go, defer, inc of a non-identifier, local type declarations.
            _ => {
                self.touch_node(n);
                self.expr(n);
            }
        }
    }

    fn if_(&mut self, n: Node) {
        self.scopes.push(Vec::new());
        if let Some(init) = n.child_by_field_name("initializer") {
            self.stmt(init);
        }
        let cond = n.child_by_field_name("condition");
        let end = cond.unwrap_or(n).end_position().row;
        let c = self.touch(n.start_position().row, end);
        if let Some(cond) = cond {
            self.expr(cond);
        }
        self.branch_from(vec![c]);
        if let Some(then) = n.child_by_field_name("consequence") {
            self.stmt(then);
        }
        let mut after = std::mem::take(&mut self.preds);
        self.branch_from(vec![c]);
        if let Some(alt) = n.child_by_field_name("alternative") {
            self.stmt(alt);
        }
        after.append(&mut self.preds);
        self.branch_from(after);
        self.scopes.pop();
    }

    fn for_(&mut self, n: Node) {
        let label = self.pending_label.take();
        self.scopes.push(Vec::new());
        let head = fields(n)
            .into_iter()
            .find(|(f, c)| f.is_none() && c.kind() != "comment")
            .map(|(_, c)| c);
        let clause = head.filter(|h| h.kind() == "for_clause");
        if let Some(init) = clause.and_then(|c| c.child_by_field_name("initializer")) {
            self.stmt(init);
        }
        self.open = None;
        let end = head.map_or(n.start_position().row, |h| h.end_position().row);
        let header = self.touch(n.start_position().row, end);
        let exits = match head {
            Some(h) if h.kind() == "for_clause" => {
                let cond = h.child_by_field_name("condition");
                if let Some(cond) = cond {
                    self.expr(cond);
                }
                cond.is_some()
            }
            Some(h) if h.kind() == "range_clause" => {
                let (left, right) = (
                    h.child_by_field_name("left"),
                    h.child_by_field_name("right"),
                );
                if has_define(h) {
                    self.define(left, right);
                } else {
                    self.assign(left, right, false);
                }
                true
            }
            Some(cond) => {
                self.expr(cond);
                true
            }
            None => false,
        };
        self.jumps.push(Jump {
            label,
            is_loop: true,
            breaks: Vec::new(),
            continues: Vec::new(),
        });
        self.branch_from(vec![header]);
        if let Some(body) = n.child_by_field_name("body") {
            self.stmt(body);
        }
        let jump = self.jumps.pop().expect("pushed above");
        if !jump.continues.is_empty() {
            let mut preds = std::mem::take(&mut self.preds);
            preds.extend(jump.continues);
            self.branch_from(preds);
        }
        // The post statement runs after the body's end or a `continue`.
        if let Some(update) = clause.and_then(|c| c.child_by_field_name("update")) {
            self.stmt(update);
        }
        for p in std::mem::take(&mut self.preds) {
            self.edge(p, header);
        }
        let mut after = jump.breaks;
        if exits {
            after.push(header);
        }
        self.branch_from(after);
        self.scopes.pop();
    }

    /// `switch`, type switch and `select`: one block per clause, entered from the header.
    fn switch(&mut self, n: Node) {
        let label = self.pending_label.take();
        self.scopes.push(Vec::new());
        if let Some(init) = n.child_by_field_name("initializer") {
            self.stmt(init);
        }
        let value = n.child_by_field_name("value");
        let end = value.map_or(n.start_position().row, |v| v.end_position().row);
        let c = self.touch(n.start_position().row, end);
        if let Some(v) = value {
            self.expr(v);
        }
        for id in named(n.child_by_field_name("alias")) {
            self.declare_def(id);
        }
        self.jumps.push(Jump {
            label,
            is_loop: false,
            breaks: Vec::new(),
            continues: Vec::new(),
        });
        let (mut after, mut fall, mut default) = (Vec::new(), Vec::new(), false);
        for (_, clause) in fields(n) {
            if !clause.kind().ends_with("_case") {
                continue;
            }
            default |= clause.kind() == "default_case";
            let mut preds = vec![c];
            preds.append(&mut fall);
            self.branch_from(preds);
            self.scopes.push(Vec::new());
            let row = clause.start_position().row;
            self.touch(row, row);
            self.expr_field(clause, "value");
            if let Some(comm) = clause.child_by_field_name("communication") {
                self.touch_node(comm);
                let (left, right) = (
                    comm.child_by_field_name("left"),
                    comm.child_by_field_name("right"),
                );
                match comm.kind() {
                    "receive_statement" if has_define(comm) => self.define(left, right),
                    "receive_statement" => self.assign(left, right, false),
                    _ => self.expr(comm),
                }
            }
            for s in stmts(clause) {
                if s.kind() == "fallthrough_statement" {
                    self.touch_node(s);
                    fall = std::mem::take(&mut self.preds);
                } else {
                    self.stmt(s);
                }
            }
            self.scopes.pop();
            after.append(&mut self.preds);
        }
        // A `select` without `default` blocks until a case runs; a `switch` falls out.
        if !default && n.kind() != "select_statement" {
            after.push(c);
        }
        after.extend(self.jumps.pop().expect("pushed above").breaks);
        self.branch_from(after);
        self.scopes.pop();
    }

    /// Inside a `func_literal`: every reference to a traced-function binding is one capture
    /// use per (outermost literal, binding) at the literal's `func`; nothing else is lowered.
    /// `local` holds the literal's own names, which shadow the function's.
    fn capture(&mut self, lit: Node, n: Node, local: &mut Vec<Vec<String>>) {
        let declare = |local: &mut Vec<Vec<String>>, ids: Vec<Node>, src: &str| {
            let top = local.last_mut().expect("a scope");
            top.extend(ids.iter().map(|id| src[id.byte_range()].to_owned()));
        };
        match n.kind() {
            "identifier" => {
                let name = self.text(n);
                if name == "_" || local.iter().any(|s| s.iter().any(|l| l == name)) {
                    return;
                }
                if let Some(b) = self.lookup(name) {
                    let key = (lit.start_byte(), b);
                    let e = match self.captures.get(&key) {
                        Some(&e) => e,
                        None => {
                            let start = lit.start_byte();
                            let e = self.emit(start, start + "func".len(), b, Role::Use, true);
                            self.captures.insert(key, e);
                            e
                        }
                    };
                    self.hits.insert(n.start_byte(), e);
                }
            }
            "parameter_declaration" | "variadic_parameter_declaration" => {
                declare(local, names(n), self.src);
            }
            "var_spec" | "const_spec" => {
                if let Some(v) = n.child_by_field_name("value") {
                    self.capture(lit, v, local);
                }
                declare(local, names(n), self.src);
            }
            "short_var_declaration" | "range_clause" | "receive_statement" if has_define(n) => {
                if let Some(r) = n.child_by_field_name("right") {
                    self.capture(lit, r, local);
                }
                declare(local, named(n.child_by_field_name("left")), self.src);
            }
            _ => {
                let scoped = n.kind().ends_with("_case")
                    || matches!(
                        n.kind(),
                        "func_literal"
                            | "block"
                            | "if_statement"
                            | "for_statement"
                            | "expression_switch_statement"
                            | "type_switch_statement"
                            | "select_statement"
                    );
                if scoped {
                    local.push(Vec::new());
                }
                for (field, c) in fields(n) {
                    match field {
                        Some("type" | "field" | "key" | "label") => {}
                        Some("alias") => declare(local, named(Some(c)), self.src),
                        _ => self.capture(lit, c, local),
                    }
                }
                if scoped {
                    local.pop();
                }
            }
        }
    }
}
