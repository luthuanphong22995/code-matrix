//! A line-based frontend for exercising the pipeline without a real parser.
//!
//! `fn <name>` defines a function; `call <name>` calls it from the latest def (or the file);
//! any `FAIL` in the source makes `extract` fail. Also the shared temp-workspace helpers.
// Each test binary uses a different subset of the helpers.
#![allow(dead_code)]

use std::fs;
use std::path::PathBuf;

use index::{RunEvents, RunResult};
use ir::{
    Def, DefKind, Edge, EdgeKind, FileSymbols, Frontend, FrontendError, LineRange, RawRef, RefKind,
    SymbolTable,
};

/// A workspace under the system temp dir, removed on drop.
pub struct TempDir(pub PathBuf);

impl TempDir {
    pub fn new(name: &str) -> Self {
        let dir = std::env::temp_dir().join(format!("index-test-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        Self(dir)
    }

    pub fn write(&self, rel: &str, contents: &[u8]) {
        let path = self.0.join(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, contents).unwrap();
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

pub struct NoEvents;

impl RunEvents for NoEvents {
    fn on_started(&self) {}
    fn on_scanned(&self, _: usize, _: usize) {}
    fn on_file_done(&self, _: usize, _: usize) {}
    fn on_finished(&self, _: &RunResult) {}
}

pub struct FakeFrontend;

impl Frontend for FakeFrontend {
    fn language(&self) -> &'static str {
        "fake"
    }

    fn extensions(&self) -> &'static [&'static str] {
        &["fake"]
    }

    fn extract(&self, path: &str, source: &str) -> Result<FileSymbols, FrontendError> {
        if source.contains("FAIL") {
            return Err(FrontendError::Parse {
                path: path.to_owned(),
                message: "FAIL marker".to_owned(),
            });
        }
        let mut defs = Vec::new();
        let mut refs = Vec::new();
        for (index, line) in source.lines().enumerate() {
            let n = index as u32 + 1;
            let range = LineRange { start: n, end: n };
            if let Some(name) = line.strip_prefix("fn ") {
                defs.push(Def {
                    kind: DefKind::Function,
                    qualified_name: name.trim().to_owned(),
                    parent: None,
                    range,
                });
            } else if let Some(name) = line.strip_prefix("call ") {
                refs.push(RawRef {
                    kind: RefKind::Calls,
                    from: defs.len().checked_sub(1),
                    target: name.trim().to_owned(),
                    span: range,
                });
            }
        }
        Ok(FileSymbols {
            language: "fake".to_owned(),
            path: path.to_owned(),
            defs,
            imports: Vec::new(),
            refs,
        })
    }

    fn resolve(&self, files: &[FileSymbols], table: &SymbolTable) -> Vec<Edge> {
        files
            .iter()
            .flat_map(|file| {
                file.refs.iter().map(move |r| {
                    let from = file.ref_source(r);
                    match table.lookup("fake", &r.target).first() {
                        Some(to) => Edge::resolved(EdgeKind::Calls, from, to.clone()),
                        None => Edge::unresolved(EdgeKind::Calls, from, &r.target),
                    }
                })
            })
            .collect()
    }
}

#[test]
fn fake_frontend_extracts_defs_and_calls() {
    let symbols = FakeFrontend.extract("a.fake", "fn a\ncall b\n").unwrap();
    assert_eq!(symbols.defs.len(), 1);
    assert_eq!(symbols.refs[0].from, Some(0));
    assert!(FakeFrontend.extract("a.fake", "FAIL").is_err());
}
