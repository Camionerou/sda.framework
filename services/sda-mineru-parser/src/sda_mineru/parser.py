"""Wrapper sobre MinerU + heurísticas nativas con pypdf.

Routing:
- run_heuristics(path) → si has_text_layer y text_ratio>threshold y page_count<max
  → path "fast" (pypdf direct extraction)
- caso contrario → path "full" (subprocess MinerU magic-pdf)
"""

import asyncio
import os
import shutil
import subprocess
import time
from dataclasses import dataclass, asdict
from pathlib import Path

import pypdf
import structlog

log = structlog.get_logger()


@dataclass(frozen=True)
class Heuristics:
    page_count: int
    has_text_layer: bool
    has_toc: bool
    text_ratio: float
    confidence: float


@dataclass(frozen=True)
class ParseResult:
    markdown: str
    parser_used: str   # 'native' | 'mineru'
    path_used: str     # 'fast' | 'full'
    page_count: int
    heuristics: Heuristics
    elapsed_seconds: float


# Defaults; pueden ser sobreescritos por el caller (FastAPI lee de settings remotas).
_DEFAULT_MIN_TEXT_RATIO = 0.7
_DEFAULT_MAX_PAGES_FAST = 100
_DEFAULT_MIN_CONFIDENCE = 0.8


def run_heuristics(pdf_path: Path) -> Heuristics:
    """Lee el PDF con pypdf y deriva heurísticas para fast-path decision."""
    reader = pypdf.PdfReader(str(pdf_path))
    page_count = len(reader.pages)
    pages_with_text = 0
    has_toc = False

    for page in reader.pages[:20]:  # Muestra primeras 20
        text = page.extract_text() or ""
        if text.strip():
            pages_with_text += 1
        # Heurística TOC: busca "table of contents", "índice", "contents", numeración
        low = text.lower()
        if "table of contents" in low or "índice" in low or "tabla de contenido" in low:
            has_toc = True

    sample = min(20, page_count)
    text_ratio = pages_with_text / sample if sample > 0 else 0.0

    # Confidence: cuanto más texto y más linealmente distribuido, más confianza.
    confidence = min(1.0, text_ratio * (1.0 if page_count < 50 else 0.85))

    return Heuristics(
        page_count=page_count,
        has_text_layer=text_ratio > 0.3,
        has_toc=has_toc,
        text_ratio=text_ratio,
        confidence=confidence,
    )


def _decide_path(h: Heuristics, force_path: str | None) -> str:
    if force_path in ("fast", "full"):
        return force_path
    if not h.has_text_layer:
        return "full"
    if h.page_count > _DEFAULT_MAX_PAGES_FAST:
        return "full"
    if h.text_ratio < _DEFAULT_MIN_TEXT_RATIO:
        return "full"
    if h.confidence < _DEFAULT_MIN_CONFIDENCE:
        return "full"
    return "fast"


def _parse_native(pdf_path: Path) -> str:
    """Extract markdown via pypdf — heuristic 'fast path'.

    Convierte cada página a `## Page N\n\n<text>\n\n` (simple pero suficiente
    cuando hay capa de texto limpia + TOC).
    """
    reader = pypdf.PdfReader(str(pdf_path))
    out = []
    for i, page in enumerate(reader.pages, start=1):
        text = page.extract_text() or ""
        out.append(f"## Page {i}\n\n{text.strip()}\n")
    return "\n".join(out)


async def _parse_mineru(pdf_path: Path, work_dir: Path) -> str:
    """Ejecuta MinerU (magic-pdf CLI) como subprocess. Devuelve markdown."""
    work_dir.mkdir(parents=True, exist_ok=True)
    # MinerU se invoca por CLI: `magic-pdf -p <pdf> -o <outdir> -m auto`
    # TODO Task 34 (deploy): verify CLI name on srv-ia-01 — MinerU rebrand mid-2025
    # renamed the package to `mineru` with CLI `mineru`. May need to symlink
    # `magic-pdf` -> `mineru` or switch this invocation accordingly.
    cmd = [
        "magic-pdf",
        "-p", str(pdf_path),
        "-o", str(work_dir),
        "-m", "auto",
    ]
    log.info("mineru.subprocess.start", cmd=" ".join(cmd))
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    stdout, stderr = await proc.communicate()
    if proc.returncode != 0:
        raise RuntimeError(
            f"magic-pdf failed (exit {proc.returncode}): {stderr.decode()[:500]}"
        )
    # MinerU output: <work_dir>/<pdf_stem>/auto/<pdf_stem>.md
    stem = pdf_path.stem
    md_file = work_dir / stem / "auto" / f"{stem}.md"
    if not md_file.exists():
        candidates = list(work_dir.rglob("*.md"))
        if not candidates:
            raise RuntimeError(f"MinerU produced no markdown output in {work_dir}")
        md_file = candidates[0]
    return md_file.read_text(encoding="utf-8")


async def parse_pdf(
    pdf_path: Path, *, force_path: str | None = None, work_dir: Path | None = None,
) -> ParseResult:
    """Parsea el PDF eligiendo automáticamente fast vs full (override con force_path).

    Returns:
        ParseResult con markdown + metadata. Errores se propagan (caller
        captura y mapea a indexing_failure_reason).
    """
    start = time.monotonic()
    h = run_heuristics(pdf_path)
    path = _decide_path(h, force_path)

    if path == "fast":
        md = _parse_native(pdf_path)
        parser_used = "native"
    else:
        wd = work_dir or Path("/tmp") / f"mineru_{pdf_path.stem}"
        try:
            md = await _parse_mineru(pdf_path, wd)
        finally:
            shutil.rmtree(wd, ignore_errors=True)
        parser_used = "mineru"

    elapsed = time.monotonic() - start
    return ParseResult(
        markdown=md,
        parser_used=parser_used,
        path_used=path,
        page_count=h.page_count,
        heuristics=h,
        elapsed_seconds=elapsed,
    )
