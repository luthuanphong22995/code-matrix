//! Phase 2: bind imports, calls and type references across all Java files by declared
//! package, imports and the supertype chain. No filesystem: def names already carry the
//! declared package.

use std::collections::{HashMap, HashSet};

use ir::{DefKind, Edge, EdgeKind, FileSymbols, NodeId, NodeKind, RawRef, RefKind, SymbolTable};

/// A class def: `(file index, def index)`.
type Class = (usize, usize);

/// Names an import brings into one file.
#[derive(Default)]
struct Scope<'a> {
    package: Option<&'a str>,
    /// Simple name → class, from `import a.b.C`.
    single: HashMap<&'a str, Class>,
    /// Packages of `import a.b.*`.
    wildcards: Vec<&'a str>,
    /// `(member or "*", class)`, from `import static a.b.C.m` / `a.b.C.*`.
    statics: Vec<(&'a str, Class)>,
}

struct Resolver<'a> {
    files: &'a [FileSymbols],
    table: &'a SymbolTable,
    /// Class FQN → class; first in input file order wins.
    types: HashMap<&'a str, Class>,
    scopes: Vec<Scope<'a>>,
    supertypes: HashMap<Class, Vec<Class>>,
}

/// The class an import names (`None` for a package wildcard or an unbound name) and, for a
/// static import, the member it binds (`*` for all).
fn imported<'s>(
    specifier: &'s str,
    types: &HashMap<&str, Class>,
) -> (Option<Class>, Option<&'s str>) {
    let (is_static, name) = match specifier.strip_prefix("static ") {
        Some(name) => (true, name),
        None => (false, specifier),
    };
    let (class, member) = match (is_static, name.rsplit_once('.')) {
        (true, Some((class, member))) => (class, Some(member)),
        (false, Some((_, "*"))) => return (None, None),
        _ => (name, None),
    };
    (types.get(class).copied(), member)
}

impl<'a> Resolver<'a> {
    fn new(files: &'a [FileSymbols], table: &'a SymbolTable) -> Self {
        let mut types = HashMap::new();
        for (f, file) in files.iter().enumerate() {
            for (d, def) in file.defs.iter().enumerate() {
                if def.kind == DefKind::Class {
                    types.entry(def.qualified_name.as_str()).or_insert((f, d));
                }
            }
        }
        let scopes = files
            .iter()
            .map(|file| {
                let mut scope = Scope {
                    // Package = FQN of a top-level type minus its simple name.
                    package: file
                        .defs
                        .iter()
                        .find(|def| def.kind == DefKind::Class && def.parent.is_none())
                        .and_then(|def| def.qualified_name.rsplit_once('.'))
                        .map(|(package, _)| package),
                    ..Scope::default()
                };
                for import in &file.imports {
                    let spec = import.specifier.as_str();
                    match imported(spec, &types) {
                        (Some(class), Some(member)) => scope.statics.push((member, class)),
                        (Some(class), None) => {
                            let simple = spec.rsplit('.').next().unwrap_or(spec);
                            scope.single.insert(simple, class);
                        }
                        (None, _) => {
                            if let Some(package) = spec
                                .strip_suffix(".*")
                                .filter(|_| !spec.starts_with("static "))
                            {
                                scope.wildcards.push(package);
                            }
                        }
                    }
                }
                scope
            })
            .collect();
        let mut resolver = Self {
            files,
            table,
            types,
            scopes,
            supertypes: HashMap::new(),
        };

        // ponytail: a class's supertypes are all its own `References` refs that bind to a
        // workspace class (extends, implements, then field types), since `RawRef` has no
        // "extends" marker. A field type can mis-bind an unqualified call only where the call
        // would not compile otherwise; upgrade path = a supertype list on `ir::Def`.
        let mut supertypes: HashMap<Class, Vec<Class>> = HashMap::new();
        for (f, file) in files.iter().enumerate() {
            for raw in &file.refs {
                let Some(d) = raw.from.filter(|&d| {
                    raw.kind == RefKind::References
                        && file
                            .defs
                            .get(d)
                            .is_some_and(|def| def.kind == DefKind::Class)
                }) else {
                    continue;
                };
                if let Some(class) = resolver.bind_type(f, raw.from, &raw.target) {
                    if class != (f, d) {
                        supertypes.entry((f, d)).or_default().push(class);
                    }
                }
            }
        }
        resolver.supertypes = supertypes;
        resolver
    }

    fn class_id(&self, (f, d): Class) -> NodeId {
        self.files[f].defs[d].id(&self.files[f].path)
    }

