"""Descarga resiliente de PDFs desde Supabase Storage. Spec §1.2.

Mecanismos:
- Streaming chunks a disco (nunca PDF entero en memoria)
- SHA256 validation end-to-end
- HTTP Range resume para PDFs >range_resume_min_mb
- Retries con tenacity (exponential backoff + jitter)
- Pre-check de espacio en disco
"""

import hashlib
import shutil
from dataclasses import dataclass
from pathlib import Path

import aiofiles
import httpx
import structlog
from tenacity import (
    AsyncRetrying,
    retry_if_exception_type,
    retry_if_not_exception_type,
    stop_after_attempt,
    wait_exponential_jitter,
)

log = structlog.get_logger()


@dataclass(frozen=True)
class DownloadConfig:
    max_retries: int = 5
    backoff_base_seconds: int = 2
    range_resume_min_mb: int = 5
    chunk_size_kb: int = 1024
    timeout_seconds: int = 600
    min_free_gb: float = 2.0


class DownloadError(Exception):
    """Falla persistente de descarga (después de retries)."""


class Sha256MismatchError(DownloadError):
    """El SHA256 calculado no matchea el esperado."""


class DiskFullError(DownloadError):
    """Espacio en disco insuficiente para la descarga."""


class ExpiredSignedUrlError(DownloadError):
    """410 Gone — el signed URL expiró, indexer debe regenerar."""


def _check_disk_space(dst_path: Path, min_free_gb: float) -> None:
    stat = shutil.disk_usage(dst_path.parent)
    free_gb = stat.free / (1024**3)
    if free_gb < min_free_gb:
        raise DiskFullError(
            f"Disk {dst_path.parent}: {free_gb:.1f}GB free, need {min_free_gb}GB"
        )


async def _stream_download(
    url: str, dst_path: Path, chunk_size: int, timeout: int, start_byte: int = 0
) -> None:
    """Descarga streaming. Si start_byte>0, usa Range request."""
    headers = {"Range": f"bytes={start_byte}-"} if start_byte > 0 else {}
    mode = "ab" if start_byte > 0 else "wb"

    async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as client:
        async with client.stream("GET", url, headers=headers) as resp:
            if resp.status_code == 410:
                raise ExpiredSignedUrlError(f"410 Gone: {url}")
            if start_byte > 0 and resp.status_code != 206:
                # Server no soporta Range, re-descargar desde cero
                log.warning("download.range_unsupported", status=resp.status_code)
                raise DownloadError(f"Range not supported (got {resp.status_code})")
            if resp.status_code >= 400:
                raise DownloadError(f"HTTP {resp.status_code}: {url}")

            async with aiofiles.open(dst_path, mode) as f:
                async for chunk in resp.aiter_bytes(chunk_size):
                    await f.write(chunk)


def _sha256_file(path: Path, chunk_size: int = 1024 * 1024) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while chunk := f.read(chunk_size):
            h.update(chunk)
    return h.hexdigest()


async def download_with_resume(
    *,
    url: str,
    expected_sha256: str,
    dst_path: Path,
    config: DownloadConfig,
) -> None:
    """Descarga `url` a `dst_path`. Valida sha256. Maneja Range resume.

    Raises:
        Sha256MismatchError: el hash calculado no matchea el esperado.
        ExpiredSignedUrlError: 410 Gone — el caller debe regenerar URL.
        DiskFullError: <min_free_gb disponible.
        DownloadError: falla persistente otra (después de retries).
    """
    dst_path.parent.mkdir(parents=True, exist_ok=True)
    _check_disk_space(dst_path, config.min_free_gb)

    chunk = config.chunk_size_kb * 1024
    range_threshold = config.range_resume_min_mb * 1024 * 1024

    async for attempt in AsyncRetrying(
        stop=stop_after_attempt(config.max_retries),
        wait=wait_exponential_jitter(initial=config.backoff_base_seconds, max=32),
        retry=(
            retry_if_exception_type((httpx.HTTPError, DownloadError))
            & retry_if_not_exception_type(ExpiredSignedUrlError)
        ),
        reraise=True,
    ):
        with attempt:
            # Si existe parcial y supera el threshold, intentar Range resume
            start_byte = 0
            if dst_path.exists():
                existing = dst_path.stat().st_size
                if existing >= range_threshold:
                    start_byte = existing
                    log.info("download.resume", url=url, from_byte=start_byte)
                else:
                    dst_path.unlink()  # re-descargar desde cero para chicos

            try:
                await _stream_download(
                    url=url,
                    dst_path=dst_path,
                    chunk_size=chunk,
                    timeout=config.timeout_seconds,
                    start_byte=start_byte,
                )
            except ExpiredSignedUrlError:
                raise  # No retry — caller regenera URL
            except DownloadError:
                # Range fallback: reseteamos y reintentamos desde 0
                if dst_path.exists():
                    dst_path.unlink()
                raise

    # Verify sha256 después de descarga completa
    actual_sha = _sha256_file(dst_path)
    if actual_sha != expected_sha256:
        dst_path.unlink(missing_ok=True)
        raise Sha256MismatchError(
            f"SHA256 mismatch: expected {expected_sha256[:16]}..., got {actual_sha[:16]}..."
        )

    log.info("download.complete", url=url, bytes=dst_path.stat().st_size)
