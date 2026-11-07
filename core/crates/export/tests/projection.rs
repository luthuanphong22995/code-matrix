use export::{expand, files_layer, neighbourhood, node_detail, ExportError, GraphSlice};
use ir::{Def, DefKind, Edge, EdgeKind, FileSymbols, Graph, LineRange, NodeId, NodeKind};

fn def(kind: DefKind, name: &str, parent: Option<usize>, line: u32) -> Def {
    Def {
        kind,
        qualified_name: name.to_owned(),
        parent,
        range: LineRange {
            start: line,
            end: line + 1,
        },
    }
}

fn file(path: &str, defs: Vec<Def>) -> FileSymbols {
    FileSymbols {
        language: "fake".to_owned(),
        path: path.to_owned(),
        defs,
        imports: Vec::new(),
        refs: Vec::new(),
    }
}

fn id(kind: NodeKind, path: &str, name: &str) -> NodeId {
    NodeId::new(kind, path, name)
}

/// `a.x`: class `A` ⊃ method `A.m`, function `f`. `b.x`: function `g`.
/// a imports b (resolved) and `lib` (unresolved); `A.m → g` resolved call;
/// `f → missing` unresolved call; `f` references `A`; `g → f` call from b into a.
fn graph() -> Graph {
    let mut g = Graph::new();
    g.insert_file_symbols(&file(
        "a.x",
        vec![
            def(DefKind::Class, "A", None, 1),
            def(DefKind::Function, "A.m", Some(0), 2),
            def(DefKind::Function, "f", None, 5),
        ],
    ));
    g.insert_file_symbols(&file("b.x", vec![def(DefKind::Function, "g", None, 1)]));
    let a = NodeId::file("a.x");
    let m = id(NodeKind::Function, "a.x", "A.m");
    let f = id(NodeKind::Function, "a.x", "f");
    let gid = id(NodeKind::Function, "b.x", "g");
    g.insert_edges([
        Edge::resolved(EdgeKind::Imports, a.clone(), NodeId::file("b.x")),
        Edge::unresolved(EdgeKind::Imports, a, "lib"),
        Edge::resolved(EdgeKind::Calls, m, gid.clone()),
        Edge::unresolved(EdgeKind::Calls, f.clone(), "missing"),
        Edge::resolved(
            EdgeKind::References,
            f.clone(),
            id(NodeKind::Class, "a.x", "A"),
        ),
        Edge::resolved(EdgeKind::Calls, gid, f),
    ]);
    g
}

fn kinds(slice: &GraphSlice) -> (Vec<&str>, Vec<&str>) {
    (
        slice.nodes.iter().map(|n| n.kind).collect(),
        slice.edges.iter().map(|e| e.kind).collect(),
    )
}

fn assert_sorted(slice: &GraphSlice) {
    assert!(slice.nodes.windows(2).all(|w| w[0].id < w[1].id));
    assert!(slice.edges.windows(2).all(|w| w[0].id < w[1].id));
}

#[test]
fn files_layer_is_files_imports_and_import_placeholders() {
    let slice = files_layer(&graph());
    assert_sorted(&slice);
    let (mut nodes, edges) = kinds(&slice);
    nodes.sort_unstable();
    assert_eq!(nodes, ["file", "file", "unresolved"]);
    assert_eq!(edges, ["imports", "imports"]);
    let placeholder = slice.nodes.iter().find(|n| n.kind == "unresolved").unwrap();
    assert_eq!(placeholder.name, "lib");
    assert_eq!(
        slice.edges.iter().filter(|e| !e.resolved).count(),
        1,
        "{slice:?}"
    );
}

