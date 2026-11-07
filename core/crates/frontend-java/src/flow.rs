//! Data flow: lower one Java method or constructor into `ir::flow`'s blocks, bindings and
//! def/use events, around a source position or by qualified name and variable key.

use std::collections::HashMap;

use ir::flow::variable_key;
use ir::{
    Binding, BlockKind, FlowBlock, FlowError, FlowEvent, FlowFunction, LineRange, Locate, Lowered,
    Picked, Pos, Role,
};
use tree_sitter::{Node, Parser};

use crate::extract::{language, qualified_name};

/// Branch target placeholder for `Exit`, which is only appended (last) at the end.
const EXIT: usize = usize::MAX;

const DECL_KINDS: &[&str] = &[
    "method_declaration",
    "constructor_declaration",
    "compact_constructor_declaration",
];

/// Local type declarations: capture sites, like lambdas and anonymous classes.
const LOCAL_TYPES: &[&str] = &[
    "class_declaration",
    "record_declaration",
    "interface_declaration",
    "enum_declaration",
];

pub(crate) fn lower(source: &str, at: Locate) -> Result<Lowered, FlowError> {
    let mut parser = Parser::new();
    parser
        .set_language(&language())
        .expect("tree-sitter-java grammar is compatible");
    let tree = parser.parse(source, None).expect("parser has a language");
    let root = tree.root_node();
    match at {
        Locate::At(pos) => {
            let off = byte_at(source, pos).ok_or(FlowError::NoIdentifier)?;
            let tok = token_at(root, off, source).ok_or(FlowError::NoIdentifier)?;
            let name = source[tok.byte_range()].to_owned();
            // The innermost declaration that is a graph def; methods of anonymous and local
            // classes lie inside a capture site of the traced function.
            let (func, qualified) = std::iter::successors(Some(tok), |n| n.parent())
                .filter(|n| DECL_KINDS.contains(&n.kind()))
                .find_map(|d| Some((d, qualified_name(d, source)?)))
                .ok_or(FlowError::NotInFunction { name: name.clone() })?;
            let (function, hits) = Lowerer::run(func, qualified, source);
            match hits.get(&tok.start_byte()) {
                Some(&picked) => Ok(Lowered { function, picked }),
                None => Err(FlowError::NotLocal {
                    name,
                    function: function.qualified_name,
                }),
            }
        }
        Locate::Function {
            qualified_name: wanted,
            variable_key: key,
        } => {
            // Overloads share a name: the first declaration in source order, as in `extract`.
            let mut all = Vec::new();
            decls(root, &mut all);
            let func = all
                .into_iter()
                .find(|d| qualified_name(*d, source).as_deref() == Some(wanted.as_str()))
                .ok_or(FlowError::FunctionGone)?;
            let (function, _) = Lowerer::run(func, wanted, source);
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

/// Every method / constructor declaration, in source order.
fn decls<'t>(n: Node<'t>, out: &mut Vec<Node<'t>>) {
    if DECL_KINDS.contains(&n.kind()) {
        out.push(n);
    }
    let mut c = n.walk();
    for child in n.named_children(&mut c) {
        decls(child, out);
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
        let literal = n.kind().contains("literal") || n.kind() == "string_fragment";
        return (word && !literal).then_some(n);
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

fn named(n: Option<Node>) -> Vec<Node> {
    n.map(|n| {
        let mut c = n.walk();
        n.named_children(&mut c).collect()
    })
    .unwrap_or_default()
}

/// The statements of a block, constructor body or switch group: comments and labels dropped.
fn stmts(n: Node) -> Vec<Node> {
    named(Some(n))
        .into_iter()
        .filter(|c| !c.kind().ends_with("comment") && c.kind() != "switch_label")
        .collect()
}

fn all_fields<'t>(n: Node<'t>, field: &str) -> Vec<Node<'t>> {
    let mut c = n.walk();
    n.children_by_field_name(field, &mut c).collect()
}

fn child_of_kind<'t>(n: Node<'t>, kinds: &[&str]) -> Option<Node<'t>> {
    let mut c = n.walk();
    let found = n.children(&mut c).find(|c| kinds.contains(&c.kind()));
    found
}

