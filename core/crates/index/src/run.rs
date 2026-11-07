//! The full-run pipeline: walk, extract in parallel, resolve per language, assemble.

use std::any::Any;
use std::fs;
use std::num::NonZeroUsize;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::thread;

use ir::{FileSymbols, Graph, SymbolTable};

use crate::walk::{walk, Candidate, Skipped};
use crate::{FileCache, FrontendRegistry};

/// Run lifecycle notifications, so the server can report status without `index` knowing
/// its protocol. Workers call `on_file_done`, hence `Sync`.
pub trait RunEvents: Sync {
    fn on_started(&self);
    /// After the walk: `total` = candidates + skipped; `skipped` files count as done.
    fn on_scanned(&self, skipped: usize, total: usize);
    /// After each extracted file; `done` counts skipped files too, so it ends at `total`.
    fn on_file_done(&self, done: usize, total: usize);
    /// Only when the run completes.
    fn on_finished(&self, result: &RunResult);
}

#[derive(Debug)]
pub struct RunResult {
    pub graph: Graph,
    /// Files that parsed: the graph's files minus `failed`.
    pub indexed: usize,
    /// `(path, reason)` for files whose read or extraction failed.
    pub failed: Vec<(String, String)>,
    pub skipped: Vec<(String, Skipped)>,
    /// Every graph file's symbols, so later changes re-parse only the files they name.
    pub cache: FileCache,
}

/// Indexes every root into one graph; per-file errors become `failed` entries. `exclude`
/// globs are root-relative ignore rules. `None` (no graph, no further events) once `cancel`
/// is set.
pub fn full_run(
    registry: &FrontendRegistry,
    roots: &[PathBuf],
    exclude: &[String],
    cancel: &AtomicBool,
    events: &dyn RunEvents,
) -> Option<RunResult> {
    events.on_started();
    let (candidates, skipped) = walk(registry, roots, exclude, cancel)?;
    let total = candidates.len() + skipped.len();
    events.on_scanned(skipped.len(), total);
    let done = AtomicUsize::new(skipped.len());

    let threads = thread::available_parallelism().map_or(1, NonZeroUsize::get);
    let chunk = candidates.len().div_ceil(threads).max(1);
    // Chunks are joined in order, so `extracted` keeps the candidates' sorted path order.
    let extracted: Vec<(FileSymbols, Option<String>)> = thread::scope(|scope| {
        let handles: Vec<_> = candidates
            .chunks(chunk)
            .map(|chunk| {
                let done = &done;
                scope.spawn(move || {
                    chunk
                        .iter()
                        .map_while(|c| {
                            if cancel.load(Ordering::Relaxed) {
                                return None;
                            }
                            let file = extract(registry, c);
                            events.on_file_done(done.fetch_add(1, Ordering::Relaxed) + 1, total);
                            Some(file)
                        })
                        .collect::<Vec<_>>()
                })
            })
            .collect();
        handles
            .into_iter()
            .flat_map(|handle| handle.join().expect("extract catches frontend panics"))
            .collect()
    });
    if cancel.load(Ordering::Relaxed) {
        return None;
    }

    let mut files = Vec::with_capacity(extracted.len());
    let mut failed = Vec::new();
    for (symbols, error) in extracted {
        if let Some(reason) = error {
            failed.push((symbols.path.clone(), reason));
        }
        files.push(symbols);
    }

    let graph = build_graph(registry, &files);
    let result = RunResult {
        indexed: graph.files().len() - failed.len(),
        graph,
        skipped,
        cache: FileCache {
            roots: roots.to_vec(),
            exclude: exclude.to_vec(),
            files: files.into_iter().map(|f| (f.path.clone(), f)).collect(),
            failed: failed.iter().map(|(path, _)| path.clone()).collect(),
        },
        failed,
    };
    events.on_finished(&result);
    Some(result)
}

/// Symbol table → file symbols in the given (sorted path) order → per-language resolve.
pub(crate) fn build_graph(registry: &FrontendRegistry, files: &[FileSymbols]) -> Graph {
    let table = SymbolTable::new(files);
    let mut graph = Graph::new();
    for file in files {
        graph.insert_file_symbols(file);
    }
    for language in registry.languages() {
        let Some(frontend) = registry.by_language(language) else {
            continue;
        };
        // ponytail: clones each language's files into a slice; group in place if it shows.
        let own: Vec<FileSymbols> = files
            .iter()
            .filter(|file| file.language == language)
            .cloned()
            .collect();
        graph.insert_edges(frontend.resolve(&own, &table));
    }
    graph
}

/// The file's symbols, or an empty `FileSymbols` plus the reason when it cannot be read,
/// the frontend errors or the frontend panics.
pub(crate) fn extract(
    registry: &FrontendRegistry,
    candidate: &Candidate,
) -> (FileSymbols, Option<String>) {
    let frontend = candidate
        .extension()
        .and_then(|ext| registry.by_extension(ext))
        .expect("walk selects only registered extensions");
    let path = &candidate.path;
    let outcome = fs::read(candidate.root.join(&candidate.rel_path))
        .map_err(|e| format!("cannot read {path}: {e}"))
        .and_then(|bytes| {
            let source = String::from_utf8_lossy(&bytes);
            match catch_unwind(AssertUnwindSafe(|| frontend.extract(path, &source))) {
                Ok(Ok(symbols)) => Ok(symbols),
                Ok(Err(e)) => Err(e.to_string()),
                Err(panic) => Err(format!("frontend panicked on {path}: {}", message(&*panic))),
            }
        });
    match outcome {
        Ok(mut symbols) => {
            // The graph path and language are the run's, whatever the frontend echoed.
            symbols.path.clone_from(path);
            symbols.language = frontend.language().to_owned();
            (symbols, None)
        }
        Err(reason) => (
            FileSymbols {
                language: frontend.language().to_owned(),
                path: path.clone(),
                defs: Vec::new(),
                imports: Vec::new(),
                refs: Vec::new(),
            },
            Some(reason),
        ),
    }
}

fn message(panic: &(dyn Any + Send)) -> &str {
    panic
        .downcast_ref::<&str>()
        .copied()
        .or_else(|| panic.downcast_ref::<String>().map(String::as_str))
        .unwrap_or("unknown panic")
}
