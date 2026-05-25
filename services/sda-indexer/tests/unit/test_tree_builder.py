from sda_indexer.pipeline.tree.builder import build_tree, FlatHeader, TreeNode


def test_flat_to_tree_simple():
    flat = [
        FlatHeader(level=1, title="A", start_line=1, text="ta"),
        FlatHeader(level=1, title="B", start_line=10, text="tb"),
    ]
    nodes = build_tree(flat, total_lines=20)
    assert len(nodes) == 2
    assert nodes[0].node_id_str == "n_1"
    assert nodes[0].structure_code == "1"
    assert nodes[0].depth == 1
    assert nodes[0].end_index == 9   # one before next header
    assert nodes[1].end_index == 20  # EOF


def test_flat_to_tree_nested():
    flat = [
        FlatHeader(level=1, title="Cap 1", start_line=1, text=""),
        FlatHeader(level=2, title="1.1",   start_line=5, text=""),
        FlatHeader(level=2, title="1.2",   start_line=10, text=""),
        FlatHeader(level=1, title="Cap 2", start_line=20, text=""),
    ]
    roots = build_tree(flat, total_lines=30)
    assert len(roots) == 2
    cap1 = roots[0]
    assert cap1.structure_code == "1"
    assert len(cap1.children) == 2
    assert cap1.children[0].structure_code == "1.1"
    assert cap1.children[1].structure_code == "1.2"
    assert cap1.children[0].node_id_str == "n_1_1"


def test_skip_levels_handled():
    # Salto de nivel (h1 → h3) — el h3 se promueve a hijo directo del h1
    flat = [
        FlatHeader(level=1, title="A", start_line=1, text=""),
        FlatHeader(level=3, title="A.x.y", start_line=5, text=""),
    ]
    roots = build_tree(flat, total_lines=10)
    assert len(roots) == 1
    assert len(roots[0].children) == 1
    assert roots[0].children[0].title == "A.x.y"


def test_flatten_iter():
    flat = [
        FlatHeader(level=1, title="A", start_line=1, text=""),
        FlatHeader(level=2, title="A.1", start_line=5, text=""),
    ]
    roots = build_tree(flat, total_lines=10)
    from sda_indexer.pipeline.tree.builder import flatten
    all_nodes = list(flatten(roots))
    assert len(all_nodes) == 2
    assert {n.structure_code for n in all_nodes} == {"1", "1.1"}
