//! Selects the files a run indexes.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use ignore::overrides::OverrideBuilder;
use ignore::{DirEntry, WalkBuilder};

use crate::FrontendRegistry;

/// Files above this many bytes are skipped (1 MiB).
pub const MAX_FILE_SIZE: u64 = 1_048_576;

/// A selected file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Candidate {
    /// The workspace root the file was found under.
    pub root: PathBuf,
    /// `/`-separated path relative to `root`.
    pub rel_path: String,
    /// Graph path: `rel_path`, prefixed with the root's unique basename when there are
    /// several roots.
    pub path: String,
    pub size: u64,
}

impl Candidate {
    pub fn extension(&self) -> Option<&str> {
        Path::new(&self.rel_path).extension()?.to_str()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Skipped {
    TooLarge,
}

/// Candidates, and `(path, reason)` for files skipped by size.
type Walked = (Vec<Candidate>, Vec<(String, Skipped)>);

/// Supported, non-ignored, non-hidden, non-excluded files under `roots`, and the ones
/// skipped for size, both sorted by graph path. Walk errors are not files and are dropped.
/// `exclude` globs are root-relative ignore rules. `None` once `cancel` is set.
pub(crate) fn walk(
    registry: &FrontendRegistry,
    roots: &[PathBuf],
    exclude: &[String],
    cancel: &AtomicBool,
) -> Option<Walked> {
    let prefixes = prefixes(roots);
    let mut candidates = Vec::new();
    let mut skipped = Vec::new();
    for (root, prefix) in roots.iter().zip(prefixes) {
        for entry in builder(root, exclude).build().flatten() {
            if cancel.load(Ordering::Relaxed) {
                return None;
            }
            let Some(candidate) = candidate(registry, root, &prefix, &entry) else {
                continue;
            };
            if candidate.size > MAX_FILE_SIZE {
                skipped.push((candidate.path, Skipped::TooLarge));
            } else {
                candidates.push(candidate);
            }
        }
    }
    candidates.sort_by(|a, b| a.path.cmp(&b.path));
    skipped.sort_by(|a, b| a.0.cmp(&b.0));
    Some((candidates, skipped))
}

/// One item per root containing `path`: the graph path of `path` under that root, and the
/// files at or under it that `walk` would select (candidates, then too-large graph paths),
/// sorted. Only `path`'s ancestors and its own subtree are visited.
pub(crate) fn select(
    registry: &FrontendRegistry,
    roots: &[PathBuf],
    exclude: &[String],
    path: &Path,
) -> Vec<(String, Vec<Candidate>, Vec<String>)> {
    roots
        .iter()
        .zip(prefixes(roots))
        .filter_map(|(root, prefix)| {
            let rel = rel_path(path.strip_prefix(root).ok()?);
            let mut builder = builder(root, exclude);
            let target = path.to_path_buf();
            builder.filter_entry(move |e| {
                target.starts_with(e.path()) || e.path().starts_with(&target)
            });
            let mut candidates = Vec::new();
            let mut too_large = Vec::new();
            for entry in builder.build().flatten() {
                let Some(candidate) = candidate(registry, root, &prefix, &entry) else {
                    continue;
                };
                if candidate.size > MAX_FILE_SIZE {
                    too_large.push(candidate.path);
                } else {
                    candidates.push(candidate);
                }
            }
            candidates.sort_by(|a, b| a.path.cmp(&b.path));
            too_large.sort();
            Some((format!("{prefix}{rel}"), candidates, too_large))
        })
        .collect()
}

/// The walk over `root`: `.gitignore` scope, hidden files and `exclude` as ignore rules.
fn builder(root: &Path, exclude: &[String]) -> WalkBuilder {
    // Inside a git checkout git's rule holds: ignore files above the repo root don't
    // count (with `require_git(false)` they would). Outside one, `.gitignore` still applies.
    let in_git = root.ancestors().any(|dir| dir.join(".git").exists());
    let mut overrides = OverrideBuilder::new(root);
    for glob in exclude {
        // ponytail: a glob that fails to compile is dropped silently; return the bad ones
        // for a `$/log warn` if users trip over it.
        let _ = overrides.add(&format!("!{glob}"));
    }
    let mut builder = WalkBuilder::new(root);
    builder.require_git(in_git);
    if let Ok(overrides) = overrides.build() {
        builder.overrides(overrides);
    }
    builder
}

/// The entry as a candidate (whatever its size); `None` for non-files and unsupported
/// extensions.
fn candidate(
    registry: &FrontendRegistry,
    root: &Path,
    prefix: &str,
    entry: &DirEntry,
) -> Option<Candidate> {
    if !entry.file_type().is_some_and(|t| t.is_file()) {
        return None;
    }
    let meta = entry.metadata().ok()?;
    let rel_path = rel_path(entry.path().strip_prefix(root).ok()?);
    let candidate = Candidate {
        root: root.to_path_buf(),
        path: format!("{prefix}{rel_path}"),
        rel_path,
        size: meta.len(),
    };
    candidate
        .extension()
        .and_then(|ext| registry.by_extension(ext))?;
    Some(candidate)
}

/// The graph path of absolute `abs` under the first root containing it; `None` outside every
/// root. No filesystem access.
pub fn graph_path(roots: &[PathBuf], abs: &Path) -> Option<String> {
    roots
        .iter()
        .zip(prefixes(roots))
        .find_map(|(root, prefix)| {
            Some(format!(
                "{prefix}{}",
                rel_path(abs.strip_prefix(root).ok()?)
            ))
        })
}

/// The absolute path of `graph_path`; `None` when no root's prefix matches. No filesystem
/// access.
pub fn disk_path(roots: &[PathBuf], graph_path: &str) -> Option<PathBuf> {
    roots
        .iter()
        .zip(prefixes(roots))
        .find_map(|(root, prefix)| Some(root.join(graph_path.strip_prefix(prefix.as_str())?)))
}

/// `/`-separated.
fn rel_path(rel: &Path) -> String {
    rel.components()
        .map(|c| c.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/")
}

/// `""` for a single root; otherwise `"<basename>/"`, with `~2`, `~3`… for a basename an
/// earlier root already used.
fn prefixes(roots: &[PathBuf]) -> Vec<String> {
    if roots.len() <= 1 {
        return vec![String::new(); roots.len()];
    }
    let mut seen: HashMap<String, usize> = HashMap::new();
    roots
        .iter()
        .map(|root| {
            let name = root
                .file_name()
                .map_or_else(|| "root".to_owned(), |n| n.to_string_lossy().into_owned());
            let count = seen.entry(name.clone()).or_default();
            *count += 1;
            if *count == 1 {
                format!("{name}/")
            } else {
                format!("{name}~{count}/")
            }
        })
        .collect()
}
