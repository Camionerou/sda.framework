"""Tests reales contra el dev server local. NO mocks (CLAUDE.md)."""

import asyncio
import functools
import hashlib
import http.server
import socketserver
import threading
from pathlib import Path

import pytest

from sda_mineru.download import (
    DownloadConfig,
    DownloadError,
    Sha256MismatchError,
    download_with_resume,
)


@pytest.fixture
def http_server(tmp_path):
    """Sirve tmp_path/*.pdf en localhost. Soporta Range requests."""
    serve_dir = tmp_path
    handler = functools.partial(
        http.server.SimpleHTTPRequestHandler, directory=str(serve_dir)
    )

    httpd = socketserver.TCPServer(("127.0.0.1", 0), handler)
    port = httpd.server_address[1]
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()

    yield f"http://127.0.0.1:{port}", serve_dir

    httpd.shutdown()
    httpd.server_close()


async def test_download_succeeds_for_small_file(tmp_path, http_server):
    url_base, serve_dir = http_server
    src = serve_dir / "tiny.pdf"
    payload = b"%PDF-1.4\n" + b"x" * 100
    src.write_bytes(payload)
    sha = hashlib.sha256(payload).hexdigest()

    dst = tmp_path / "downloaded.pdf"
    cfg = DownloadConfig(max_retries=3, chunk_size_kb=4)
    await download_with_resume(
        url=f"{url_base}/tiny.pdf",
        expected_sha256=sha,
        dst_path=dst,
        config=cfg,
    )
    assert dst.read_bytes() == payload


async def test_download_raises_on_sha_mismatch(tmp_path, http_server):
    url_base, serve_dir = http_server
    src = serve_dir / "bad.pdf"
    src.write_bytes(b"%PDF-1.4\nbogus")
    wrong_sha = "0" * 64

    dst = tmp_path / "downloaded.pdf"
    cfg = DownloadConfig(max_retries=1, chunk_size_kb=4)
    with pytest.raises(Sha256MismatchError):
        await download_with_resume(
            url=f"{url_base}/bad.pdf",
            expected_sha256=wrong_sha,
            dst_path=dst,
            config=cfg,
        )


async def test_download_raises_on_404(tmp_path, http_server):
    url_base, _ = http_server
    dst = tmp_path / "downloaded.pdf"
    cfg = DownloadConfig(max_retries=2, chunk_size_kb=4)
    with pytest.raises(DownloadError):
        await download_with_resume(
            url=f"{url_base}/nonexistent.pdf",
            expected_sha256="0" * 64,
            dst_path=dst,
            config=cfg,
        )
