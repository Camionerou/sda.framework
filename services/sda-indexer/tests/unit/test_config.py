import os
import pytest
from sda_indexer.config import Settings


def test_settings_reads_env(monkeypatch):
    monkeypatch.setenv("SDA_SUPABASE_URL", "https://test.supabase.co")
    monkeypatch.setenv("SDA_SUPABASE_SERVICE_KEY", "test-key")
    monkeypatch.setenv("SDA_DEEPSEEK_API_KEY", "ds-test")
    monkeypatch.setenv("SDA_SRV_IA_01_SECRET", "bearer-test")
    monkeypatch.setenv("SDA_DB_DSN", "postgresql://test/db")
    monkeypatch.setenv("SDA_MINERU_SHARED_SECRET", "mineru-test")
    s = Settings()
    assert s.supabase_url == "https://test.supabase.co"
    assert s.deepseek_api_key.get_secret_value() == "ds-test"
    assert s.env == "local"  # default


def test_settings_missing_required_fails():
    # Sin envs, debe fallar al construir
    for k in ["SDA_SUPABASE_URL","SDA_SUPABASE_SERVICE_KEY",
              "SDA_DEEPSEEK_API_KEY","SDA_SRV_IA_01_SECRET","SDA_DB_DSN"]:
        os.environ.pop(k, None)
    with pytest.raises(Exception):
        Settings()
