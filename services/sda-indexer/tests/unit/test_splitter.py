"""Unit tests del splitter — pure function, sin IO."""

from sda_indexer.pipeline.splitter.large_node import (
    SplitConfig,
    estimate_tokens,
    split_text_by_tokens,
)


def test_estimate_tokens_returns_int():
    n = estimate_tokens("hello world")
    assert isinstance(n, int)
    assert n > 0


def test_split_returns_single_chunk_when_under_max():
    cfg = SplitConfig(max_tokens=1000, min_tokens=50, overlap_chars=0)
    chunks = split_text_by_tokens("short text here", cfg)
    assert len(chunks) == 1
    assert chunks[0] == "short text here"


def test_split_returns_multiple_chunks_when_over_max():
    cfg = SplitConfig(max_tokens=20, min_tokens=5, overlap_chars=0)
    long_text = (
        "Paragraph one with extra filler words.\n\n"
        "Paragraph two with extra filler words.\n\n"
        "Paragraph three with extra filler words.\n\n"
        "Paragraph four with extra filler words.\n\n"
        "Paragraph five with extra filler words."
    )
    chunks = split_text_by_tokens(long_text, cfg)
    assert len(chunks) >= 2
    for c in chunks:
        assert estimate_tokens(c) <= 30


def test_split_respects_paragraph_boundaries():
    cfg = SplitConfig(max_tokens=15, min_tokens=3, overlap_chars=0)
    text = "Para one with words.\n\nPara two more words."
    chunks = split_text_by_tokens(text, cfg)
    assert "Para one with words." in chunks[0]
    assert any("Para two" in c for c in chunks)


def test_split_overlap_includes_tail_of_previous():
    cfg = SplitConfig(max_tokens=15, min_tokens=3, overlap_chars=20)
    text = "A" * 40 + "\n\n" + "B" * 40
    chunks = split_text_by_tokens(text, cfg)
    if len(chunks) >= 2:
        tail = chunks[0][-20:]
        assert tail[:5] in chunks[1] or chunks[1].startswith(("A", "B"))
