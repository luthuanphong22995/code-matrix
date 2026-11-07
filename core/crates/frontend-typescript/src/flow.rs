//! Data flow: lower one TypeScript/JavaScript function or method into `ir::flow`'s blocks,
//! bindings and def/use events, around a source position or by qualified name and variable key.

use std::collections::HashMap;

use ir::flow::variable_key;
use ir::{
    Binding, BlockKind, DefKind, FlowBlock, FlowError, FlowEvent, FlowFunction, LineRange, Locate,
    Lowered, Picked, Pos, Role,
};
use tree_sitter::{Node, Parser};

use crate::extract::def_of;

/// Branch target placeholder for `Exit`, which is only appended (last) at the end.
const EXIT: usize = usize::MAX;

/// Function and class nodes: capture sites inside the traced function, and the scopes a
/// capture site's own names live in.
const FUNCS: &[&str] = &[
    "function_declaration",
    "generator_function_declaration",
    "function_expression",
    "generator_function",
    "arrow_function",
    "method_definition",
    "class_declaration",
    "abstract_class_declaration",
    "class",
];

/// Type-only subtrees: never occurrences.
const TYPES: &[&str] = &[
    "type_annotation",
    "type_arguments",
    "type_parameters",
    "type_alias_declaration",
    "interface_declaration",
];

