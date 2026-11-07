//! Walks the workspace roots into one `ir::Graph` and holds the last completed graph.

mod changes;
mod registry;
mod run;
mod store;
mod walk;

pub use changes::{apply_changes, ChangeLine, ChangeOutcome, FileCache};
pub use registry::FrontendRegistry;
pub use run::{full_run, RunEvents, RunResult};
pub use store::{IndexStore, Snapshot};
pub use walk::{disk_path, graph_path, Candidate, Skipped};