    fn qualified_name(&self, (f, d): Class) -> &'a str {
        &self.files[f].defs[d].qualified_name
    }

    /// The class `from` is in, then its outer classes, innermost first.
    fn enclosing_classes(&self, f: usize, from: Option<usize>) -> Vec<Class> {
        let defs = &self.files[f].defs;
        std::iter::successors(from.filter(|&d| d < defs.len()), |&d| {
            defs[d].parent.filter(|&p| p < d)
        })
        .filter(|&d| defs[d].kind == DefKind::Class)
        .map(|d| (f, d))
        .collect()
    }

    /// A type name as written: nested types of the enclosing classes, single-type import,
    /// same package, wildcard-imported packages. A qualified name binds only by FQN.
    fn bind_type(&self, f: usize, from: Option<usize>, name: &str) -> Option<Class> {
        if name.contains('.') {
            return self.types.get(name).copied();
        }
        let lookup = |fqn: String| self.types.get(fqn.as_str()).copied();
        let scope = &self.scopes[f];
        self.enclosing_classes(f, from)
            .into_iter()
            .find_map(|class| lookup(format!("{}.{name}", self.qualified_name(class))))
            .or_else(|| scope.single.get(name).copied())
            .or_else(|| match scope.package {
                Some(package) => lookup(format!("{package}.{name}")),
                None => lookup(name.to_owned()),
            })
            .or_else(|| {
                scope
                    .wildcards
                    .iter()
                    .find_map(|package| lookup(format!("{package}.{name}")))
            })
    }

    /// Method `m` of `class` or, depth-first in emission order, of its supertypes.
    fn method(&self, class: Class, m: &str, seen: &mut HashSet<Class>) -> Option<NodeId> {
        if !seen.insert(class) {
            return None;
        }
        let qualified_name = format!("{}.{m}", self.qualified_name(class));
        let id = NodeId::new(
            NodeKind::Function,
            &self.files[class.0].path,
            &qualified_name,
        );
        if self.table.lookup("java", &qualified_name).contains(&id) {
            return Some(id);
        }
        self.supertypes
            .get(&class)
            .into_iter()
            .flatten()
            .find_map(|&parent| self.method(parent, m, seen))
    }

    /// The bound def, or the placeholder name when unbound.
    fn bind_call<'r>(&self, f: usize, raw: &'r RawRef) -> Result<NodeId, &'r str> {
        if let Some(ty) = raw.target.strip_prefix("new ") {
            return self
                .bind_type(f, raw.from, ty)
                .map(|class| self.class_id(class))
                .ok_or(ty);
        }
        let (receiver, m) = match raw.target.rsplit_once('.') {
            Some((receiver, m)) => (Some(receiver), m),
            None => (None, raw.target.as_str()),
        };
        let found = match receiver {
            None | Some("this" | "super") => {
                let mut seen = HashSet::new();
                self.enclosing_classes(f, raw.from)
                    .into_iter()
                    .find_map(|class| self.method(class, m, &mut seen))
                    .or_else(|| {
                        self.scopes[f]
                            .statics
                            .iter()
                            .filter(|(member, _)| *member == m || *member == "*")
                            .find_map(|&(_, class)| self.method(class, m, &mut HashSet::new()))
                    })
            }
            // No receiver typing in v1: only a receiver that names a type binds.
            Some(receiver) => self
                .bind_type(f, raw.from, receiver)
                .and_then(|class| self.method(class, m, &mut HashSet::new())),
        };
        found.ok_or(m)
    }
}

pub fn resolve(files: &[FileSymbols], table: &SymbolTable) -> Vec<Edge> {
    let resolver = Resolver::new(files, table);
    let mut edges = Vec::new();
    // Exactly one edge per raw import and per raw ref: every branch pushes.
    for (f, file) in files.iter().enumerate() {
        for import in &file.imports {
            let spec = import.specifier.as_str();
            edges.push(match imported(spec, &resolver.types).0 {
                Some((target, _)) => {
                    Edge::resolved(EdgeKind::Imports, file.file_id(), files[target].file_id())
                }
                None => Edge::unresolved(
                    EdgeKind::Imports,
                    file.file_id(),
                    spec.strip_prefix("static ").unwrap_or(spec),
                ),
            });
        }
        for raw in &file.refs {
            let (kind, bound) = match raw.kind {
                RefKind::Calls => (EdgeKind::Calls, resolver.bind_call(f, raw)),
                RefKind::References => (
                    EdgeKind::References,
                    resolver
                        .bind_type(f, raw.from, &raw.target)
                        .map(|class| resolver.class_id(class))
                        .ok_or(raw.target.as_str()),
                ),
            };
            let from = file.ref_source(raw);
            edges.push(match bound {
                Ok(to) => Edge::resolved(kind, from, to),
                Err(name) => Edge::unresolved(kind, from, name),
            });
        }
    }
    edges
}
