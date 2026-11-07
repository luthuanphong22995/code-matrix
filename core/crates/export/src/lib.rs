//! Projects an `ir::Graph` onto the wire shapes the panel consumes. Every list is sorted by
//! id with no duplicates, so the same graph always serializes the same way.

pub mod view;

use std::collections::{BTreeMap, BTreeSet};
use std::fmt;

use ir::{EdgeId, EdgeKind, Graph, NodeId, NodeKind};

pub use view::{Edge, GraphSlice, Node, NodeDetail};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExportError {
    /// The id is not in the graph, or is not of the kind the call needs.
    UnknownNode,
}

impl fmt::Display for ExportError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("UnknownNode")
    }
}

impl std::error::Error for ExportError {}

/// Nodes and edges keyed by id, so the output is sorted and deduped.
#[derive(Default)]
struct Slice<'g> {
    nodes: BTreeMap<&'g NodeId, &'g ir::Node>,
    edges: BTreeMap<&'g EdgeId, &'g ir::Edge>,
}

impl<'g> Slice<'g> {
    fn node(&mut self, node: &'g ir::Node) {
        self.nodes.insert(&node.id, node);
    }

    /// Adds `edge` and, when unresolved, the placeholder it targets.
    fn edge(&mut self, graph: &'g Graph, edge: &'g ir::Edge) {
        self.edges.insert(edge.id(), edge);
        if !edge.is_resolved() {
            if let Some(placeholder) = graph.node(edge.to()) {
                self.node(placeholder);
            }
        }
    }

    fn finish(self) -> GraphSlice {
        GraphSlice {
            nodes: self.nodes.into_values().map(Node::from).collect(),
            edges: self.edges.into_values().map(Edge::from).collect(),
        }
    }
}

/// Every file, every `Imports` edge and the placeholders those edges target (code-graph R1).
pub fn files_layer(graph: &Graph) -> GraphSlice {
    let mut slice = Slice::default();
    for file in graph.files() {
        slice.node(file);
        for edge in graph.outbound(&file.id, Some(EdgeKind::Imports)) {
            slice.edge(graph, edge);
        }
    }
    slice.finish()
}

/// The file's `contains` subtree (without the file node), its `Contains` edges, and every
/// `Calls`/`References` edge leaving the file or the subtree, with their placeholders.
pub fn expand(graph: &Graph, file_id: &NodeId) -> Result<GraphSlice, ExportError> {
    let file = graph
        .node(file_id)
        .filter(|node| node.kind == NodeKind::File)
        .ok_or(ExportError::UnknownNode)?;
    let mut slice = Slice::default();
    let mut stack = vec![&file.id];
    while let Some(id) = stack.pop() {
        for edge in graph.outbound(id, None) {
            match edge.kind() {
                EdgeKind::Contains => {
                    if let Some(child) = graph.node(edge.to()) {
                        slice.edges.insert(edge.id(), edge);
                        slice.node(child);
                        stack.push(&child.id);
                    }
                }
                EdgeKind::Calls | EdgeKind::References => slice.edge(graph, edge),
                EdgeKind::Imports => {}
            }
        }
    }
    Ok(slice.finish())
}

/// The node with all its inbound and outbound edges, of every kind.
pub fn node_detail(graph: &Graph, id: &NodeId) -> Result<NodeDetail, ExportError> {
    let node = graph.node(id).ok_or(ExportError::UnknownNode)?;
    let sorted = |edges: Vec<&ir::Edge>| -> Vec<Edge> {
        let by_id: BTreeMap<_, _> = edges.into_iter().map(|e| (e.id(), e)).collect();
        by_id.into_values().map(Edge::from).collect()
    };
    let far_ends = graph
        .inbound(id, None)
        .map(|e| (e, e.from()))
        .chain(graph.outbound(id, None).map(|e| (e, e.to())));
    let linked: BTreeMap<_, _> = far_ends
        .filter(|(e, _)| e.kind() != EdgeKind::Contains)
        .filter_map(|(_, end)| graph.node(end))
        .map(|n| (&n.id, n))
        .collect();
    Ok(NodeDetail {
        node: node.into(),
        inbound: sorted(graph.inbound(id, None).collect()),
        outbound: sorted(graph.outbound(id, None).collect()),
        linked: linked.into_values().map(Node::from).collect(),
    })
}

/// `id`, its whole `contains` subtree, every node within `hops` (clamped to 1–3) undirected
/// steps over edges of every kind, the `contains` ancestors of all of them, and every edge
/// whose both ends are in (code-graph R14). The panel narrows this by kind and hops itself.
pub fn neighbourhood(graph: &Graph, id: &NodeId, hops: u8) -> Result<GraphSlice, ExportError> {
    let start = graph.node(id).ok_or(ExportError::UnknownNode)?;
    // The hop walk first, on its own visited set: a subtree node must still be a frontier node at its hop.
    let mut ids: BTreeSet<&NodeId> = BTreeSet::from([&start.id]);
    let mut frontier: Vec<&NodeId> = vec![&start.id];
    for _ in 0..hops.clamp(1, 3) {
        let mut next = Vec::new();
        for n in frontier {
            let ends = graph
                .outbound(n, None)
                .map(|e| e.to())
                .chain(graph.inbound(n, None).map(|e| e.from()));
            for end in ends {
                if let Some(node) = graph.node(end) {
                    if ids.insert(&node.id) {
                        next.push(&node.id);
                    }
                }
            }
        }
        frontier = next;
    }
    let mut stack = vec![&start.id];
    while let Some(n) = stack.pop() {
        for child in graph.children(n) {
            ids.insert(&child.id);
            stack.push(&child.id);
        }
    }
    // Ancestors let the panel's path glob find each symbol's file.
    for n in ids.clone() {
        let mut cur = n;
        while let Some(parent) = graph.inbound(cur, Some(EdgeKind::Contains)).next() {
            ids.insert(parent.from());
            cur = parent.from();
        }
    }
    let mut slice = Slice::default();
    for n in &ids {
        if let Some(node) = graph.node(n) {
            slice.node(node);
        }
        for edge in graph.outbound(n, None) {
            if ids.contains(edge.to()) {
                slice.edges.insert(edge.id(), edge);
            }
        }
    }
    Ok(slice.finish())
}
