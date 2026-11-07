//! Go frontend: tree-sitter extraction and package-level, module-aware resolution.

mod extract;
mod flow;
mod resolve;

use std::path::PathBuf;

use ir::{Edge, FileSymbols, FlowError, Frontend, FrontendError, Locate, Lowered, SymbolTable};

/// `root` is the workspace root the file paths are relative to; `resolve` reads `go.mod`
/// under it.
pub struct GoFrontend {
    root: PathBuf,
}

impl GoFrontend {
    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }
}

impl Frontend for GoFrontend {
    fn language(&self) -> &'static str {
        "go"
    }

    fn extensions(&self) -> &'static [&'static str] {
        &["go"]
    }

    fn extract(&self, path: &str, source: &str) -> Result<FileSymbols, FrontendError> {
        extract::extract(path, source)
    }

    fn resolve(&self, files: &[FileSymbols], table: &SymbolTable) -> Vec<Edge> {
        resolve::resolve(&self.root, files, table)
    }

    fn lower(&self, _path: &str, source: &str, at: Locate) -> Option<Result<Lowered, FlowError>> {
        Some(flow::lower(source, at))
    }
}
