//! Re-syncs named paths with disk against a completed run's per-file symbols.

use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;

use ir::{FileSymbols, Graph};

use crate::run::{build_graph, extract};
use crate::walk::select;
use crate::FrontendRegistry;

/// A completed run's roots, exclude globs and every graph file's symbols (a failed file as
/// its empty `FileSymbols`), keyed by graph path, plus the graph paths that failed.
#[derive(Debug, Default)]
pub struct FileCache {
    pub(crate) roots: Vec<PathBuf>,
    pub(crate) exclude: Vec<String>,
    pub(crate) files: BTreeMap<String, FileSymbols>,
    pub(crate) failed: BTreeSet<String>,
}

impl FileCache {
    pub fn roots(&self) -> &[PathBuf] {
        &self.roots
    }

    /// The cached files by graph path.
    pub fn files(&self) -> &BTreeMap<String, FileSymbols> {
        &self.files
    }

    /// Graph paths whose read or extraction failed.
    pub fn failed(&self) -> &BTreeSet<String> {
        &self.failed
    }
}

/// One affected file, by graph path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ChangeLine {
    Reindexed(String),
    Removed(String),
    /// `(path, reason)`; the file keeps a bare node.
    Failed(String, String),
    /// Over the size cap; no node.
    Skipped(String),
}

#[derive(Debug)]
pub struct ChangeOutcome {
    pub lines: Vec<ChangeLine>,
    /// The rebuilt graph; `None` when no cache entry changed.
    pub graph: Option<Graph>,
}

/// Re-syncs each path (file or directory, whatever change was reported) with disk, in order:
/// files at or under it that the walk would select are re-extracted, entries at or under it
/// that it would not are dropped. Only those files are parsed; the graph is rebuilt from the
/// whole cache, so it equals a full run over the same disk state.
pub fn apply_changes(
    registry: &FrontendRegistry,
    cache: &mut FileCache,
    paths: &[PathBuf],
) -> ChangeOutcome {
    let mut lines = Vec::new();
    let mut changed = false;
    for path in paths {
        for (at, candidates, too_large) in select(registry, &cache.roots, &cache.exclude, path) {
            let mut selected = BTreeSet::new();
            for candidate in &candidates {
                let (symbols, error) = extract(registry, candidate);
                lines.push(match error {
                    Some(reason) => {
                        cache.failed.insert(candidate.path.clone());
                        ChangeLine::Failed(candidate.path.clone(), reason)
                    }
                    None => {
                        cache.failed.remove(&candidate.path);
                        ChangeLine::Reindexed(candidate.path.clone())
                    }
                });
                cache.files.insert(candidate.path.clone(), symbols);
                selected.insert(candidate.path.as_str());
                changed = true;
            }
            for path in &too_large {
                changed |= cache.files.remove(path).is_some();
                cache.failed.remove(path);
                lines.push(ChangeLine::Skipped(path.clone()));
            }
            // `at` is `""` or ends in `/` for a root itself; otherwise match it and its subtree.
            let dir = if at.is_empty() || at.ends_with('/') {
                at.clone()
            } else {
                format!("{at}/")
            };
            let gone: Vec<String> = cache
                .files
                .keys()
                .filter(|key| {
                    (**key == at || key.starts_with(&dir)) && !selected.contains(key.as_str())
                })
                .cloned()
                .collect();
            for key in gone {
                cache.files.remove(&key);
                cache.failed.remove(&key);
                lines.push(ChangeLine::Removed(key));
                changed = true;
            }
        }
    }
    // ponytail: clones every cached file into a slice per rebuild, like `full_run`'s
    // per-language clone; keep `Vec<FileSymbols>` sorted in the cache if it shows.
    let graph = changed.then(|| {
        let files: Vec<FileSymbols> = cache.files.values().cloned().collect();
        build_graph(registry, &files)
    });
    ChangeOutcome { lines, graph }
}
