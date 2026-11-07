//! Python frontend: tree-sitter extraction and best-effort module/name resolution.

mod extract;
mod flow;
mod resolve;

use ir::{Edge, FileSymbols, FlowError, Frontend, FrontendError, Locate, Lowered, SymbolTable};

pub struct PythonFrontend;

impl Frontend for PythonFrontend {
    fn language(&self) -> &'static str {
        "python"
    }

    fn extensions(&self) -> &'static [&'static str] {
        &["py"]
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
