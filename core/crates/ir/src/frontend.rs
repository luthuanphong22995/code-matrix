//! The two-phase contract every language frontend implements, plus the optional data-flow
//! `lower` hook.

use crate::flow::{FlowFunction, Picked, Pos};
use crate::{Edge, FileSymbols, SymbolTable};

/// Where to lower: a position the user picked (trace), or a function and binding to find
/// again after a re-index (retrace).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Locate {
    At(Pos),
    Function {
        qualified_name: String,
        variable_key: String,
    },
}

/// One function lowered for `flow::solve`, and what was picked in it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Lowered {
    pub function: FlowFunction,
    pub picked: Picked,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum FlowError {
    #[error("no identifier at the position")]
    NoIdentifier,
    #[error("{name} is not inside a function")]
    NotInFunction { name: String },
    #[error("{name} is not a local variable of {function}")]
    NotLocal { name: String, function: String },
    #[error("the function no longer exists")]
    FunctionGone,
    #[error("the variable no longer exists")]
    VariableGone,
}

#[derive(Debug, thiserror::Error)]
pub enum FrontendError {
    #[error("cannot parse {path}: {message}")]
    Parse { path: String, message: String },
}

pub trait Frontend: Send + Sync {
    /// Language name, e.g. `"go"`; matches `FileSymbols::language`.
    fn language(&self) -> &'static str;

    /// File extensions handled, without the dot.
    fn extensions(&self) -> &'static [&'static str];

    /// Phase 1, pure and per file: defs, raw imports and raw refs. `path` is
    /// workspace-relative.
    fn extract(&self, path: &str, source: &str) -> Result<FileSymbols, FrontendError>;

    /// Phase 2, per language over all of its files: bind raw imports and refs. Emits exactly
    /// one edge per raw ref and per raw import — `Edge::resolved` when bound, otherwise
    /// `Edge::unresolved` to that name's placeholder. Never drops one.
    fn resolve(&self, files: &[FileSymbols], table: &SymbolTable) -> Vec<Edge>;

    /// Lower the function at `at` for data flow. `None` means this language has no data flow.
    fn lower(&self, path: &str, source: &str, at: Locate) -> Option<Result<Lowered, FlowError>> {
        let _ = (path, source, at);
        None
    }
}