#[test]
fn expand_is_subtree_and_its_outgoing_calls_and_references() {
    let g = graph();
    let slice = expand(&g, &NodeId::file("a.x")).unwrap();
    assert_sorted(&slice);
    let mut names: Vec<&str> = slice.nodes.iter().map(|n| n.name.as_str()).collect();
    names.sort_unstable();
    assert_eq!(names, ["A", "A.m", "f", "missing"]);
    let (_, mut edges) = kinds(&slice);
    edges.sort_unstable();
    assert_eq!(
        edges,
        [
            "calls",
            "calls",
            "contains",
            "contains",
            "contains",
            "references"
        ]
    );
    let a = NodeId::file("a.x").to_string();
    assert!(slice.nodes.iter().all(|n| n.id != a), "file node excluded");
    let gid = id(NodeKind::Function, "b.x", "g").to_string();
    assert!(
        slice.edges.iter().all(|e| e.from_id != gid),
        "b's call into a is not part of a's expansion"
    );
    let unresolved = slice.edges.iter().find(|e| !e.resolved).unwrap();
    assert_eq!(unresolved.kind, "calls");
    assert!(slice.nodes.iter().any(|n| n.id == unresolved.to_id));
}

#[test]
fn expand_needs_a_file_id() {
    let g = graph();
    let f = id(NodeKind::Function, "a.x", "f");
    assert_eq!(expand(&g, &f), Err(ExportError::UnknownNode));
    assert_eq!(
        expand(&g, &NodeId::file("nope")),
        Err(ExportError::UnknownNode)
    );
}

#[test]
fn node_detail_has_all_inbound_and_outbound() {
    let g = graph();
    let detail = node_detail(&g, &id(NodeKind::Function, "a.x", "f")).unwrap();
    assert_eq!(detail.node.name, "f");
    let mut inbound: Vec<&str> = detail.inbound.iter().map(|e| e.kind).collect();
    inbound.sort_unstable();
    assert_eq!(inbound, ["calls", "contains"]);
    let mut outbound: Vec<&str> = detail.outbound.iter().map(|e| e.kind).collect();
    outbound.sort_unstable();
    assert_eq!(outbound, ["calls", "references"]);
    assert!(detail.outbound.windows(2).all(|w| w[0].id < w[1].id));
    assert_eq!(
        node_detail(&g, &NodeId::file("nope")),
        Err(ExportError::UnknownNode)
    );
}

fn linked_names(g: &Graph, node: &NodeId) -> Vec<String> {
    let detail = node_detail(g, node).unwrap();
    assert!(detail.linked.windows(2).all(|w| w[0].id < w[1].id));
    detail.linked.into_iter().map(|n| n.name).collect()
}

#[test]
fn node_detail_links_far_ends_of_non_contains_edges() {
    let mut g = graph();
    let f = id(NodeKind::Function, "a.x", "f");
    let mut names = linked_names(&g, &f);
    names.sort_unstable();
    assert_eq!(
        names,
        ["A", "g", "missing"],
        "no a.x file (contains parent)"
    );

    let gid = id(NodeKind::Function, "b.x", "g");
    g.insert_edges([Edge::resolved(EdgeKind::Calls, f.clone(), gid)]);
    let names = linked_names(&g, &f);
    assert_eq!(names.iter().filter(|n| *n == "g").count(), 1);

    let class = id(NodeKind::Class, "a.x", "A");
    assert_eq!(
        linked_names(&g, &class),
        ["f"],
        "no a.x parent or A.m child"
    );

    let mut lone = Graph::new();
    lone.insert_file_symbols(&file("c.x", vec![def(DefKind::Function, "h", None, 1)]));
    assert!(linked_names(&lone, &id(NodeKind::Function, "c.x", "h")).is_empty());
}

#[test]
fn wire_json() {
    let g = graph();
    let a = NodeId::file("a.x");
    let file = export::Node::from(g.node(&a).unwrap());
    assert_eq!(
        serde_json::to_value(&file).unwrap(),
        serde_json::json!({"id": a.to_string(), "kind": "file", "name": "a.x", "path": "a.x"})
    );
    let m = id(NodeKind::Function, "a.x", "A.m");
    let class = id(NodeKind::Class, "a.x", "A");
    assert_eq!(
        serde_json::to_value(export::Node::from(g.node(&m).unwrap())).unwrap(),
        serde_json::json!({"id": m.to_string(), "kind": "function", "name": "A.m",
            "path": "a.x", "startLine": 2, "endLine": 3, "parentId": class.to_string()})
    );
    let f = id(NodeKind::Function, "a.x", "f");
    let edge = g.outbound(&f, Some(EdgeKind::Calls)).next().unwrap();
    assert_eq!(
        serde_json::to_value(export::Edge::from(edge)).unwrap(),
        serde_json::json!({"id": edge.id().to_string(), "kind": "calls",
            "fromId": f.to_string(), "toId": NodeId::unresolved("missing").to_string(),
            "resolved": false})
    );
    let detail = serde_json::to_value(node_detail(&g, &f).unwrap()).unwrap();
    assert!(detail["linked"].is_array(), "{detail}");
}

