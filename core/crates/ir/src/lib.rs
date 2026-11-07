//! Language-agnostic structural graph shared by every frontend, the index and export.

pub mod edge;
pub mod flow;
pub mod frontend;
pub mod graph;
pub mod id;
pub mod node;
pub mod symbols;

pub use edge::{Edge, EdgeKind};
pub use flow::{
    solve, Binding, BlockKind, FlowBlock, FlowEvent, FlowFunction, Hop, Occurrence, Picked, Pos,
    Role, Trace, TraceBlock, TraceBranch, TraceStatus,
};
pub use frontend::{FlowError, Frontend, FrontendError, Locate, Lowered};
pub use graph::Graph;
pub use id::{stable_hash, EdgeId, NodeId};
pub use node::{LineRange, Node, NodeKind};
pub use symbols::{Def, DefKind, FileSymbols, RawImport, RawRef, RefKind, SymbolTable};