/// Where a capture event ends: the `->` of a lambda when on the site's first line, `new`, or
/// the local type's keyword; else the site's first token.
fn site_end(site: Node) -> usize {
    match child_of_kind(site, &["->", "new", "class", "record", "interface", "enum"]) {
        Some(k) if k.start_position().row == site.start_position().row => k.end_byte(),
        _ => {
            let mut leaf = site;
            while let Some(c) = leaf.child(0) {
                leaf = c;
            }
            leaf.end_byte()
        }
    }
}

/// A loop, `switch` or labelled statement that `break` / `continue` can target.
struct Jump {
    label: Option<String>,
    /// A `continue` target.
    is_loop: bool,
    /// An unlabelled `break` target (a loop or `switch`, not a labelled block).
    breakable: bool,
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
    scopes: Vec<Vec<(String, usize)>>,
    /// Identifier start byte → what picking it traces: its event (a capture's for references
    /// inside a capture site), or the binding of an initializer-free declarator.
    hits: HashMap<usize, Picked>,
    /// (outermost capture site start byte, binding) → capture event.
    captures: HashMap<(usize, usize), usize>,
    jumps: Vec<Jump>,
    pending_label: Option<String>,
}

impl<'s> Lowerer<'s> {
    fn run(
        decl: Node,
        qualified_name: String,
        src: &'s str,
    ) -> (FlowFunction, HashMap<usize, Picked>) {
        let mut l = Lowerer {
            src,
            starts: line_starts(src),
            f: FlowFunction {
                qualified_name,
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
            pending_label: None,
        };
        // ponytail: a compact constructor's implicit record-component parameters are not
        // bindings (they are declared on the record header); add them if tracing them matters.
        for p in named(decl.child_by_field_name("parameters")) {
            let id = match p.kind() {
                "formal_parameter" => p.child_by_field_name("name"),
                "spread_parameter" => child_of_kind(p, &["variable_declarator"])
                    .and_then(|d| d.child_by_field_name("name")),
                _ => None, // receiver parameter
            };
            if let Some(id) = id {
                l.declare_def(id);
            }
        }
        l.open = None;
        // The body shares the parameters' scope (Java forbids shadowing them).
        if let Some(body) = decl.child_by_field_name("body") {
            for s in stmts(body) {
                l.stmt(s);
            }
        }
        l.finish()
    }

    fn finish(mut self) -> (FlowFunction, HashMap<usize, Picked>) {
        let exit = self.f.blocks.len();
        self.f.blocks.push(FlowBlock {
            kind: BlockKind::Exit,
            lines: None,
            first_line: String::new(),
        });
        for p in std::mem::take(&mut self.preds) {
            self.edge(p, EXIT);
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
        self.hits.insert(id.start_byte(), Picked::Event(e));
    }

    fn text(&self, n: Node) -> &'s str {
        &self.src[n.byte_range()]
    }

    fn lookup(&self, name: &str) -> Option<usize> {
        self.scopes
            .iter()
            .rev()
            .find_map(|s| s.iter().rev().find(|(n, _)| n == name).map(|&(_, b)| b))
    }

    /// Every declaration is a new binding, visible from its declarator on.
    fn declare(&mut self, id: Node) -> Option<usize> {
        let name = self.text(id);
        if name == "_" {
            return None;
        }
        self.f.bindings.push(Binding {
            name: name.to_owned(),
            decl: self.pos(id.start_byte()),
        });
        let b = self.f.bindings.len() - 1;
        self.scopes
            .last_mut()
            .expect("a scope")
            .push((name.to_owned(), b));
        Some(b)
    }

    fn declare_def(&mut self, id: Node) {
        if let Some(b) = self.declare(id) {
            self.occurrence(id, b, Role::Def);
        }
    }

    fn reference(&mut self, id: Node, role: Role) {
        if let Some(b) = self.lookup(self.text(id)) {
            self.occurrence(id, b, role);
        }
    }

    /// Evaluate an expression: every identifier naming a binding is a use.
    // ponytail: `?:`, `&&`/`||` and value `switch` expressions don't split blocks, so a def in
    // one arm can kill a sibling arm's; declarations inside a `switch` expression's blocks are
    // not bindings.
    fn expr(&mut self, n: Node) {
        let field = |f| n.child_by_field_name(f);
        match n.kind() {
            "identifier" => self.reference(n, Role::Use),
            "lambda_expression" => self.capture_site(n),
            "object_creation_expression" if child_of_kind(n, &["class_body"]).is_some() => {
                self.capture_site(n)
            }
            "assignment_expression" => {
                let compound = field("operator").is_some_and(|o| self.text(o) != "=");
                match field("left") {
                    Some(id) if id.kind() == "identifier" => {
                        if compound {
                            self.reference(id, Role::Use);
                        }
                        if let Some(r) = field("right") {
                            self.expr(r);
                        }
                        self.reference(id, Role::Def);
                    }
                    left => {
                        // `x.f = …` / `x[i] = …`: uses of `x`.
                        for side in [left, field("right")].into_iter().flatten() {
                            self.expr(side);
                        }
                    }
                }
            }
            "update_expression" => match n.named_child(0) {
                Some(id) if id.kind() == "identifier" => {
                    self.reference(id, Role::Use);
                    self.reference(id, Role::Def);
                }
                Some(e) => self.expr(e),
                None => {}
            },
            "instanceof_expression" => {
                if let Some(l) = field("left") {
                    self.expr(l);
                }
                if let Some(id) = field("name") {
                    self.declare_def(id);
                }
                if let Some(p) = field("pattern") {
                    self.pattern(p);
                }
            }
            // `x::m`: a use of `x`, never of `m`.
            "method_reference" => {
                if let Some(c) = n.named_child(0) {
                    self.expr(c);
                }
            }
            _ => {
                for (field, c) in fields(n) {
                    if !matches!(field, Some("type" | "name" | "field")) {
                        self.expr(c);
                    }
                }
            }
        }
    }

    /// A `case` label or record pattern: pattern variables are defs, the rest is evaluated.
    fn pattern(&mut self, n: Node) {
        match n.kind() {
            "type_pattern" | "record_pattern_component" => {
                let parts = named(Some(n));
                match parts.last() {
                    Some(&id) if id.kind() == "identifier" => self.declare_def(id),
                    _ => parts.into_iter().for_each(|p| self.pattern(p)),
                }
            }
            // A record pattern's first child is its type's name.
            "record_pattern" => {
                if let Some(body) = child_of_kind(n, &["record_pattern_body"]) {
                    self.pattern(body);
                }
            }
            "pattern" | "record_pattern_body" | "switch_label" => {
                for c in named(Some(n)) {
                    self.pattern(c);
                }
            }
            _ => self.expr(n),
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
            "local_variable_declaration" => {
                self.touch_node(n);
                for d in all_fields(n, "declarator") {
                    let Some(id) = d.child_by_field_name("name") else {
                        continue;
                    };
                    match d.child_by_field_name("value") {
                        Some(v) => {
                            self.expr(v);
                            self.declare_def(id);
                        }
                        // Definite assignment: `int n;` is not a def.
                        None => {
                            if let Some(b) = self.declare(id) {
                                self.hits.insert(id.start_byte(), Picked::Binding(b));
                            }
                        }
                    }
                }
            }
            "if_statement" => self.if_(n),
            "while_statement" | "for_statement" | "enhanced_for_statement" => self.loop_(n),
            "do_statement" => self.do_(n),
            "switch_expression" => self.switch(n),
            "try_statement" | "try_with_resources_statement" => self.try_(n),
            "labeled_statement" => {
                let label = n.named_child(0).map(|l| self.text(l).to_owned());
                let Some(inner) = n.named_child(1) else {
                    return;
                };
                if matches!(
                    inner.kind(),
                    "while_statement"
                        | "for_statement"
                        | "enhanced_for_statement"
                        | "do_statement"
                        | "switch_expression"
                ) {
                    self.pending_label = label;
                    self.stmt(inner);
                    self.pending_label = None;
                } else {
                    // `label: { … break label; … }`
                    self.jumps.push(Jump {
                        label,
                        is_loop: false,
                        breakable: false,
                        breaks: Vec::new(),
                        continues: Vec::new(),
                    });
                    self.stmt(inner);
                    let jump = self.jumps.pop().expect("pushed above");
                    if !jump.breaks.is_empty() {
                        let mut preds = std::mem::take(&mut self.preds);
                        preds.extend(jump.breaks);
                        self.branch_from(preds);
                    }
                }
            }
            // `throw` also reaches the enclosing try's handlers: its block is a try-body block.
            "return_statement" | "throw_statement" => {
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
                    None if is_break => j.breakable,
                    None => j.is_loop,
                }) {
                    if is_break {
                        j.breaks.push(b);
                    } else {
                        j.continues.push(b);
                    }
                }
                self.branch_from(Vec::new());
            }
            "synchronized_statement" => {
                let head = n.named_child(0).unwrap_or(n);
                self.touch(n.start_position().row, head.end_position().row);
                self.expr(head);
                if let Some(body) = field("body") {
                    self.stmt(body);
                }
            }
            k if LOCAL_TYPES.contains(&k) => {
                self.touch_node(n);
                self.capture_site(n);
            }
            // expression statements, `assert`, `this(…)` / `super(…)`, `yield`.
            _ => {
                self.touch_node(n);
                self.expr(n);
            }
        }
    }

    fn if_(&mut self, n: Node) {
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
    }

    fn push_loop(&mut self) {
        let label = self.pending_label.take();
        self.jumps.push(Jump {
            label,
            is_loop: true,
            breakable: true,
            breaks: Vec::new(),
            continues: Vec::new(),
        });
    }

    /// `while`, classic `for` (init, header, body, update) and enhanced `for` (the header
    /// evaluates the iterable and defines the variable each iteration).
    fn loop_(&mut self, n: Node) {
        let field = |f| n.child_by_field_name(f);
        self.push_loop();
        self.scopes.push(Vec::new());
        for init in all_fields(n, "init") {
            if init.kind() == "local_variable_declaration" {
                self.stmt(init);
            } else {
                self.touch_node(init);
                self.expr(init);
            }
        }
        self.open = None;
        let head_end = field("value")
            .or(field("condition"))
            .map_or(n.start_position().row, |h| h.end_position().row);
        let header = self.touch(n.start_position().row, head_end);
        let mut exits = true;
        if n.kind() == "enhanced_for_statement" {
            if let Some(v) = field("value") {
                self.expr(v);
            }
            if let Some(id) = field("name") {
                self.declare_def(id);
            }
        } else {
            let cond = field("condition");
            if let Some(c) = cond {
                self.expr(c);
            }
            // `for (;;)` and `while (true)` only leave by `break`.
            exits = cond.is_some_and(|c| {
                self.text(c)
                    .trim_matches(|ch: char| ch == '(' || ch == ')' || ch.is_whitespace())
                    != "true"
            });
        }
        self.branch_from(vec![header]);
        if let Some(body) = field("body") {
            self.stmt(body);
        }
        let jump = self.jumps.pop().expect("pushed above");
        if !jump.continues.is_empty() {
            let mut preds = std::mem::take(&mut self.preds);
            preds.extend(jump.continues);
            self.branch_from(preds);
        }
        // The update runs after the body's end or a `continue`.
        for update in all_fields(n, "update") {
            self.touch_node(update);
            self.expr(update);
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

    /// `do body while (cond);`: the body first, a back edge from the condition to it.
    fn do_(&mut self, n: Node) {
        self.push_loop();
        let preds = std::mem::take(&mut self.preds);
        self.branch_from(preds);
        let first = self.f.blocks.len();
        if let Some(body) = n.child_by_field_name("body") {
            self.stmt(body);
        }
        let jump = self.jumps.pop().expect("pushed above");
        let mut preds = std::mem::take(&mut self.preds);
        preds.extend(jump.continues);
        self.branch_from(preds);
        let cond = n.child_by_field_name("condition");
        let c = self.touch(cond.unwrap_or(n).start_position().row, n.end_position().row);
        if let Some(cond) = cond {
            self.expr(cond);
        }
        // An empty body: the condition loops on itself.
        self.edge(c, if first < c { first } else { c });
        let mut after = jump.breaks;
        after.push(c);
        self.branch_from(after);
    }

    /// A `switch` statement: one block per group or rule, entered from the header. Colon
    /// groups fall through to the next unless they `break`; arrow rules never do.
    fn switch(&mut self, n: Node) {
        let label = self.pending_label.take();
        let cond = n.child_by_field_name("condition");
        let end = cond.map_or(n.start_position().row, |v| v.end_position().row);
        let c = self.touch(n.start_position().row, end);
        if let Some(v) = cond {
            self.expr(v);
        }
        self.jumps.push(Jump {
            label,
            is_loop: false,
            breakable: true,
            breaks: Vec::new(),
            continues: Vec::new(),
        });
        let (mut after, mut fall, mut default) = (Vec::new(), Vec::new(), false);
        for clause in named(n.child_by_field_name("body")) {
            let labels: Vec<Node> = named(Some(clause))
                .into_iter()
                .filter(|l| l.kind() == "switch_label")
                .collect();
            let Some(last) = labels.last() else {
                continue;
            };
            default |= labels
                .iter()
                .any(|l| child_of_kind(*l, &["default"]).is_some());
            let mut preds = vec![c];
            preds.append(&mut fall);
            self.branch_from(preds);
            self.scopes.push(Vec::new());
            self.touch(clause.start_position().row, last.end_position().row);
            for l in &labels {
                self.pattern(*l);
            }
            for s in stmts(clause) {
                self.stmt(s);
            }
            self.scopes.pop();
            if clause.kind() == "switch_rule" {
                after.append(&mut self.preds);
            } else {
                fall = std::mem::take(&mut self.preds);
            }
        }
        after.append(&mut fall);
        if !default {
            after.push(c);
        }
        after.extend(self.jumps.pop().expect("pushed above").breaks);
        self.branch_from(after);
    }

    /// `try`: each body statement ends a block; the block before the body and every body
    /// block may throw into each `catch` and `finally`. The end of `finally` continues after
    /// the `try` and also leaves to `Exit`.
    // ponytail: `return` / `break` / `continue` inside a try jump straight to their target,
    // not through `finally`, and a `throw` in a `catch` skips `finally`.
    fn try_(&mut self, n: Node) {
        self.scopes.push(Vec::new());
        if let Some(res) = n.child_by_field_name("resources") {
            self.touch_node(res);
            for r in named(Some(res)) {
                match (
                    r.child_by_field_name("name"),
                    r.child_by_field_name("value"),
                ) {
                    (Some(id), value) => {
                        if let Some(v) = value {
                            self.expr(v);
                        }
                        self.declare_def(id);
                    }
                    (None, _) => self.expr(r),
                }
            }
        }
        let mut handlers = std::mem::take(&mut self.preds);
        self.branch_from(handlers.clone());
        let first = self.f.blocks.len();
        if let Some(body) = n.child_by_field_name("body") {
            self.scopes.push(Vec::new());
            for s in stmts(body) {
                self.stmt(s);
                let preds = std::mem::take(&mut self.preds);
                self.branch_from(preds);
            }
            self.scopes.pop();
        }
        handlers.extend(first..self.f.blocks.len());
        let mut after = std::mem::take(&mut self.preds);
        let mut finally = None;
        for c in named(Some(n)) {
            match c.kind() {
                "catch_clause" => {
                    self.branch_from(handlers.clone());
                    self.scopes.push(Vec::new());
                    let row = c.start_position().row;
                    self.touch(row, row);
                    if let Some(id) = child_of_kind(c, &["catch_formal_parameter"])
                        .and_then(|p| p.child_by_field_name("name"))
                    {
                        self.declare_def(id);
                    }
                    if let Some(body) = c.child_by_field_name("body") {
                        self.stmt(body);
                    }
                    self.scopes.pop();
                    after.append(&mut self.preds);
                }
                "finally_clause" => finally = Some(c),
                _ => {}
            }
        }
        if let Some(fin) = finally {
            after.extend(handlers);
            self.branch_from(after);
            let row = fin.start_position().row;
            self.touch(row, row);
            if let Some(block) = child_of_kind(fin, &["block"]) {
                self.stmt(block);
            }
            after = std::mem::take(&mut self.preds);
            for &p in &after {
                self.edge(p, EXIT);
            }
        }
        self.branch_from(after);
        self.scopes.pop();
    }

    fn capture_site(&mut self, site: Node) {
        let mut local = vec![Vec::new()];
        self.capture(site, site, &mut local);
    }

    /// Inside a capture site: every reference to a traced-function binding is one capture use
    /// per (outermost site, binding) at the site's start; nothing else is lowered. `local`
    /// holds the site's own names, which shadow the function's.
    fn capture(&mut self, site: Node, n: Node, local: &mut Vec<Vec<String>>) {
        let src = self.src;
        let declare = |id: Node, local: &mut Vec<Vec<String>>| {
            if id.kind() == "identifier" {
                let top = local.last_mut().expect("a scope");
                top.push(src[id.byte_range()].to_owned());
            }
        };
        match n.kind() {
            "identifier" => {
                let name = self.text(n);
                if local.iter().any(|s| s.iter().any(|l| l == name)) {
                    return;
                }
                if let Some(b) = self.lookup(name) {
                    let key = (site.start_byte(), b);
                    let e = match self.captures.get(&key) {
                        Some(&e) => e,
                        None => {
                            let e =
                                self.emit(site.start_byte(), site_end(site), b, Role::Use, true);
                            self.captures.insert(key, e);
                            e
                        }
                    };
                    self.hits.insert(n.start_byte(), Picked::Event(e));
                }
            }
            "method_reference" => {
                if let Some(c) = n.named_child(0) {
                    self.capture(site, c, local);
                }
            }
            "break_statement" | "continue_statement" => {}
            "type_pattern" | "record_pattern_component" => {
                for c in named(Some(n)) {
                    declare(c, local);
                }
            }
            _ => {
                let scoped = matches!(
                    n.kind(),
                    "block"
                        | "class_body"
                        | "lambda_expression"
                        | "for_statement"
                        | "enhanced_for_statement"
                        | "catch_clause"
                        | "switch_block_statement_group"
                        | "switch_rule"
                        | "try_with_resources_statement"
                ) || DECL_KINDS.contains(&n.kind());
                if scoped {
                    local.push(Vec::new());
                }
                for (field, c) in fields(n) {
                    match field {
                        Some("type" | "field") => {}
                        Some("name") if n.kind() != "method_invocation" => declare(c, local),
                        Some("name") => {}
                        Some("parameters") if c.kind() == "identifier" => declare(c, local),
                        Some("parameters") if c.kind() == "inferred_parameters" => {
                            for id in named(Some(c)) {
                                declare(id, local);
                            }
                        }
                        _ if n.kind() == "labeled_statement" && c.kind() == "identifier" => {}
                        _ => self.capture(site, c, local),
                    }
                }
                if scoped {
                    local.pop();
                }
            }
        }
    }
}
