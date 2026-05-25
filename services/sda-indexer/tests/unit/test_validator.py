"""Unit tests para validator — pure function, sin LLM ni IO."""

from sda_indexer.pipeline.structure.types import TocNode, ValidationResult
from sda_indexer.pipeline.structure.validator import validate_tree


def test_validate_ok_for_well_formed_tree():
    nodes = [
        TocNode(title="Intro", depth=1, page_start=1),
        TocNode(title="Setup", depth=1, page_start=5),
        TocNode(title="Steps", depth=2, page_start=6),
    ]
    r = validate_tree(nodes, total_pages=20, max_depth=6)
    assert isinstance(r, ValidationResult)
    assert r.ok is True
    assert r.errors == []


def test_validate_detects_page_out_of_range():
    nodes = [TocNode(title="X", depth=1, page_start=999)]
    r = validate_tree(nodes, total_pages=20, max_depth=6)
    assert r.ok is False
    assert any("page_start 999" in e for e in r.errors)


def test_validate_detects_depth_jump():
    nodes = [
        TocNode(title="A", depth=1, page_start=1),
        TocNode(title="B", depth=3, page_start=2),
    ]
    r = validate_tree(nodes, total_pages=20, max_depth=6)
    assert r.ok is False
    assert any("depth jump" in e for e in r.errors)


def test_validate_detects_pages_out_of_order():
    nodes = [
        TocNode(title="A", depth=1, page_start=10),
        TocNode(title="B", depth=1, page_start=5),
    ]
    r = validate_tree(nodes, total_pages=20, max_depth=6)
    assert r.ok is False
    assert any("out of order" in e for e in r.errors)


def test_validate_detects_excessive_depth():
    nodes = [TocNode(title="X", depth=8, page_start=1)]
    r = validate_tree(nodes, total_pages=20, max_depth=6)
    assert r.ok is False
    assert any("max_depth" in e for e in r.errors)


def test_validate_detects_empty_titles():
    nodes = [TocNode(title="  ", depth=1, page_start=1)]
    r = validate_tree(nodes, total_pages=20, max_depth=6)
    assert r.ok is False
    assert any("empty title" in e for e in r.errors)


def test_validate_empty_list_returns_error():
    r = validate_tree([], total_pages=20, max_depth=6)
    assert r.ok is False
    assert any("empty" in e for e in r.errors)
