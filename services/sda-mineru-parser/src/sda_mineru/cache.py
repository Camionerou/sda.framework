"""Cache LRU local por sha256. Spec §1.2 mecanismo #6.

Sirve dos propósitos:
- Idempotencia para re-enqueues del mismo PDF
- Debugging local (re-correr MinerU sobre un PDF cached sin tocar Supabase)

Eviction: por tamaño total (LRU) y por edad (TTL).
"""

import shutil
import time
from dataclasses import dataclass
from pathlib import Path

import structlog

log = structlog.get_logger()


@dataclass
class _Entry:
    sha256: str
    path: Path
    size: int
    last_access: float


class LocalLRUCache:
    """Cache de PDFs por sha256 en filesystem local.

    NO thread-safe (asumimos uvicorn single-worker en el servicio).
    Si en el futuro corren múltiples workers, agregar advisory lock por filename.
    """

    def __init__(
        self,
        root: Path,
        max_total_bytes: int = 5 * 1024**3,  # 5 GB default
        max_age_seconds: int = 86400,         # 24h default
    ):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        self.max_total_bytes = max_total_bytes
        self.max_age_seconds = max_age_seconds

    def _path_for(self, sha256: str) -> Path:
        return self.root / f"{sha256}.pdf"

    def get(self, sha256: str) -> Path | None:
        p = self._path_for(sha256)
        if not p.exists():
            return None
        p.touch()  # mtime = ahora (refresh LRU)
        return p

    def put(self, sha256: str, src: Path) -> Path:
        dst = self._path_for(sha256)
        if dst.exists():
            dst.touch()
            return dst
        shutil.copy2(src, dst)
        # copy2 preserves src mtime; touch so LRU reflects insertion time, not src time.
        dst.touch()
        log.info("cache.put", sha256=sha256[:8], bytes=dst.stat().st_size)
        self._evict_if_needed()
        return dst

    def _scan(self) -> list[_Entry]:
        entries: list[_Entry] = []
        for p in self.root.glob("*.pdf"):
            stat = p.stat()
            entries.append(_Entry(
                sha256=p.stem, path=p, size=stat.st_size, last_access=stat.st_mtime,
            ))
        return entries

    def _evict_if_needed(self) -> None:
        entries = self._scan()
        total = sum(e.size for e in entries)
        if total <= self.max_total_bytes:
            return
        entries.sort(key=lambda e: e.last_access)
        for e in entries:
            if total <= self.max_total_bytes:
                break
            log.info("cache.evict.size", sha256=e.sha256[:8], bytes=e.size)
            e.path.unlink()
            total -= e.size

    def cleanup_expired(self) -> int:
        now = time.time()
        removed = 0
        for e in self._scan():
            age = now - e.last_access
            if age > self.max_age_seconds:
                log.info("cache.evict.age", sha256=e.sha256[:8], age_seconds=int(age))
                e.path.unlink()
                removed += 1
        return removed
