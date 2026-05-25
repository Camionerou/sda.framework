"""Split de nodos que exceden `max_tokens_per_node`. Spec §3 PageIndex
+ §5.3.

NO usa LLM — split puramente heurístico respetando boundaries (paragraphs,
sentences). Conserva contexto via overlap_chars en chunks consecutivos.

estimate_tokens(): aproximación rápida sin tokenizer real (4 chars ≈ 1 token
para spanish/english). Si Wave 2 necesita precisión, swap a tiktoken o
similar. Acá vale más speed que exactitud.
"""

from dataclasses import dataclass


@dataclass(frozen=True)
class SplitConfig:
    max_tokens: int = 8000
    min_tokens: int = 200
    overlap_chars: int = 200


def estimate_tokens(text: str) -> int:
    """Aproximación: 1 token ≈ 4 chars (avg latin scripts)."""
    return max(1, len(text) // 4)


def _split_on_boundaries(text: str, max_chars: int) -> list[str]:
    """Split agresivo respetando \\n\\n > \\n > '. ' > ' ' > chars."""
    if len(text) <= max_chars:
        return [text]
    for separator in ("\n\n", "\n", ". ", " "):
        idx = text.rfind(separator, 0, max_chars)
        if idx > max_chars // 2:
            head = text[: idx + len(separator)]
            tail = text[idx + len(separator):]
            return [head] + _split_on_boundaries(tail, max_chars)
    return [text[:max_chars]] + _split_on_boundaries(text[max_chars:], max_chars)


def split_text_by_tokens(text: str, cfg: SplitConfig) -> list[str]:
    """Divide `text` en chunks de hasta ~max_tokens. Devuelve >=1 chunk."""
    if estimate_tokens(text) <= cfg.max_tokens:
        return [text]

    max_chars = cfg.max_tokens * 4
    raw_chunks = _split_on_boundaries(text, max_chars)

    if cfg.overlap_chars > 0 and len(raw_chunks) > 1:
        with_overlap: list[str] = [raw_chunks[0]]
        for prev, cur in zip(raw_chunks, raw_chunks[1:]):
            tail = prev[-cfg.overlap_chars:] if len(prev) > cfg.overlap_chars else prev
            with_overlap.append(tail + cur)
        raw_chunks = with_overlap

    merged: list[str] = []
    for c in raw_chunks:
        if merged and estimate_tokens(c) < cfg.min_tokens:
            merged[-1] = merged[-1] + c
        else:
            merged.append(c)
    return merged
