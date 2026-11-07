//! Data flow: lower one Python function or method into `ir::flow`'s blocks, bindings and
//! def/use events, around a source position or by qualified name and variable key.

use std::collections::HashMap;

use ir::flow::variable_key;
use ir::{
    Binding, BlockKind, FlowBlock, FlowError, FlowEvent, FlowFunction, LineRange, Locate, Lowered,
    Picked, Pos, Role,
};
use tree_sitter::{Node, Parser};

/// Branch target placeholder for `Exit`, which is only appended (last) at the end.
const EXIT: usize = usize::MAX;

/// Capture sites (R10): a reference inside one is a single capture use at its first token,
/// and nothing inside it is lowered.
const SITES: &[&str] = &[
    "function_definition",
    "class_definition",
    "decorated_definition",
    "lambda",
    "list_comprehension",
    "set_comprehension",
    "dictionary_comprehension",
    "generator_expression",
];

pub(crate) fn lower(source: &str, at: Locate) -> Result<Lowered, FlowError> {
    let mut parser = Parser::new();
    parser
        .set_language(&tree_sitter_python::LANGUAGE.into())
        .expect("tree-sitter-python is ABI compatible");
    let tree = parser.parse(source, None).expect("parser has a language");
    let root = tree.root_node();
    match at {
        Locate::At(pos) => {
            let off = byte_at(source, pos).ok_or(FlowError::NoIdentifier)?;
            let tok = token_at(root, off, source).ok_or(FlowError::NoIdentifier)?;
            let name = source[tok.byte_range()].to_owned();
            // A nested `def`'s own name belongs to the function around it.
            let func = std::iter::successors(tok.parent(), |n| n.parent())
                .find(|n| {
                    n.kind() == "function_definition" && n.child_by_field_name("name") != Some(tok)
                })
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
            let mut funcs = Vec::new();
            functions(root, &mut funcs);
            let func = funcs
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

/// Every `function_definition`, in source order.
fn functions<'t>(n: Node<'t>, out: &mut Vec<Node<'t>>) {
    if n.kind() == "function_definition" {
        out.push(n);
    }
    for c in named(Some(n)) {
        functions(c, out);
    }
}

/// Same rule as `extract`: enclosing class/function names and its own, joined by `.`.
fn qualified_name_of(func: Node, source: &str) -> String {
    let mut names: Vec<&str> = std::iter::successors(Some(func), |n| n.parent())
        .filter(|n| matches!(n.kind(), "function_definition" | "class_definition"))
        .filter_map(|n| n.child_by_field_name("name"))
        .map(|n| &source[n.byte_range()])
        .collect();
    names.reverse();
    names.join(".")
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
        return (word && n.kind() != "string_content").then_some(n);
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

/// A clause's statements: its `body`, else its unnamed `block` (`except` / `finally`).
fn suite(n: Node) -> Option<Node> {
    n.child_by_field_name("body")
        .or_else(|| named(Some(n)).into_iter().find(|c| c.kind() == "block"))
}

/// The identifiers a parameter declares (defaults and annotations excluded).
fn param_ids(p: Node) -> Vec<Node> {
    match p.kind() {
        "identifier" => vec![p],
        "default_parameter" | "typed_default_parameter" => {
            p.child_by_field_name("name").into_iter().collect()
        }
        "typed_parameter" | "list_splat_pattern" | "dictionary_splat_pattern" => named(Some(p))
            .into_iter()
            .filter(|c| c.kind() != "type")
            .flat_map(param_ids)
            .collect(),
        _ => Vec::new(),
    }
}

/// The names an `import` binds: the alias, else the first dotted part.
fn imported(n: Node) -> Vec<Node> {
    let mut c = n.walk();
    let ids = n
        .children_by_field_name("name", &mut c)
        .filter_map(|name| match name.kind() {
            "aliased_import" => name.child_by_field_name("alias"),
            _ => name.named_child(0),
        })
        .collect();
    ids
}

/// The identifiers an assignment-like target binds; `x.f` / `x[i]` bind nothing.
fn targets<'t>(n: Node<'t>, ids: &mut Vec<Node<'t>>) {
    match n.kind() {
        "identifier" => ids.push(n),
        "attribute" | "subscript" => {}
        _ => {
            for c in named(Some(n)) {
                targets(c, ids);
            }
        }
    }
}

/// The capture names of a `match` pattern. A one-part dotted name is a capture; class names,
/// keyword names and dict keys are not.
fn case_ids<'t>(n: Node<'t>, ids: &mut Vec<Node<'t>>) {
    match n.kind() {
        "identifier" => ids.push(n),
        "dotted_name" => {
            if n.named_child_count() == 1 {
                ids.extend(n.named_child(0));
            }
        }
        k => {
            let skip_first = matches!(k, "class_pattern" | "keyword_pattern");
            for (i, (field, c)) in fields(n).into_iter().enumerate() {
                if !(skip_first && i == 0) && field != Some("key") {
                    case_ids(c, ids);
                }
            }
        }
    }
}

fn is_target(kind: &str, field: Option<&str>) -> bool {
    matches!(
        (kind, field),
        (
            "assignment" | "augmented_assignment" | "for_statement" | "for_in_clause",
            Some("left")
        ) | ("named_expression", Some("name"))
            | ("as_pattern", Some("alias"))
    )
}

/// Binding occurrences anywhere under `n` outside nested scopes, and `global` / `nonlocal`
/// names.
fn binds<'t>(n: Node<'t>, ids: &mut Vec<Node<'t>>, outer: &mut Vec<Node<'t>>) {
    match n.kind() {
        // ponytail: a walrus inside a comprehension binds in the function but is skipped
        // with its site; walk comprehensions for `named_expression` if that matters.
        k if SITES.contains(&k) => {}
        "global_statement" | "nonlocal_statement" => outer.extend(named(Some(n))),
        "import_statement" | "import_from_statement" => ids.extend(imported(n)),
        "case_pattern" => case_ids(n, ids),
        // `x: int` binds nothing.
        "assignment" if n.child_by_field_name("right").is_none() => {}
        k => {
            for (field, c) in fields(n) {
                if is_target(k, field) {
                    targets(c, ids);
                } else {
                    binds(c, ids, outer);
                }
            }
        }
    }
}

