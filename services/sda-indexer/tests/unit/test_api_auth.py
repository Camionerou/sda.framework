import pytest
from fastapi import FastAPI, Depends
from fastapi.testclient import TestClient
from sda_indexer.api.auth import require_bearer


def make_app(token: str):
    app = FastAPI()
    @app.get("/protected", dependencies=[Depends(require_bearer(token))])
    def ok():
        return {"ok": True}
    return app


def test_missing_header_401():
    app = make_app("secret123")
    client = TestClient(app)
    r = client.get("/protected")
    assert r.status_code == 401


def test_wrong_token_401():
    app = make_app("secret123")
    client = TestClient(app)
    r = client.get("/protected", headers={"Authorization": "Bearer wrong"})
    assert r.status_code == 401


def test_correct_token_200():
    app = make_app("secret123")
    client = TestClient(app)
    r = client.get("/protected", headers={"Authorization": "Bearer secret123"})
    assert r.status_code == 200
