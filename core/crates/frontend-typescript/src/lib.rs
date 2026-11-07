//! TypeScript/JavaScript frontend: `.ts`, `.tsx`, `.js`, `.jsx` under one language id.

mod extract;
mod flow;
mod resolve;

use ir::{Edge, FileSymbols, FlowError, Frontend, FrontendError, Locate, Lowered, SymbolTable};
use tree_sitter::Language;

pub const LANGUAGE: &str = "typescript";

#[derive(Debug, Default, Clone, Copy)]
pub struct TypeScriptFrontend;

impl Frontend for TypeScriptFrontend {
    fn language(&self) -> &'static str {
        LANGUAGE
    }

    fn extensions(&self) -> &'static [&'static str] {
        &["ts", "tsx", "js", "jsx"]
    }

    fn extract(&self, path: &str, source: &str) -> Result<FileSymbols, FrontendError> {
        extract::extract(path, source, grammar(path)?)
    }

    fn resolve(&self, files: &[FileSymbols], table: &SymbolTable) -> Vec<Edge> {
        resolve::resolve(files, table)
    }

    fn lower(&self, path: &str, source: &str, at: Locate) -> Option<Result<Lowered, FlowError>> {
        Some(flow::lower(path, source, at))
    }
}

/// `.ts` → the TypeScript grammar; `.tsx`/`.js`/`.jsx` → TSX (a superset of JS with JSX).
fn grammar(path: &str) -> Result<Language, FrontendError> {
    match path.rsplit_once('.').map(|(_, ext)| ext) {
        Some("ts") => Ok(tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into()),
        Some("tsx" | "js" | "jsx") => Ok(tree_sitter_typescript::LANGUAGE_TSX.into()),
        _ => Err(FrontendError::Parse {
            path: path.to_owned(),
            message: "not a .ts, .tsx, .js or .jsx file".to_owned(),
        }),
    }
}