pub(crate) fn lower(path: &str, source: &str, at: Locate) -> Result<Lowered, FlowError> {
    // Unknown extensions never reach here through the registry.
    let language =
        crate::grammar(path).unwrap_or_else(|_| tree_sitter_typescript::LANGUAGE_TSX.into());
    let mut parser = Parser::new();
    parser
        .set_language(&language)
        .expect("tree-sitter-typescript is ABI compatible");
    let tree = parser.parse(source, None).expect("parser has a language");
    let root = tree.root_node();
    let mut funcs = Vec::new();
    functions(root, source, &mut Vec::new(), &mut funcs);
    match at {
        Locate::At(pos) => {
            let off = byte_at(source, pos).ok_or(FlowError::NoIdentifier)?;
            let tok = token_at(root, off, source).ok_or(FlowError::NoIdentifier)?;
            let name = source[tok.byte_range()].to_owned();
            // Preorder: the innermost function containing the token is the last one.
            let (func, qualified_name) = funcs
                .into_iter()
                .rfind(|(f, _)| f.byte_range().contains(&tok.start_byte()))
                .ok_or(FlowError::NotInFunction { name: name.clone() })?;
            let (function, hits) = Lowerer::run(func, qualified_name, source);
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
            let (func, qualified_name) = funcs
                .into_iter()
                .find(|(_, q)| *q == qualified_name)
                .ok_or(FlowError::FunctionGone)?;
            let (function, _) = Lowerer::run(func, qualified_name, source);
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

/// Every `DefKind::Function` def node with its qualified name, in preorder; names are built
/// from `def_of` the same way `extract` builds them.
fn functions<'t>(
    n: Node<'t>,
    src: &str,
    stack: &mut Vec<String>,
    out: &mut Vec<(Node<'t>, String)>,
) {
    let def = def_of(n, src, stack.is_empty());
    let pushed = def.is_some();
    if let Some((kind, name)) = def {
        let qualified_name = match stack.last() {
            Some(p) => format!("{p}.{name}"),
            None => name,
        };
        if matches!(kind, DefKind::Function) {
            out.push((n, qualified_name.clone()));
        }
        stack.push(qualified_name);
    }
    let mut c = n.walk();
    for child in n.children(&mut c) {
        functions(child, src, stack, out);
    }
    if pushed {
        stack.pop();
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
        let ident = |c: char| c.is_alphanumeric() || c == '_' || c == '$';
        let word = text.starts_with(|c: char| c.is_alphabetic() || c == '_' || c == '$')
            && text.chars().all(ident);
        let prose = matches!(n.kind(), "string_fragment" | "regex_pattern" | "jsx_text");
        return (word && !prose).then_some(n);
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

fn named(n: Option<Node>) -> Vec<Node> {
    n.map(|n| {
        let mut c = n.walk();
        n.named_children(&mut c).collect()
    })
    .unwrap_or_default()
}

/// The statements of a block or a `case`: its named children minus comments and the case
/// test.
fn stmts(n: Node) -> Vec<Node> {
    let mut out = Vec::new();
    let mut c = n.walk();
    if c.goto_first_child() {
        loop {
            let node = c.node();
            if node.is_named() && node.kind() != "comment" && c.field_name() != Some("value") {
                out.push(node);
            }
            if !c.goto_next_sibling() {
                break;
            }
        }
    }
    out
}

/// The identifiers a pattern (or parameter) binds, in source order.
fn pattern_ids<'t>(n: Node<'t>, out: &mut Vec<Node<'t>>) {
    match n.kind() {
        "identifier" | "shorthand_property_identifier_pattern" => out.push(n),
        "assignment_pattern" | "object_assignment_pattern" => {
            if let Some(l) = n.child_by_field_name("left") {
                pattern_ids(l, out);
            }
        }
        "pair_pattern" => {
            if let Some(v) = n.child_by_field_name("value") {
                pattern_ids(v, out);
            }
        }
        "required_parameter" | "optional_parameter" => {
            if let Some(p) = n.child_by_field_name("pattern") {
                pattern_ids(p, out);
            }
        }
        "object_pattern" | "array_pattern" | "rest_pattern" => {
            for c in named(Some(n)) {
                pattern_ids(c, out);
            }
        }
        _ => {}
    }
}

/// Names declared under `n` without entering a function or class: only `var` ones, or with
/// `all` every declaration (lexical ones, catch parameters, function and class names).
fn declared<'t>(n: Node<'t>, all: bool, out: &mut Vec<Node<'t>>) {
    for c in named(Some(n)) {
        let kind = c.kind();
        if FUNCS.contains(&kind) {
            if all && kind.ends_with("_declaration") {
                out.extend(c.child_by_field_name("name"));
            }
            continue;
        }
        match kind {
            "variable_declarator" if all || n.kind() == "variable_declaration" => {
                if let Some(name) = c.child_by_field_name("name") {
                    pattern_ids(name, out);
                }
            }
            "for_in_statement" => {
                let decl = c.child_by_field_name("kind");
                if decl.is_some_and(|k| all || k.kind() == "var") {
                    if let Some(left) = c.child_by_field_name("left") {
                        pattern_ids(left, out);
                    }
                }
            }
            "catch_clause" if all => {
                if let Some(p) = c.child_by_field_name("parameter") {
                    pattern_ids(p, out);
                }
            }
            _ => {}
        }
        declared(c, all, out);
    }
}

/// The names a capture site's function declares itself: its name, parameters and locals.
/// ponytail: a capture site's locals are function-wide, not block-scoped; a same-named `let`
/// in one inner block hides the outer binding in the whole site. Scope per block if it bites.
fn own_names(f: Node, src: &str) -> Vec<String> {
    let mut ids = Vec::new();
    if let Some(name) = f.child_by_field_name("name") {
        pattern_ids(name, &mut ids);
    }
    if let Some(p) = f.child_by_field_name("parameter") {
        pattern_ids(p, &mut ids);
    }
    for p in named(f.child_by_field_name("parameters")) {
        pattern_ids(p, &mut ids);
    }
    if let Some(body) = f.child_by_field_name("body") {
        declared(body, true, &mut ids);
    }
    ids.iter()
        .map(|id| src[id.byte_range()].to_owned())
        .collect()
}

/// The `let`/`const` names (bindings) and function/class names (shadowing non-bindings)
/// declared directly among `stmts`.
fn lexical<'t>(stmts: &[Node<'t>]) -> Vec<(Node<'t>, bool)> {
    let mut out = Vec::new();
    for &s in stmts {
        if s.kind() == "lexical_declaration" {
            let mut ids = Vec::new();
            for d in named(Some(s)) {
                if let Some(name) = d.child_by_field_name("name") {
                    pattern_ids(name, &mut ids);
                }
            }
            out.extend(ids.into_iter().map(|id| (id, true)));
        } else if FUNCS.contains(&s.kind()) {
            out.extend(s.child_by_field_name("name").map(|id| (id, false)));
        }
    }
    out
}

fn first_leaf(mut n: Node) -> Node {
    while let Some(c) = n.child(0) {
        n = c;
    }
    n
}

const LOOPS: &[&str] = &[
    "for_statement",
    "for_in_statement",
    "while_statement",
    "do_statement",
    "switch_statement",
];

/// A loop, `switch` or labelled block that `break` / `continue` can target.
struct Jump {
    label: Option<String>,
    is_loop: bool,
    /// A labelled plain block: only `break label` targets it.
    is_block: bool,
    breaks: Vec<usize>,
    continues: Vec<usize>,
}

impl Jump {
    fn new(label: Option<String>, is_loop: bool, is_block: bool) -> Self {
        Jump {
            label,
            is_loop,
            is_block,
            breaks: Vec::new(),
            continues: Vec::new(),
        }
    }
}

struct Lowerer<'s> {
    src: &'s str,
    starts: Vec<usize>,
    f: FlowFunction,
    /// Blocks flowing into the next statement.
    preds: Vec<usize>,
    /// The block the next statement may append to, when `preds` is exactly it.
    open: Option<usize>,
    /// `None` shadows an outer binding with a non-binding (a function or class name).
    scopes: Vec<Vec<(String, Option<usize>)>>,
    /// Identifier start byte → its event (a capture's for references inside a site).
    hits: HashMap<usize, usize>,
    /// (outermost capture site start byte, binding) → capture event.
    captures: HashMap<(usize, usize), usize>,
    jumps: Vec<Jump>,
    pending_label: Option<String>,
    /// Per enclosing `try … finally`: the `return` / `throw` blocks that enter its `finally`.
    finally: Vec<Vec<usize>>,
}

