//! Per-file extraction output and the cross-file symbol table built from it.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::{LineRange, NodeId, NodeKind};

/// What `Frontend::extract` found in one file, before any cross-file binding.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileSymbols {
    pub language: String,
    /// Workspace-relative path; the file node is `NodeId::file(path)`.
    pub path: String,
    pub defs: Vec<Def>,
    pub imports: Vec<RawImport>,
    pub refs: Vec<RawRef>,
}

impl FileSymbols {
    pub fn file_id(&self) -> NodeId {
        NodeId::file(&self.path)
    }

    /// Node id of `defs[index]`.
    pub fn def_id(&self, index: usize) -> Option<NodeId> {
        self.defs.get(index).map(|def| def.id(&self.path))
    }

    /// Node id a ref originates from: its def, or the file for top-level code.
    pub fn ref_source(&self, r: &RawRef) -> NodeId {
        r.from
            .and_then(|index| self.def_id(index))
            .unwrap_or_else(|| self.file_id())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DefKind {
    Class,
    Function,
}

impl From<DefKind> for NodeKind {
    fn from(kind: DefKind) -> Self {
        match kind {
            DefKind::Class => Self::Class,
            DefKind::Function => Self::Function,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Def {
    pub kind: DefKind,
    pub qualified_name: String,
    /// Index of the enclosing def in `FileSymbols::defs`; `None` means the file. Must point
    /// at an earlier def — anything else is treated as the file.
    pub parent: Option<usize>,
    pub range: LineRange,
}

impl Def {
    pub fn id(&self, path: &str) -> NodeId {
        NodeId::new(self.kind.into(), path, &self.qualified_name)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RawImport {
    /// The specifier as written, e.g. `./util` or `fmt`.
    pub specifier: String,
    pub span: LineRange,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RefKind {
    Calls,
    References,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RawRef {
    pub kind: RefKind,
    /// Index of the def the ref occurs in; `None` for top-level code.
    pub from: Option<usize>,
    /// The name as written at the use site.
    pub target: String,
    pub span: LineRange,
}

/// Cross-file lookup so frontends can bind names without depending on `index`.
#[derive(Debug, Default)]
pub struct SymbolTable {
    /// language → qualified name → defs (a name can be defined in several files).
    by_name: HashMap<String, HashMap<String, Vec<NodeId>>>,
    /// path → qualified name → def.
    by_path: HashMap<String, HashMap<String, NodeId>>,
}

impl SymbolTable {
    pub fn new(files: &[FileSymbols]) -> Self {
        let mut table = Self::default();
        for file in files {
            let in_file = table.by_path.entry(file.path.clone()).or_default();
            let in_lang = table.by_name.entry(file.language.clone()).or_default();
            for def in &file.defs {
                let id = def.id(&file.path);
                in_lang
                    .entry(def.qualified_name.clone())
                    .or_default()
                    .push(id.clone());
                in_file.insert(def.qualified_name.clone(), id);
            }
        }
        table
    }

    /// Defs of `language` named `qualified_name`, in input file order.
    pub fn lookup(&self, language: &str, qualified_name: &str) -> &[NodeId] {
        self.by_name
            .get(language)
            .and_then(|names| names.get(qualified_name))
            .map_or(&[], Vec::as_slice)
    }

    /// The def named `qualified_name` in the file at `path`.
    pub fn lookup_in(&self, path: &str, qualified_name: &str) -> Option<&NodeId> {
        self.by_path.get(path)?.get(qualified_name)
    }

    /// Whether `path` is one of the files the table was built from.
    pub fn has_file(&self, path: &str) -> bool {
        self.by_path.contains_key(path)
    }
}
