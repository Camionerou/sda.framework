"""Health check. Verifica que el process está vivo. NO hace test download
(Wave 2 puede agregar deep healthz)."""

import shutil
from pathlib import Path
from pydantic import BaseModel


class HealthStatus(BaseModel):
    ok: bool
    version: str
    cache_dir: str
    free_disk_gb: float


def check_health(cache_dir: Path, version: str = "0.1.0") -> HealthStatus:
    stat = shutil.disk_usage(cache_dir if cache_dir.exists() else cache_dir.parent)
    return HealthStatus(
        ok=True,
        version=version,
        cache_dir=str(cache_dir),
        free_disk_gb=round(stat.free / (1024**3), 2),
    )