impl<'s> Lowerer<'s> {
    fn run(
        def: Node,
        qualified_name: String,
        src: &'s str,
    ) -> (FlowFunction, HashMap<usize, usize>) {
        let func = match def.kind() {
            "variable_declarator" => def.child_by_field_name("value").unwrap_or(def),
            _ => def,
        };
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
            scopes: Vec::new(),
            hits: HashMap::new(),
            captures: HashMap::new(),
            jumps: Vec::new(),
            pending_label: None,
            finally: Vec::new(),
        };
        let params = match func.child_by_field_name("parameter") {
            Some(p) => vec![p],
            None => named(func.child_by_field_name("parameters")),
        };
        let body = func.child_by_field_name("body");
        // The function scope: parameters and hoisted `var`s.
        let mut ids = Vec::new();
        for &p in &params {
            pattern_ids(p, &mut ids);
        }
        if let Some(b) = body {
            declared(b, false, &mut ids);
        }
        l.enter(ids.into_iter().map(|id| (id, true)).collect());
        for p in params {
            if let Some(v) = p.child_by_field_name("value") {
                l.expr(v);
            }
            l.pattern(p.child_by_field_name("pattern").unwrap_or(p));
        }
        l.open = None;
        match body {
            Some(b) if b.kind() == "statement_block" => l.stmt(b),
            // A concise arrow body returns its expression.
            Some(e) => {
                let b = l.touch_node(e);
                l.expr(e);
                l.exit_from(b);
                l.branch_from(Vec::new());
            }
            None => {}
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

    /// `return` / `throw`: to the innermost enclosing `finally`, else `Exit`.
    fn exit_from(&mut self, b: usize) {
        match self.finally.last_mut() {
            Some(f) => f.push(b),
            None => self.edge(b, EXIT),
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

    fn touch_row(&mut self, n: Node) -> usize {
        let row = n.start_position().row;
        self.touch(row, row)
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

    /// A new scope declaring `ids` (a binding each when `true`). A name already in the scope
    /// keeps its binding: a repeated `var`, or a `var` named like a parameter.
    fn enter(&mut self, ids: Vec<(Node, bool)>) {
        self.scopes.push(Vec::new());
        for (id, binding) in ids {
            let name = self.text(id);
            if self
                .scopes
                .last()
                .expect("a scope")
                .iter()
                .any(|(n, _)| n == name)
            {
                continue;
            }
            let b = binding.then(|| {
                self.f.bindings.push(Binding {
                    name: name.to_owned(),
                    decl: self.pos(id.start_byte()),
                });
                self.f.bindings.len() - 1
            });
            self.scopes
                .last_mut()
                .expect("a scope")
                .push((name.to_owned(), b));
        }
    }

    fn reference(&mut self, id: Node, role: Role) {
        if let Some(b) = self.lookup(self.text(id)) {
            let e = self.emit(id.start_byte(), id.end_byte(), b, role, false);
            self.hits.insert(id.start_byte(), e);
        }
    }

    /// Evaluate an expression: every identifier naming a binding is a use.
    fn expr(&mut self, n: Node) {
        let field = |f| n.child_by_field_name(f);
        match n.kind() {
            "identifier" | "shorthand_property_identifier" => self.reference(n, Role::Use),
            "assignment_expression" | "augmented_assignment_expression" => {
                if let Some(left) = field("left") {
                    let compound = n.kind() == "augmented_assignment_expression";
                    self.assign(left, field("right"), compound);
                }
            }
            "update_expression" => match field("argument") {
                Some(id) if id.kind() == "identifier" => {
                    self.reference(id, Role::Use);
                    self.reference(id, Role::Def);
                }
                Some(e) => self.expr(e),
                None => {}
            },
            k if FUNCS.contains(&k) => self.capture(n, n, &mut Vec::new()),
            k if TYPES.contains(&k) => {}
            _ => {
                for c in named(Some(n)) {
                    self.expr(c);
                }
            }
        }
    }

    /// `left = right` / `left op= right` (`??=`, `||=`, `&&=` included): a member target's
    /// uses, a compound target's use, the right side, then the defs.
    fn assign(&mut self, left: Node, right: Option<Node>, compound: bool) {
        let target = matches!(
            left.kind(),
            "identifier" | "object_pattern" | "array_pattern"
        );
        if compound && left.kind() == "identifier" {
            self.reference(left, Role::Use);
        } else if !target {
            self.expr(left);
        }
        if let Some(r) = right {
            self.expr(r);
        }
        if target {
            self.pattern(left);
        }
    }

    /// The defs of a binding pattern in order, each target's default read before its def.
    fn pattern(&mut self, n: Node) {
        match n.kind() {
            "identifier" | "shorthand_property_identifier_pattern" => self.reference(n, Role::Def),
            "assignment_pattern" | "object_assignment_pattern" => {
                if let Some(r) = n.child_by_field_name("right") {
                    self.expr(r);
                }
                if let Some(l) = n.child_by_field_name("left") {
                    self.pattern(l);
                }
            }
            "pair_pattern" => {
                if let Some(k) = n
                    .child_by_field_name("key")
                    .filter(|k| k.kind() == "computed_property_name")
                {
                    self.expr(k);
                }
                if let Some(v) = n.child_by_field_name("value") {
                    self.pattern(v);
                }
            }
            "object_pattern" | "array_pattern" | "rest_pattern" => {
                for c in named(Some(n)) {
                    self.pattern(c);
                }
            }
            // `[o.a, b] = …`: a member target is a use of its object.
            _ => self.expr(n),
        }
    }

    fn block(&mut self, ss: Vec<Node>) {
        self.enter(lexical(&ss));
        for s in ss {
            self.stmt(s);
        }
        self.scopes.pop();
    }

    fn stmt(&mut self, n: Node) {
        let field = |f| n.child_by_field_name(f);
        match n.kind() {
            "statement_block" => self.block(stmts(n)),
            "else_clause" => {
                for s in stmts(n) {
                    self.stmt(s);
                }
            }
            "lexical_declaration" | "variable_declaration" => {
                self.touch_node(n);
                for d in named(Some(n)) {
                    // `let x;` is not a def.
                    if let (Some(name), Some(value)) = (
                        d.child_by_field_name("name"),
                        d.child_by_field_name("value"),
                    ) {
                        self.expr(value);
                        self.pattern(name);
                    }
                }
            }
            "if_statement" => self.if_(n),
            "while_statement" => {
                let label = self.pending_label.take();
                let cond = field("condition");
                self.open = None;
                let header =
                    self.touch(n.start_position().row, cond.unwrap_or(n).end_position().row);
                if let Some(c) = cond {
                    self.expr(c);
                }
                self.loop_body(label, header, field("body"), None, true);
            }
            "do_statement" => self.do_(n),
            "for_statement" => self.for_(n),
            "for_in_statement" => self.for_in(n),
            "switch_statement" => self.switch(n),
            "try_statement" => self.try_(n),
            "labeled_statement" => {
                let label = field("label").map(|l| self.text(l).to_owned());
                let Some(body) = field("body") else {
                    return;
                };
                if LOOPS.contains(&body.kind()) {
                    self.pending_label = label;
                    self.stmt(body);
                    self.pending_label = None;
                } else {
                    self.jumps.push(Jump::new(label, false, true));
                    self.stmt(body);
                    let mut preds = std::mem::take(&mut self.preds);
                    preds.extend(self.jumps.pop().expect("pushed above").breaks);
                    self.branch_from(preds);
                }
            }
            "return_statement" | "throw_statement" => {
                let b = self.touch_node(n);
                self.expr(n);
                self.exit_from(b);
                self.branch_from(Vec::new());
            }
            "break_statement" | "continue_statement" => {
                let b = self.touch_node(n);
                let label = field("label").map(|l| self.text(l));
                let is_break = n.kind() == "break_statement";
                if let Some(j) = self.jumps.iter_mut().rev().find(|j| match label {
                    Some(l) => j.label.as_deref() == Some(l),
                    None => !j.is_block && (is_break || j.is_loop),
                }) {
                    if is_break {
                        j.breaks.push(b);
                    } else {
                        j.continues.push(b);
                    }
                }
                self.branch_from(Vec::new());
            }
            k if FUNCS.contains(&k) => {
                self.touch_node(n);
                self.capture(n, n, &mut Vec::new());
            }
            k if TYPES.contains(&k) => {}
            "empty_statement" | "comment" => {}
            // expression statements, `debugger`, local enums.
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

    /// The body of a loop whose `header` the back edge returns to, through `update`.
    fn loop_body(
        &mut self,
        label: Option<String>,
        header: usize,
        body: Option<Node>,
        update: Option<Node>,
        exits: bool,
    ) {
        self.jumps.push(Jump::new(label, true, false));
        self.branch_from(vec![header]);
        if let Some(body) = body {
            self.stmt(body);
        }
        let jump = self.jumps.pop().expect("pushed above");
        if !jump.continues.is_empty() {
            let mut preds = std::mem::take(&mut self.preds);
            preds.extend(jump.continues);
            self.branch_from(preds);
        }
        if let Some(u) = update {
            self.touch_node(u);
            self.expr(u);
        }
        for p in std::mem::take(&mut self.preds) {
            self.edge(p, header);
        }
        let mut after = jump.breaks;
        if exits {
            after.push(header);
        }
        self.branch_from(after);
    }

    /// `do body while (cond)`: the body's first block is the back edge's target.
    fn do_(&mut self, n: Node) {
        let label = self.pending_label.take();
        self.open = None;
        let head = self.touch_row(n);
        self.jumps.push(Jump::new(label, true, false));
        if let Some(body) = n.child_by_field_name("body") {
            self.stmt(body);
        }
        let jump = self.jumps.pop().expect("pushed above");
        let mut preds = std::mem::take(&mut self.preds);
        preds.extend(jump.continues);
        self.branch_from(preds);
        let cond = n.child_by_field_name("condition");
        let c = self.touch_node(cond.unwrap_or(n));
        if let Some(cond) = cond {
            self.expr(cond);
        }
        self.edge(c, head);
        let mut after = jump.breaks;
        after.push(c);
        self.branch_from(after);
    }

    /// `for (init; cond; update)`: init, header (the condition), body, update, back edge.
    fn for_(&mut self, n: Node) {
        let label = self.pending_label.take();
        let init = n.child_by_field_name("initializer");
        self.enter(lexical(&init.into_iter().collect::<Vec<_>>()));
        if let Some(init) = init {
            self.stmt(init);
        }
        let cond = n
            .child_by_field_name("condition")
            .filter(|c| c.kind() != "empty_statement");
        let update = n.child_by_field_name("increment");
        self.open = None;
        let end = update.or(cond).unwrap_or(n).start_position().row;
        let header = self.touch(n.start_position().row, end);
        if let Some(c) = cond {
            self.expr(c);
        }
        self.loop_body(
            label,
            header,
            n.child_by_field_name("body"),
            update,
            cond.is_some(),
        );
        self.scopes.pop();
    }

    /// `for (left of/in right)`: the iterable is read before the loop, the target is a def in
    /// the header.
    fn for_in(&mut self, n: Node) {
        let label = self.pending_label.take();
        let left = n.child_by_field_name("left");
        let lexical = n
            .child_by_field_name("kind")
            .is_some_and(|k| k.kind() != "var");
        let mut ids = Vec::new();
        if let (true, Some(l)) = (lexical, left) {
            pattern_ids(l, &mut ids);
        }
        self.enter(ids.into_iter().map(|id| (id, true)).collect());
        if let Some(r) = n.child_by_field_name("right") {
            self.touch_row(n);
            self.expr(r);
        }
        self.open = None;
        let header = self.touch_row(n);
        if let Some(l) = left {
            self.pattern(l);
        }
        self.loop_body(label, header, n.child_by_field_name("body"), None, true);
        self.scopes.pop();
    }

    /// One block per case, entered from the header (which reads the discriminant and every
    /// case test) and from the case before it when that one falls through.
    fn switch(&mut self, n: Node) {
        let label = self.pending_label.take();
        let value = n.child_by_field_name("value");
        let head = self.touch(
            n.start_position().row,
            value.unwrap_or(n).end_position().row,
        );
        if let Some(v) = value {
            self.expr(v);
        }
        let cases: Vec<Node> = named(n.child_by_field_name("body"))
            .into_iter()
            .filter(|c| matches!(c.kind(), "switch_case" | "switch_default"))
            .collect();
        for c in &cases {
            if let Some(test) = c.child_by_field_name("value") {
                self.expr(test);
            }
        }
        let all: Vec<Node> = cases.iter().flat_map(|&c| stmts(c)).collect();
        self.enter(lexical(&all));
        self.jumps.push(Jump::new(label, false, false));
        let (mut fall, mut default) = (Vec::new(), false);
        for c in cases {
            default |= c.kind() == "switch_default";
            let mut preds = vec![head];
            preds.append(&mut fall);
            self.branch_from(preds);
            self.touch_row(c);
            for s in stmts(c) {
                self.stmt(s);
            }
            fall = std::mem::take(&mut self.preds);
        }
        let mut after = fall;
        if !default {
            after.push(head);
        }
        after.extend(self.jumps.pop().expect("pushed above").breaks);
        self.branch_from(after);
        self.scopes.pop();
    }

    /// Conservative: the catch is entered from the block before the `try` and every block in
    /// it; `finally` from the ends of the try and catch and every `return` / `throw` in them,
    /// and leaves to `Exit` too when a jump entered it.
    /// ponytail: `break` / `continue` out of a `try` skip its `finally`.
    fn try_(&mut self, n: Node) {
        let handler = n.child_by_field_name("handler");
        let finalizer = n.child_by_field_name("finalizer");
        let before = self.preds.clone();
        if finalizer.is_some() {
            self.finally.push(Vec::new());
        }
        self.open = None;
        let first = self.f.blocks.len();
        if let Some(body) = n.child_by_field_name("body") {
            self.stmt(body);
        }
        let mut after = std::mem::take(&mut self.preds);
        if let Some(h) = handler {
            let mut preds = before;
            preds.extend(first..self.f.blocks.len());
            self.branch_from(preds);
            let param = h.child_by_field_name("parameter");
            let mut ids = Vec::new();
            if let Some(p) = param {
                pattern_ids(p, &mut ids);
            }
            self.enter(ids.into_iter().map(|id| (id, true)).collect());
            self.touch_row(h);
            if let Some(p) = param {
                self.pattern(p);
            }
            if let Some(body) = h.child_by_field_name("body") {
                self.stmt(body);
            }
            self.scopes.pop();
            after.append(&mut self.preds);
        }
        if let Some(f) = finalizer {
            let jumped = self.finally.pop().expect("pushed above");
            let normal = !after.is_empty();
            after.extend(jumped.iter().copied());
            self.branch_from(after);
            self.touch_row(f);
            if let Some(body) = f.child_by_field_name("body") {
                self.stmt(body);
            }
            let end = std::mem::take(&mut self.preds);
            if !jumped.is_empty() {
                for &b in &end {
                    self.exit_from(b);
                }
            }
            after = if normal { end } else { Vec::new() };
        }
        self.branch_from(after);
    }

    /// Inside a capture site: every reference to a traced-function binding is one capture use
    /// per (outermost site, binding) at the site's first token; nothing else is lowered.
    /// `local` holds the names each function or class inside the site declares, which shadow.
    fn capture(&mut self, site: Node, n: Node, local: &mut Vec<Vec<String>>) {
        let kind = n.kind();
        if matches!(kind, "identifier" | "shorthand_property_identifier") {
            let name = self.text(n);
            if local.iter().flatten().any(|l| l == name) {
                return;
            }
            if let Some(b) = self.lookup(name) {
                let key = (site.start_byte(), b);
                let e = match self.captures.get(&key) {
                    Some(&e) => e,
                    None => {
                        let t = first_leaf(site);
                        let e = self.emit(t.start_byte(), t.end_byte(), b, Role::Use, true);
                        self.captures.insert(key, e);
                        e
                    }
                };
                self.hits.insert(n.start_byte(), e);
            }
            return;
        }
        if TYPES.contains(&kind) {
            return;
        }
        let scoped = FUNCS.contains(&kind);
        if scoped {
            local.push(own_names(n, self.src));
        }
        for c in named(Some(n)) {
            self.capture(site, c, local);
        }
        if scoped {
            local.pop();
        }
    }
}