/// A scope's own names (R3) as identifier nodes in source order: parameters, binding targets
/// outside nested scopes, minus `global` / `nonlocal` names. Repeats are kept.
fn bound<'t>(scope: Node<'t>, src: &str) -> Vec<Node<'t>> {
    let (mut ids, mut outer) = (Vec::new(), Vec::new());
    match scope.kind() {
        "function_definition" | "lambda" | "class_definition" => {
            for p in named(scope.child_by_field_name("parameters")) {
                ids.extend(param_ids(p));
            }
            if let Some(body) = scope.child_by_field_name("body") {
                binds(body, &mut ids, &mut outer);
            }
        }
        // Comprehensions: the `for` targets.
        _ => {
            for c in named(Some(scope)) {
                if c.kind() == "for_in_clause" {
                    if let Some(left) = c.child_by_field_name("left") {
                        targets(left, &mut ids);
                    }
                }
            }
        }
    }
    let text = |n: &Node| &src[n.byte_range()];
    ids.retain(|id| !outer.iter().any(|o| text(o) == text(id)));
    ids.sort_by_key(|id| id.start_byte());
    ids
}

#[derive(Default)]
struct Loop {
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
    /// One binding per local name (Python has function scope).
    locals: HashMap<&'s str, usize>,
    /// Identifier start byte → its event (a capture's for references inside a site).
    hits: HashMap<usize, usize>,
    /// (capture site start byte, binding) → capture event.
    captures: HashMap<(usize, usize), usize>,
    loops: Vec<Loop>,
}

