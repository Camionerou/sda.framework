import os
from fastapi.testclient import TestClient
import pytest


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("SDA_MINERU_CACHE_DIR", str(tmp_path / "cache"))
    monkeypatch.setenv("MINERU_SHARED_SECRET", "testsecret")
    from sda_mineru.main import app
    return TestClient(app)


def test_healthz_returns_ok(client):
    r = client.get("/healthz")
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert body["version"]


def test_parse_requires_auth(client):
    r = client.post("/parse", json={
        "doc_id": "x",
        "signed_url": "http://localhost/nope",
        "expected_sha256": "0" * 64,
    })
    assert r.status_code == 401


def test_parse_with_bad_auth(client):
    r = client.post(
        "/parse",
        headers={"Authorization": "Bearer wrong"},
        json={
            "doc_id": "x",
            "signed_url": "http://localhost/nope",
            "expected_sha256": "0" * 64,
        },
    )
    assert r.status_code == 401