fn names(slice: &GraphSlice) -> Vec<&str> {
    let mut names: Vec<&str> = slice.nodes.iter().map(|n| n.name.as_str()).collect();
    names.sort_unstable();
    names
}

#[test]
fn neighbourhood_of_a_file_is_its_subtree_and_one_hop() {
    let slice = neighbourhood(&graph(), &NodeId::file("b.x"), 1).unwrap();
    assert_sorted(&slice);
    assert_eq!(names(&slice), ["a.x", "b.x", "g"]);
    let (_, mut edges) = kinds(&slice);
    edges.sort_unstable();
    assert_eq!(edges, ["contains", "imports"]);
}

#[test]
fn neighbourhood_of_a_function_brings_callers_with_their_ancestors() {
    let g = graph();
    let slice = neighbourhood(&g, &id(NodeKind::Function, "b.x", "g"), 1).unwrap();
    assert_sorted(&slice);
    // hop 1: b.x (container), A.m (caller), f (callee); A and a.x are their ancestors.
    assert_eq!(names(&slice), ["A", "A.m", "a.x", "b.x", "f", "g"]);
    assert!(slice.edges.iter().all(|e| e.to_id != "unresolved::missing"));
    assert!(slice.edges.iter().any(|e| e.kind == "references"));
    let ids: Vec<&str> = slice.nodes.iter().map(|n| n.id.as_str()).collect();
    assert!(slice
        .edges
        .iter()
        .all(|e| ids.contains(&e.from_id.as_str()) && ids.contains(&e.to_id.as_str())));
}

#[test]
fn neighbourhood_hops_widen_and_clamp() {
    let g = graph();
    let gid = id(NodeKind::Function, "b.x", "g");
    let two = neighbourhood(&g, &gid, 2).unwrap();
    assert_eq!(names(&two), ["A", "A.m", "a.x", "b.x", "f", "g", "missing"]);
    // `lib` hangs off a.x, which is 2 hops away (g → f → a.x), so it needs 3.
    assert!(names(&neighbourhood(&g, &gid, 3).unwrap()).contains(&"lib"));
    assert_eq!(
        neighbourhood(&g, &gid, 9).unwrap(),
        neighbourhood(&g, &gid, 3).unwrap()
    );
    assert_eq!(
        neighbourhood(&g, &gid, 0).unwrap(),
        neighbourhood(&g, &gid, 1).unwrap()
    );
    assert_eq!(neighbourhood(&g, &gid, 2).unwrap(), two);
}

#[test]
fn neighbourhood_of_unknown_node() {
    assert_eq!(
        neighbourhood(&graph(), &NodeId::file("nope"), 1),
        Err(ExportError::UnknownNode)
    );
}

#[test]
fn neighbourhood_walks_on_from_subtree_nodes() {
    // a.x ⊃ A ⊃ A.m → g: A.m is 2 hops from a.x, g is 3 — the subtree must not stop the walk.
    let g = graph();
    let slice = neighbourhood(&g, &NodeId::file("a.x"), 3).unwrap();
    assert!(names(&slice).contains(&"g"), "{:?}", names(&slice));
    let two = neighbourhood(&g, &NodeId::file("a.x"), 2).unwrap();
    // via contains a.x → f, then f's references/calls: `missing` placeholder at 2.
    assert!(names(&two).contains(&"missing"), "{:?}", names(&two));
}
