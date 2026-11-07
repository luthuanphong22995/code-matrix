//! Wire shapes the panel consumes (`code-graph/design/data-model.md`).

use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Node {
    pub id: String,
    pub kind: &'static str,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start_line: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_line: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,
}

impl From<&ir::Node> for Node {
    fn from(node: &ir::Node) -> Self {
        Self {
            id: node.id.to_string(),
            kind: node.kind.as_str(),
            name: node.name.clone(),
            path: node.path.clone(),
            start_line: node.range.map(|r| r.start),
            end_line: node.range.map(|r| r.end),
            parent_id: node.parent.as_ref().map(ToString::to_string),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Edge {
    pub id: String,
    pub kind: &'static str,
    pub from_id: String,
    pub to_id: String,
    pub resolved: bool,
}

impl From<&ir::Edge> for Edge {
    fn from(edge: &ir::Edge) -> Self {
        Self {
            id: edge.id().to_string(),
            kind: edge.kind().as_str(),
            from_id: edge.from().to_string(),
            to_id: edge.to().to_string(),
            resolved: edge.is_resolved(),
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct GraphSlice {
    pub nodes: Vec<Node>,
    pub edges: Vec<Edge>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct NodeDetail {
    pub node: Node,
    pub inbound: Vec<Edge>,
    pub outbound: Vec<Edge>,
    /// The far end of every non-`contains` edge in `inbound`/`outbound`, once each, by id.
    pub linked: Vec<Node>,
}
