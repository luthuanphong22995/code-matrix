use ir::{
    Def, DefKind, Edge, EdgeKind, FileSymbols, Frontend, FrontendError, Graph, LineRange, NodeId,
    NodeKind, RawImport, RawRef, RefKind, SymbolTable,
};

fn span(line: u32) -> LineRange {
    LineRange {
        start: line,
        end: line,
    }
}

fn func(name: &str, parent: Option<usize>) -> Def {
    Def {
        kind: DefKind::Function,
        qualified_name: name.to_owned(),
        parent,
        range: span(1),
    }
}

fn file(path: &str, defs: Vec<Def>, refs: Vec<RawRef>) -> FileSymbols {
    FileSymbols {
        language: "fake".to_owned(),
        path: path.to_owned(),
        defs,
        imports: Vec::new(),
        refs,
    }
}

fn call(from: usize, target: &str) -> RawRef {
    RawRef {
        kind: RefKind::Calls,
        from: Some(from),
        target: target.to_owned(),
        span: span(2),
    }
}

/// Binds a call to a def of the same name anywhere in the language, else a placeholder.
struct FakeFrontend;

impl Frontend for FakeFrontend {
    fn language(&self) -> &'static str {
        "fake"
    }

    fn extensions(&self) -> &'static [&'static str] {
        &["fake"]
    }

    fn extract(&self, path: &str, _source: &str) -> Result<FileSymbols, FrontendError> {
        Err(FrontendError::Parse {
            path: path.to_owned(),
            message: "test frontend does not parse".to_owned(),
        })
    }

    fn resolve(&self, files: &[FileSymbols], table: &SymbolTable) -> Vec<Edge> {
        files
            .iter()
            .flat_map(|f| f.refs.iter().map(move |r| (f, r)))
            .map(|(f, r)| {
                let from = f.ref_source(r);
                match table.lookup(self.language(), &r.target).first() {
                    Some(to) => Edge::resolved(EdgeKind::Calls, from, to.clone()),
                    None => Edge::unresolved(EdgeKind::Calls, from, &r.target),
                }
            })
            .collect()
    }
}

fn fixture() -> Vec<FileSymbols> {
    vec![
        file(
            "a.fake",
            vec![func("a", None)],
            vec![call(0, "b"), call(0, "missing")],
        ),
        file("b.fake", vec![func("b", None)], vec![call(0, "a")]),
    ]
}

fn build(files: &[FileSymbols]) -> Graph {
    let mut graph = Graph::new();
    for f in files {
        graph.insert_file_symbols(f);
    }
    graph.insert_edges(FakeFrontend.resolve(files, &SymbolTable::new(files)));
    graph
}

#[test]
fn node_ids_are_stable() {
    let id = NodeId::new(NodeKind::Function, "src/main.go", "main.run");
    assert_eq!(
        id,
        NodeId::new(NodeKind::Function, "src/main.go", "main.run")
    );
    assert_ne!(id, NodeId::new(NodeKind::Class, "src/main.go", "main.run"));
    assert_ne!(
        id,
        NodeId::new(NodeKind::Function, "src/other.go", "main.run")
    );
    assert_ne!(
        id,
        NodeId::new(NodeKind::Function, "src/main.go", "main.stop")
    );
    assert_ne!(
        NodeId::new(NodeKind::Function, "ab", "c"),
        NodeId::new(NodeKind::Function, "a", "bc")
    );
    // Pinned: a change here breaks ids persisted or compared across processes.
    assert_eq!(id.as_str(), "19a7afe863010de4");
    assert_eq!(NodeId::unresolved("fmt"), NodeId::unresolved("fmt"));
}

#[test]
fn fake_frontend_resolves_two_calls_and_one_placeholder() {
    let files = fixture();
    let edges = FakeFrontend.resolve(&files, &SymbolTable::new(&files));
    assert_eq!(edges.len(), 3, "one edge per raw ref");
    let resolved: Vec<_> = edges.iter().filter(|e| e.is_resolved()).collect();
    assert_eq!(resolved.len(), 2);
    let unresolved: Vec<_> = edges.iter().filter(|e| !e.is_resolved()).collect();
    assert_eq!(unresolved.len(), 1);
    assert_eq!(unresolved[0].to(), &NodeId::unresolved("missing"));

    let graph = build(&files);
    let a = files[0].def_id(0).unwrap();
    let b = files[1].def_id(0).unwrap();
    let calls: Vec<_> = graph.outbound(&a, Some(EdgeKind::Calls)).collect();
    assert_eq!(calls.len(), 2);
    assert!(calls.iter().any(|e| e.to() == &b && e.is_resolved()));
    let placeholder = graph.node(&NodeId::unresolved("missing")).unwrap();
    assert_eq!(placeholder.kind, NodeKind::Unresolved);
    assert_eq!(placeholder.name, "missing");
}

