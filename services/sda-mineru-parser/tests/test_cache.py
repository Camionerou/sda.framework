import time
from pathlib import Path

import pytest

from sda_mineru.cache import LocalLRUCache


def test_get_returns_none_for_missing(tmp_path):
    cache = LocalLRUCache(root=tmp_path, max_total_bytes=10_000, max_age_seconds=3600)
    assert cache.get("abcd") is None


def test_put_and_get_returns_path(tmp_path):
    cache = LocalLRUCache(root=tmp_path, max_total_bytes=10_000, max_age_seconds=3600)
    src = tmp_path / "src.pdf"
    src.write_bytes(b"%PDF-1.4 hello")
    cached_path = cache.put("abcd1234", src)
    assert cached_path.exists()
    assert cache.get("abcd1234") == cached_path


def test_evicts_when_over_size(tmp_path):
    cache = LocalLRUCache(root=tmp_path, max_total_bytes=100, max_age_seconds=3600)
    big_a = tmp_path / "a.pdf"
    big_a.write_bytes(b"x" * 80)
    cache.put("a" * 64, big_a)

    # tmp_path is used as both source dir and cache root; shutil.copy2 preserves
    # mtime, so source files and their cached copies tie on mtime. Sleep ensures
    # `b` has strictly later mtime than `a` so LRU eviction is deterministic.
    time.sleep(0.01)

    big_b = tmp_path / "b.pdf"
    big_b.write_bytes(b"y" * 80)
    cache.put("b" * 64, big_b)

    # `a` debería haber sido evictada (LRU)
    assert cache.get("a" * 64) is None
    assert cache.get("b" * 64) is not None


def test_evicts_when_too_old(tmp_path):
    cache = LocalLRUCache(root=tmp_path, max_total_bytes=10_000, max_age_seconds=1)
    src = tmp_path / "old.pdf"
    src.write_bytes(b"hello")
    cache.put("c" * 64, src)
    time.sleep(1.5)
    cache.cleanup_expired()
    assert cache.get("c" * 64) is None
