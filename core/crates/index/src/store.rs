//! The last completed graph, held in memory only.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, PoisonError, RwLock};

use ir::{Graph, NodeId};

use crate::walk;
use crate::FileCache;

/// A published graph with the graph paths that failed to index and the roots it was built
/// from, so all three always agree.
#[derive(Debug)]
pub struct Snapshot {
    pub graph: Graph,
    pub failed: BTreeSet<String>,
    pub roots: Vec<PathBuf>,
}

impl Snapshot {
    /// The graph path of absolute `abs`; `None` outside every root.
    pub fn graph_path(&self, abs: &Path) -> Option<String> {
        walk::graph_path(&self.roots, abs)
    }

    /// The absolute path of `graph_path`; `None` when it maps into no root.
    pub fn disk_path(&self, graph_path: &str) -> Option<PathBuf> {
        walk::disk_path(&self.roots, graph_path)
    }
}

#[derive(Debug, Default)]
pub struct IndexStore {
    current: RwLock<Option<Arc<Snapshot>>>,
}

impl IndexStore {
    pub fn new() -> Self {
        Self::default()
    }

    /// The current snapshot; `None` until the first `publish`.
    pub fn snapshot(&self) -> Option<Arc<Snapshot>> {
        self.current
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    /// Makes `graph`, with `cache`'s failed set and roots, current and returns the node ids
    /// the previous graph had and it lacks, sorted. A poisoned lock is recovered: the
    /// snapshot is only ever replaced whole.
    pub fn publish(&self, graph: Graph, cache: &FileCache) -> Vec<NodeId> {
        let new_ids = node_ids(&graph);
        let snapshot = Snapshot {
            graph,
            failed: cache.failed().clone(),
            roots: cache.roots().to_vec(),
        };
        let previous = self
            .current
            .write()
            .unwrap_or_else(PoisonError::into_inner)
            .replace(Arc::new(snapshot));
        previous.map_or_else(Vec::new, |previous| {
            node_ids(&previous.graph)
                .difference(&new_ids)
                .cloned()
                .collect()
        })
    }
}

/// Every file, def and placeholder id, via the public `Graph` API.
fn node_ids(graph: &Graph) -> BTreeSet<NodeId> {
    let mut ids = BTreeSet::new();
    let mut stack: Vec<NodeId> = graph.files().into_iter().map(|n| n.id.clone()).collect();
    while let Some(id) = stack.pop() {
        ids.extend(
            graph
                .outbound(&id, None)
                .filter(|edge| !edge.is_resolved())
                .map(|edge| edge.to().clone()),
        );
        stack.extend(graph.children(&id).map(|n| n.id.clone()));
        ids.insert(id);
    }
    ids
}
