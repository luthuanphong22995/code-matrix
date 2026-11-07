//! Java frontend: tree-sitter extraction and declared-package resolution into the IR.

mod extract;
mod flow;
mod resolve;

use ir::{Edge, FileSymbols, FlowError, Frontend, FrontendError, Locate, Lowered, SymbolTable};

pub struct JavaFrontend;

impl Frontend for JavaFrontend {
    fn language(&self) -> &'static str {
        "java"
    }

    fn extensions(&self) -> &'static [&'static str] {
        &["java"]
    }

    fn extract(&self, path: &str, source: &str) -> Result<FileSymbols, FrontendError> {
        extract::extract(path, source)
    }

    fn resolve(&self, files: &[FileSymbols], table: &SymbolTable) -> Vec<Edge> {
        resolve::resolve(files, table)
    }

    fn lower(&self, _path: &str, source: &str, at: Locate) -> Option<Result<Lowered, FlowError>> {
        Some(flow::lower(source, at))
    }
}
