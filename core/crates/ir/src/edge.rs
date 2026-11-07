//! Graph edges.

use serde::{Deserialize, Serialize};

use crate::{EdgeId, NodeId};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EdgeKind {
    Contains,
    Imports,
    Calls,
    References,
}

impl EdgeKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Contains => "contains",
            Self::Imports => "imports",
            Self::Calls => "calls",
            Self::References => "references",
        }
    }
}

/// Fields are private and there is no `Deserialize`, so `resolved == false` exactly when
/// `to` is a placeholder.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Edge {
    id: EdgeId,
    kind: EdgeKind,
    from: NodeId,
    to: NodeId,
    resolved: bool,
    /// The placeholder's raw name, set only when unresolved.
    #[serde(skip_serializing_if = "Option::is_none")]
    raw_name: Option<String>,
}

impl Edge {
    /// An edge bound to a definition or file.
    pub fn resolved(kind: EdgeKind, from: NodeId, to: NodeId) -> Self {
        Self {
            id: EdgeId::new(kind, &from, &to),
            kind,
            from,
            to,
            resolved: true,
            raw_name: None,
        }
    }

    /// An edge to the single placeholder for `raw_name`.
    pub fn unresolved(kind: EdgeKind, from: NodeId, raw_name: &str) -> Self {
        let to = NodeId::unresolved(raw_name);
        Self {
            id: EdgeId::new(kind, &from, &to),
            kind,
            from,
            to,
            resolved: false,
            raw_name: Some(raw_name.to_owned()),
        }
    }

    pub fn id(&self) -> &EdgeId {
        &self.id
    }

    pub fn kind(&self) -> EdgeKind {
        self.kind
    }

    pub fn from(&self) -> &NodeId {
        &self.from
    }

    pub fn to(&self) -> &NodeId {
        &self.to
    }

    pub fn is_resolved(&self) -> bool {
        self.resolved
    }

    pub fn raw_name(&self) -> Option<&str> {
        self.raw_name.as_deref()
    }
}
