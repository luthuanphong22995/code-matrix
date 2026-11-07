//! Stable node and edge ids.

use std::fmt;

use serde::{Deserialize, Serialize};

use crate::{EdgeKind, NodeKind};

/// FNV-1a 64 over `parts`, each followed by a `0xFF` byte (never valid UTF-8, so
/// `["ab", "c"]` and `["a", "bc"]` differ). Fixed by definition, unlike `DefaultHasher`,
/// so ids are equal across runs, platforms and Rust versions.
pub fn stable_hash(parts: &[&str]) -> u64 {
    const OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
    const PRIME: u64 = 0x0000_0100_0000_01b3;
    let mut hash = OFFSET;
    for part in parts {
        for &byte in part.as_bytes().iter().chain([0xFF].iter()) {
            hash ^= u64::from(byte);
            hash = hash.wrapping_mul(PRIME);
        }
    }
    hash
}

fn hex(hash: u64) -> String {
    format!("{hash:016x}")
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct NodeId(String);

impl NodeId {
    /// Hash of `(kind, workspace-relative path, qualified name)`.
    pub fn new(kind: NodeKind, path: &str, qualified_name: &str) -> Self {
        Self(hex(stable_hash(&[kind.as_str(), path, qualified_name])))
    }

    /// A file's id: its qualified name is empty.
    pub fn file(path: &str) -> Self {
        Self::new(NodeKind::File, path, "")
    }

    /// The single placeholder id for an unbound raw name.
    pub fn unresolved(raw_name: &str) -> Self {
        Self(hex(stable_hash(&[NodeKind::Unresolved.as_str(), raw_name])))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for NodeId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct EdgeId(String);

impl EdgeId {
    /// Hash of `(kind, from, to)`.
    pub fn new(kind: EdgeKind, from: &NodeId, to: &NodeId) -> Self {
        Self(hex(stable_hash(&[
            kind.as_str(),
            from.as_str(),
            to.as_str(),
        ])))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for EdgeId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}
