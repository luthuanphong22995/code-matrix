//! Graph nodes.

use serde::{Deserialize, Serialize};

use crate::NodeId;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NodeKind {
    File,
    Class,
    Function,
    Unresolved,
}

impl NodeKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::File => "file",
            Self::Class => "class",
            Self::Function => "function",
            Self::Unresolved => "unresolved",
        }
    }
}

/// Inclusive, 1-based line range.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct LineRange {
    pub start: u32,
    pub end: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Node {
    pub id: NodeId,
    pub kind: NodeKind,
    /// Workspace-relative path for a file, qualified name for a class or function, raw
    /// name for a placeholder.
    pub name: String,
    /// Owning file's path; `None` for placeholders.
    pub path: Option<String>,
    pub range: Option<LineRange>,
    /// The containing file, class or function; `None` for files and placeholders.
    pub parent: Option<NodeId>,
}

impl Node {
    pub fn file(path: &str) -> Self {
        Self {
            id: NodeId::file(path),
            kind: NodeKind::File,
            name: path.to_owned(),
            path: Some(path.to_owned()),
            range: None,
            parent: None,
        }
    }

    pub fn unresolved(raw_name: &str) -> Self {
        Self {
            id: NodeId::unresolved(raw_name),
            kind: NodeKind::Unresolved,
            name: raw_name.to_owned(),
            path: None,
            range: None,
            parent: None,
        }
    }
}
