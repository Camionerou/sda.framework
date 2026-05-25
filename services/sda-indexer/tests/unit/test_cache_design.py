import pytest
from sda_indexer.llm.cache_design import (
    PromptParts,
    PrefixDriftError,
)


def test_assemble_concatenates_in_order():
    p = PromptParts(
        static_system="SYS",
        static_instructions="INS",
        static_schema="SCH",
        static_examples="EXM",
        semi_static_doc_ctx="DOC",
        dynamic_payload="DYN",
    )
    out = p.assemble()
    assert out.index("SYS") < out.index("INS") < out.index("SCH") < out.index("EXM")
    assert out.index("EXM") < out.index("DOC") < out.index("DYN")


def test_assert_prefix_stable_ok_when_static_zones_match():
    a = PromptParts(
        static_system="SYS", static_instructions="INS", static_schema="SCH",
        static_examples="EXM", semi_static_doc_ctx="DOC1", dynamic_payload="A",
    )
    b = PromptParts(
        static_system="SYS", static_instructions="INS", static_schema="SCH",
        static_examples="EXM", semi_static_doc_ctx="DOC1", dynamic_payload="B",
    )
    # Should NOT raise
    a.assert_prefix_stable(b)


def test_assert_prefix_stable_raises_on_static_drift():
    a = PromptParts(
        static_system="SYS_A", static_instructions="INS", static_schema="SCH",
        static_examples="EXM", semi_static_doc_ctx="DOC", dynamic_payload="X",
    )
    b = PromptParts(
        static_system="SYS_B", static_instructions="INS", static_schema="SCH",
        static_examples="EXM", semi_static_doc_ctx="DOC", dynamic_payload="X",
    )
    with pytest.raises(PrefixDriftError):
        a.assert_prefix_stable(b)


def test_assert_prefix_stable_ok_when_dynamic_differs():
    """dynamic_payload puede variar — eso ES esperado."""
    a = PromptParts(
        static_system="S", static_instructions="I", static_schema="C",
        static_examples="E", semi_static_doc_ctx="D", dynamic_payload="alpha",
    )
    b = PromptParts(
        static_system="S", static_instructions="I", static_schema="C",
        static_examples="E", semi_static_doc_ctx="D", dynamic_payload="omega",
    )
    a.assert_prefix_stable(b)
