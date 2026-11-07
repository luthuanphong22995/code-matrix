//! The in-memory graph store with per-file ownership.

use std::collections::{BTreeSet, HashMap};

use crate::{Edge, EdgeId, EdgeKind, FileSymbols, Node, NodeId, NodeKind};

/// Nodes and edges keyed by id, with inbound and outbound adjacency.
///
/// Every file node, def node and edge is owned by one file (an edge by the file of its
/// `from` node), so a file's contribution can be removed and re-inserted. Placeholders are
/// shared: one per raw name, dropped once no edge points at them.
#[derive(Debug, Default)]
pub struct Graph {
    nodes: HashMap<NodeId, Node>,
    edges: HashMap<EdgeId, Edge>,
    outbound: HashMap<NodeId, BTreeSet<EdgeId>>,
    inbound: HashMap<NodeId, BTreeSet<EdgeId>>,
    owned: HashMap<NodeId, Owned>,
}

#[derive(Debug, Default)]
struct Owned {
    nodes: Vec<NodeId>,
    edges: BTreeSet<EdgeId>,
}

impl Graph {
    pub fn new() -> Self {
        Self::default()
    }

    /// Adds the file node, its defs and a `Contains` edge from each def to its parent.
    /// Replaces whatever the file contributed before.
    pub fn insert_file_symbols(&mut self, file: &FileSymbols) {
        let file_id = file.file_id();
        self.remove_file(&file_id);

        let mut owned = Owned::default();
        owned.nodes.push(file_id.clone());
        self.nodes.insert(file_id.clone(), Node::file(&file.path));
        let mut contains = Vec::new();
        for (index, def) in file.defs.iter().enumerate() {
            let id = def.id(&file.path);
            if self.nodes.contains_key(&id) {
                continue; // a redefinition of the same name: first one wins
            }
            let parent = def
                .parent
                .filter(|&parent| parent < index)
                .and_then(|parent| file.def_id(parent))
                .unwrap_or_else(|| file_id.clone());
            owned.nodes.push(id.clone());
            contains.push(Edge::resolved(
                EdgeKind::Contains,
                parent.clone(),
                id.clone(),
            ));
            self.nodes.insert(
                id.clone(),
                Node {
                    id,
                    kind: def.kind.into(),
                    name: def.qualified_name.clone(),
                    path: Some(file.path.clone()),
                    range: Some(def.range),
                    parent: Some(parent),
                },
            );
        }
        self.owned.insert(file_id, owned);
        self.add_edges(contains);
    }

    /// Adds edges, creating at most one placeholder per raw name for unresolved ones.
    /// Duplicate ids are kept once; an edge whose `from` node is not in the graph is skipped,
    /// and so is any `Contains` edge — those come only from `insert_file_symbols`.
    pub fn insert_edges(&mut self, edges: impl IntoIterator<Item = Edge>) {
        self.add_edges(
            edges
                .into_iter()
                .filter(|edge| edge.kind() != EdgeKind::Contains),
        );
    }

    fn add_edges(&mut self, edges: impl IntoIterator<Item = Edge>) {
        for edge in edges {
            let Some(owner) = self.owner_of(edge.from()) else {
                continue;
            };
            if self.edges.contains_key(edge.id()) {
                continue;
            }
            if let Some(raw_name) = edge.raw_name() {
                self.nodes
                    .entry(edge.to().clone())
                    .or_insert_with(|| Node::unresolved(raw_name));
            }
            let id = edge.id().clone();
            self.outbound
                .entry(edge.from().clone())
                .or_default()
                .insert(id.clone());
            self.inbound
                .entry(edge.to().clone())
                .or_default()
                .insert(id.clone());
            self.owned
                .entry(owner)
                .or_default()
                .edges
                .insert(id.clone());
            self.edges.insert(id, edge);
        }
    }

    /// Removes exactly the nodes and edges `file` contributed and returns the edges from
    /// other files that pointed into its nodes. Those stay in the graph, dangling until the
    /// file is re-inserted (same ids) or their own file is re-resolved.
    pub fn remove_file(&mut self, file: &NodeId) -> Vec<Edge> {
        let Some(owned) = self.owned.remove(file) else {
            return Vec::new();
        };
        for id in &owned.edges {
            let Some(edge) = self.remove_edge(id) else {
                continue;
            };
            let to = edge.to();
            if !edge.is_resolved() && !self.inbound.contains_key(to) {
                self.nodes.remove(to);
            }
        }
        let mut dangling = Vec::new();
        for id in &owned.nodes {
            self.nodes.remove(id);
            self.outbound.remove(id);
            if let Some(inbound) = self.inbound.get(id) {
                dangling.extend(inbound.iter().filter_map(|e| self.edges.get(e)).cloned());
            }
        }
        dangling
    }

    pub fn node(&self, id: &NodeId) -> Option<&Node> {
        self.nodes.get(id)
    }

    /// Every node of every kind, placeholders included.
    pub fn node_count(&self) -> usize {
        self.nodes.len()
    }

    /// Edges leaving `id`, optionally only of `kind`.
    pub fn outbound(&self, id: &NodeId, kind: Option<EdgeKind>) -> impl Iterator<Item = &Edge> {
        self.adjacent(&self.outbound, id, kind)
    }

    /// Edges arriving at `id`, optionally only of `kind`.
    pub fn inbound(&self, id: &NodeId, kind: Option<EdgeKind>) -> impl Iterator<Item = &Edge> {
        self.adjacent(&self.inbound, id, kind)
    }

    /// File nodes, sorted by path.
    pub fn files(&self) -> Vec<&Node> {
        let mut files: Vec<&Node> = self
            .owned
            .keys()
            .filter_map(|id| self.nodes.get(id))
            .filter(|node| node.kind == NodeKind::File)
            .collect();
        files.sort_by(|a, b| a.name.cmp(&b.name));
        files
    }

    /// Nodes `id` contains directly.
    pub fn children(&self, id: &NodeId) -> impl Iterator<Item = &Node> {
        self.outbound(id, Some(EdgeKind::Contains))
            .filter_map(|edge| self.nodes.get(edge.to()))
    }

    fn adjacent<'a>(
        &'a self,
        map: &'a HashMap<NodeId, BTreeSet<EdgeId>>,
        id: &NodeId,
        kind: Option<EdgeKind>,
    ) -> impl Iterator<Item = &'a Edge> {
        map.get(id)
            .into_iter()
            .flatten()
            .filter_map(|e| self.edges.get(e))
            .filter(move |edge| kind.is_none_or(|kind| edge.kind() == kind))
    }

    /// The file owning `id`; `None` for placeholders and unknown nodes.
    fn owner_of(&self, id: &NodeId) -> Option<NodeId> {
        self.nodes.get(id)?.path.as_deref().map(NodeId::file)
    }

    fn remove_edge(&mut self, id: &EdgeId) -> Option<Edge> {
        let edge = self.edges.remove(id)?;
        for (map, node) in [
            (&mut self.outbound, edge.from()),
            (&mut self.inbound, edge.to()),
        ] {
            if let Some(set) = map.get_mut(node) {
                set.remove(id);
                if set.is_empty() {
                    map.remove(node);
                }
            }
        }
        Some(edge)
    }
}