impl<'s> Lowerer<'s> {
    fn run(func: Node, src: &'s str) -> (FlowFunction, HashMap<usize, usize>) {
        let mut l = Lowerer {
            src,
            starts: line_starts(src),
            f: FlowFunction {
                qualified_name: qualified_name_of(func, src),
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
            locals: HashMap::new(),
            hits: HashMap::new(),
            captures: HashMap::new(),
            loops: Vec::new(),
        };
        for id in bound(func, src) {
            let name = l.text(id);
            if !l.locals.contains_key(name) {
                l.f.bindings.push(Binding {
                    name: name.to_owned(),
                    decl: l.pos(id.start_byte()),
                });
                l.locals.insert(name, l.f.bindings.len() - 1);
            }
        }
        for p in named(func.child_by_field_name("parameters")) {
            for id in param_ids(p) {
                l.reference(id, Role::Def);
            }
        }
        l.open = None;
        l.block(func.child_by_field_name("body"));
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

    /// A clause header: from `n`'s first row to the end of `last` (or `n`'s first row).
    fn touch_head(&mut self, n: Node, last: Option<Node>) -> usize {
        let row = n.start_position().row;
        self.touch(row, last.map_or(row, |l| l.end_position().row))
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

    /// An identifier naming a local: its event. An augmented target's def, emitted after
    /// its use, wins the hit.
    fn reference(&mut self, id: Node, role: Role) {
        if let Some(&b) = self.locals.get(self.text(id)) {
            let e = self.emit(id.start_byte(), id.end_byte(), b, role, false);
            self.hits.insert(id.start_byte(), e);
        }
    }

    fn block(&mut self, n: Option<Node>) {
        for s in named(n) {
            self.stmt(s);
        }
    }

    fn expr_field(&mut self, n: Node, field: &str) {
        if let Some(c) = n.child_by_field_name(field) {
            self.expr(c);
        }
    }

    /// Evaluate an expression: every identifier naming a local is a use; assignment-like
    /// nodes lower their right side before their targets' defs.
    fn expr(&mut self, n: Node) {
        let field = |f| n.child_by_field_name(f);
        match n.kind() {
            "identifier" => self.reference(n, Role::Use),
            k if SITES.contains(&k) => self.capture(n, n, &mut Vec::new()),
            "attribute" => self.expr_field(n, "object"),
            "keyword_argument" => self.expr_field(n, "value"),
            "assignment" => {
                // `x: int` evaluates nothing.
                if let Some(r) = field("right") {
                    self.expr(r);
                    if let Some(l) = field("left") {
                        self.target(l);
                    }
                }
            }
            "augmented_assignment" => {
                self.expr_field(n, "right");
                match field("left") {
                    Some(l) if l.kind() == "identifier" => {
                        self.reference(l, Role::Use);
                        self.reference(l, Role::Def);
                    }
                    Some(l) => self.expr(l),
                    None => {}
                }
            }
            "named_expression" => {
                self.expr_field(n, "value");
                if let Some(id) = field("name") {
                    self.reference(id, Role::Def);
                }
            }
            "as_pattern" => {
                for (f, c) in fields(n) {
                    if f != Some("alias") {
                        self.expr(c);
                    }
                }
                if let Some(a) = field("alias") {
                    self.target(a);
                }
            }
            _ => {
                for (f, c) in fields(n) {
                    if f != Some("type") {
                        self.expr(c);
                    }
                }
            }
        }
    }

    /// An assignment target: names are defs; `x.f` / `x[i]` are uses of `x` (and `i`).
    fn target(&mut self, n: Node) {
        match n.kind() {
            "identifier" => self.reference(n, Role::Def),
            "attribute" | "subscript" => self.expr(n),
            _ => {
                for c in named(Some(n)) {
                    self.target(c);
                }
            }
        }
    }

    fn stmt(&mut self, n: Node) {
        match n.kind() {
            "if_statement" => self.if_(n),
            "while_statement" | "for_statement" => self.loop_(n),
            "try_statement" => self.try_(n),
            "match_statement" => self.match_(n),
            "with_statement" => {
                let clause = named(Some(n))
                    .into_iter()
                    .find(|c| c.kind() == "with_clause");
                self.touch_head(n, clause);
                if let Some(c) = clause {
                    self.expr(c);
                }
                self.block(n.child_by_field_name("body"));
            }
            "return_statement" | "raise_statement" => {
                let b = self.touch_node(n);
                self.expr(n);
                self.edge(b, EXIT);
                self.branch_from(Vec::new());
            }
            "break_statement" | "continue_statement" => {
                let b = self.touch_node(n);
                if let Some(lp) = self.loops.last_mut() {
                    if n.kind() == "break_statement" {
                        lp.breaks.push(b);
                    } else {
                        lp.continues.push(b);
                    }
                }
                self.branch_from(Vec::new());
            }
            "import_statement" | "import_from_statement" => {
                self.touch_node(n);
                for id in imported(n) {
                    self.reference(id, Role::Def);
                }
            }
            "comment" | "future_import_statement" => {}
            // expression statements, `pass`, `del` (ponytail: a use, not a kill — `ir::flow`
            // has no kill role), `assert`, `global`, nested `def` / `class`.
            _ => {
                self.touch_node(n);
                self.expr(n);
            }
        }
    }

    fn if_(&mut self, n: Node) {
        let cond = n.child_by_field_name("condition");
        let mut c = self.touch_head(n, cond);
        if let Some(cond) = cond {
            self.expr(cond);
        }
        self.branch_from(vec![c]);
        self.block(n.child_by_field_name("consequence"));
        let mut after = std::mem::take(&mut self.preds);
        let mut has_else = false;
        let mut cur = n.walk();
        let alts: Vec<Node> = n.children_by_field_name("alternative", &mut cur).collect();
        for alt in alts {
            self.branch_from(vec![c]);
            if alt.kind() == "elif_clause" {
                let cond = alt.child_by_field_name("condition");
                c = self.touch_head(alt, cond);
                if let Some(cond) = cond {
                    self.expr(cond);
                }
                self.branch_from(vec![c]);
                self.block(alt.child_by_field_name("consequence"));
            } else {
                has_else = true;
                self.block(suite(alt));
            }
            after.append(&mut self.preds);
        }
        if !has_else {
            after.push(c);
        }
        self.branch_from(after);
    }

    /// `while` / `for`: a header block, a back edge, and an `else` on normal exit that
    /// `break` skips.
    fn loop_(&mut self, n: Node) {
        let is_for = n.kind() == "for_statement";
        self.open = None;
        let head = n.child_by_field_name(if is_for { "right" } else { "condition" });
        let header = self.touch_head(n, head);
        if let Some(h) = head {
            self.expr(h);
        }
        if is_for {
            if let Some(left) = n.child_by_field_name("left") {
                self.target(left);
            }
        }
        self.loops.push(Loop::default());
        self.branch_from(vec![header]);
        self.block(n.child_by_field_name("body"));
        let lp = self.loops.pop().expect("pushed above");
        let ends: Vec<usize> = std::mem::take(&mut self.preds)
            .into_iter()
            .chain(lp.continues)
            .collect();
        for p in ends {
            self.edge(p, header);
        }
        self.branch_from(vec![header]);
        if let Some(alt) = n.child_by_field_name("alternative") {
            self.block(suite(alt));
        }
        let mut after = std::mem::take(&mut self.preds);
        after.extend(lp.breaks);
        self.branch_from(after);
    }

    /// Conservative `try`: every handler is entered from the point before the body and from
    /// each body block's end; `else` follows the body; `finally` follows the body/`else` and
    /// each handler.
    /// ponytail: a `return` / `break` / `continue` / `raise` inside goes straight to its
    /// target, skipping `finally`; route jumps through `finally` if traces need it.
    fn try_(&mut self, n: Node) {
        let before = std::mem::take(&mut self.preds);
        self.branch_from(before.clone());
        let first = self.f.blocks.len();
        self.block(n.child_by_field_name("body"));
        let body_blocks = first..self.f.blocks.len();
        let mut normal = std::mem::take(&mut self.preds);
        let mut handlers = Vec::new();
        let mut finally = None;
        for clause in named(Some(n)) {
            match clause.kind() {
                "except_clause" | "except_group_clause" => {
                    let mut preds = before.clone();
                    preds.extend(body_blocks.clone());
                    self.branch_from(preds);
                    let value = clause.child_by_field_name("value");
                    self.touch_head(clause, value);
                    if let Some(v) = value {
                        self.expr(v);
                    }
                    self.block(suite(clause));
                    handlers.append(&mut self.preds);
                }
                "else_clause" => {
                    self.branch_from(normal);
                    self.block(suite(clause));
                    normal = std::mem::take(&mut self.preds);
                }
                "finally_clause" => finally = Some(clause),
                _ => {}
            }
        }
        normal.append(&mut handlers);
        self.branch_from(normal);
        if let Some(f) = finally {
            self.block(suite(f));
        }
    }

    /// `match`: every case is entered from the subject block, plus a fall-out edge unless the
    /// last case is `case _:`. Pattern captures are defs at the start of their case.
    /// ponytail: value / class names in patterns (`Color.RED`, `Point(...)`) are not uses.
    fn match_(&mut self, n: Node) {
        let mut cur = n.walk();
        let subjects: Vec<Node> = n.children_by_field_name("subject", &mut cur).collect();
        let c = self.touch_head(n, subjects.last().copied());
        for s in subjects {
            self.expr(s);
        }
        let mut after = Vec::new();
        let mut irrefutable = false;
        for clause in named(n.child_by_field_name("body")) {
            if clause.kind() != "case_clause" {
                continue;
            }
            self.branch_from(vec![c]);
            let pats: Vec<Node> = named(Some(clause))
                .into_iter()
                .filter(|p| p.kind() == "case_pattern")
                .collect();
            let guard = clause.child_by_field_name("guard");
            self.touch_head(clause, guard.or(pats.last().copied()));
            let mut ids = Vec::new();
            for &p in &pats {
                case_ids(p, &mut ids);
            }
            for id in ids {
                self.reference(id, Role::Def);
            }
            if let Some(g) = guard {
                self.expr(g);
            }
            self.block(clause.child_by_field_name("consequence"));
            after.append(&mut self.preds);
            irrefutable = guard.is_none() && pats.len() == 1 && self.text(pats[0]) == "_";
        }
        if !irrefutable {
            after.push(c);
        }
        self.branch_from(after);
    }

    /// Inside a capture site: every reference to a traced-function local is one capture use
    /// per (site, binding) at the site's first token; nothing else is lowered. `shadow` holds
    /// the names of the nested scopes entered, which hide the function's.
    fn capture(&mut self, site: Node, n: Node, shadow: &mut Vec<Vec<&'s str>>) {
        let kind = n.kind();
        if kind == "identifier" {
            let name = self.text(n);
            if shadow.iter().any(|s| s.contains(&name)) {
                return;
            }
            if let Some(&b) = self.locals.get(name) {
                let key = (site.start_byte(), b);
                let e = match self.captures.get(&key) {
                    Some(&e) => e,
                    None => {
                        let mut first = site;
                        while let Some(c) = first.child(0) {
                            first = c;
                        }
                        let e = self.emit(first.start_byte(), first.end_byte(), b, Role::Use, true);
                        self.captures.insert(key, e);
                        e
                    }
                };
                self.hits.insert(n.start_byte(), e);
            }
            return;
        }
        // ponytail: a nested scope's names hide the function's across the whole node, so the
        // outer `x` in `[x for x in x]` or `def g(x=x)` is missed; scope those parts out if
        // it matters.
        let scoped = SITES.contains(&kind) && kind != "decorated_definition";
        if scoped {
            let names = bound(n, self.src).iter().map(|id| self.text(*id)).collect();
            shadow.push(names);
        }
        for (field, c) in fields(n) {
            let skip = matches!(
                (kind, field),
                ("attribute", Some("attribute"))
                    | ("keyword_argument", Some("name"))
                    | ("function_definition" | "class_definition", Some("name"))
            );
            if !skip {
                self.capture(site, c, shadow);
            }
        }
        if scoped {
            shadow.pop();
        }
    }
}
