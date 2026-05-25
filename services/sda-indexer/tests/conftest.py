import asyncio
import hashlib
import os
from dataclasses import dataclass
from pathlib import Path

import httpx
import pytest
import yaml


@pytest.fixture(scope="session")
def event_loop():
    """Single event loop for the whole test session."""
    loop = asyncio.new_event_loop()
    yield loop
    loop.close()


@pytest.fixture
def tiny_md_path(tmp_path):
    """Path to a small fixture markdown file."""
    return os.path.join(os.path.dirname(__file__), "fixtures", "tiny.md")


@pytest.fixture
def nested_md_path():
    return os.path.join(os.path.dirname(__file__), "fixtures", "nested.md")


# ============================================================================
# Wave 1 §6.3 — canonical_corpus fixture
# ============================================================================


CORPUS_CACHE = Path("~/.cache/sda-test-corpus").expanduser()


@dataclass(frozen=True)
class CorpusEntry:
    id: str
    url: str
    sha256: str
    license: str
    local_path: Path
    expected: dict


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while chunk := f.read(1024 * 1024):
            h.update(chunk)
    return h.hexdigest()


@pytest.fixture(scope="session")
def canonical_corpus():
    """Descarga (cached) y devuelve el manifest del corpus canonical."""
    manifest_path = Path(__file__).parent / "fixtures" / "pdf_corpus.yaml"
    if not manifest_path.exists():
        pytest.skip("pdf_corpus.yaml no existe — corpus no anotado")
    manifest = yaml.safe_load(manifest_path.read_text())

    CORPUS_CACHE.mkdir(parents=True, exist_ok=True)
    out: list[CorpusEntry] = []
    for entry in manifest["pdfs"]:
        if entry["url"].startswith("REEMPLAZAR"):
            continue  # skip unannotated
        local = CORPUS_CACHE / f"{entry['id']}.pdf"
        if not local.exists() or _sha256(local) != entry["sha256"]:
            with httpx.stream("GET", entry["url"], timeout=120, follow_redirects=True) as resp:
                resp.raise_for_status()
                with open(local, "wb") as f:
                    for chunk in resp.iter_bytes(1024 * 1024):
                        f.write(chunk)
            actual = _sha256(local)
            if actual != entry["sha256"]:
                pytest.fail(
                    f"Corpus {entry['id']}: expected sha {entry['sha256'][:16]}..., "
                    f"got {actual[:16]}... — URL changed?"
                )
        out.append(CorpusEntry(
            id=entry["id"], url=entry["url"], sha256=entry["sha256"],
            license=entry["license"], local_path=local, expected=entry["expected"],
        ))
    return out


@pytest.fixture(scope="session")
def corpus_by_id(canonical_corpus):
    return {e.id: e for e in canonical_corpus}