#[test]
fn one_placeholder_per_raw_name() {
    let files = vec![
        file("a.fake", vec![func("a", None)], vec![call(0, "x")]),
        file("b.fake", vec![func("b", None)], vec![call(0, "x")]),
    ];
    let graph = build(&files);
    let x = NodeId::unresolved("x");
    assert_eq!(graph.inbound(&x, None).count(), 2);
    assert!(graph.inbound(&x, None).all(|e| !e.is_resolved()));
}

#[test]
fn contains_edges_join_defs_to_parents() {
    let f = file(
        "c.fake",
        vec![
            Def {
                kind: DefKind::Class,
                qualified_name: "C".to_owned(),
                parent: None,
                range: span(1),
            },
            func("C.m", Some(0)),
        ],
        Vec::new(),
    );
    let mut graph = Graph::new();
    graph.insert_file_symbols(&f);
    let class = f.def_id(0).unwrap();
    let method = f.def_id(1).unwrap();
    let top: Vec<_> = graph.children(&f.file_id()).map(|n| n.id.clone()).collect();
    assert_eq!(top, vec![class.clone()]);
    let inner: Vec<_> = graph.children(&class).map(|n| n.id.clone()).collect();
    assert_eq!(inner, vec![method.clone()]);
    assert_eq!(graph.node(&method).unwrap().parent, Some(class.clone()));
    assert_eq!(graph.files().len(), 1);

    // Contains edges come only from the file's own defs.
    graph.insert_edges([Edge::resolved(EdgeKind::Contains, method, class.clone())]);
    assert_eq!(graph.inbound(&class, Some(EdgeKind::Contains)).count(), 1);
}

#[test]
fn remove_file_keeps_other_files_and_returns_dangling_inbound() {
    let files = fixture();
    let mut graph = build(&files);
    let a_file = files[0].file_id();
    let a = files[0].def_id(0).unwrap();
    let b = files[1].def_id(0).unwrap();

    let dangling = graph.remove_file(&a_file);
    assert_eq!(dangling.len(), 1);
    assert_eq!(dangling[0].from(), &b);
    assert_eq!(dangling[0].to(), &a);

    assert!(graph.node(&a_file).is_none());
    assert!(graph.node(&a).is_none());
    assert!(
        graph.node(&NodeId::unresolved("missing")).is_none(),
        "placeholder with no remaining edge is dropped"
    );
    assert!(graph.node(&b).is_some());
    assert_eq!(graph.outbound(&b, Some(EdgeKind::Calls)).count(), 1);
    assert_eq!(graph.files().len(), 1);
    assert!(graph.remove_file(&a_file).is_empty());

    // Re-inserting reconnects the dangling edge: ids are stable.
    graph.insert_file_symbols(&files[0]);
    assert_eq!(graph.inbound(&a, Some(EdgeKind::Calls)).count(), 1);
}

#[test]
fn inbound_and_outbound_agree_and_filter_by_kind() {
    let files = fixture();
    let graph = build(&files);
    for f in &files {
        let a = f.def_id(0).unwrap();
        assert_eq!(graph.outbound(&a, Some(EdgeKind::Imports)).count(), 0);
        for edge in graph.outbound(&a, None) {
            assert!(graph
                .inbound(edge.to(), Some(edge.kind()))
                .any(|e| e == edge));
        }
        for edge in graph.inbound(&a, None) {
            assert!(graph
                .outbound(edge.from(), Some(edge.kind()))
                .any(|e| e == edge));
        }
    }
    let a = files[0].def_id(0).unwrap();
    assert_eq!(graph.inbound(&a, Some(EdgeKind::Contains)).count(), 1);
    assert_eq!(graph.inbound(&a, Some(EdgeKind::Calls)).count(), 1);
}

#[test]
fn file_symbols_serde_round_trip() {
    let mut f = file("a.fake", vec![func("a", None)], vec![call(0, "b")]);
    f.imports.push(RawImport {
        specifier: "./b".to_owned(),
        span: span(1),
    });
    let json = serde_json::to_string(&f).unwrap();
    assert_eq!(
        json,
        r#"{"language":"fake","path":"a.fake","defs":[{"kind":"function","qualified_name":"a","parent":null,"range":{"start":1,"end":1}}],"imports":[{"specifier":"./b","span":{"start":1,"end":1}}],"refs":[{"kind":"calls","from":0,"target":"b","span":{"start":2,"end":2}}]}"#
    );
    assert_eq!(serde_json::from_str::<FileSymbols>(&json).unwrap(), f);
}
