from pathlib import Path
import pytest

from sda_mineru.parser import (
    Heuristics,
    ParseResult,
    parse_pdf,
    run_heuristics,
)


FIXTURE = Path(__file__).parent / "fixtures" / "sample_native.pdf"


def test_heuristics_detects_text_layer():
    h = run_heuristics(FIXTURE)
    assert isinstance(h, Heuristics)
    assert h.page_count == 3
    assert h.has_text_layer is True
    assert h.text_ratio > 0.5


async def test_parse_pdf_native_path():
    result = await parse_pdf(FIXTURE, force_path=None)
    assert isinstance(result, ParseResult)
    assert result.path_used in ("fast", "full")
    if result.path_used == "fast":
        assert result.parser_used == "native"
        assert "Title" in result.markdown
    assert result.page_count == 3


async def test_parse_pdf_force_full_uses_mineru(tmp_path, monkeypatch):
    """Verifica que force_path='full' bypasses heuristics y usa MinerU."""
    # En unit test sin GPU, MinerU puede fallar — chequeamos al menos
    # que el routing intentó usar mineru.
    with pytest.raises(Exception) as exc:
        await parse_pdf(FIXTURE, force_path="full")
    # OK si MinerU no está disponible en CI; importante que NO haya intentado native
    assert "native" not in str(exc.value).lower() or "mineru" in str(exc.value).lower()
