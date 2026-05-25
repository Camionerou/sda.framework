import pytest
from sda_indexer.settings.types import SettingDef


def test_setting_def_frozen():
    s = SettingDef(
        key="llm.model.summarize",
        value_type="model_id",
        default="deepseek/deepseek-v4-flash",
        description="test",
        scopes=["global"],
    )
    assert s.key == "llm.model.summarize"
    assert s.default == "deepseek/deepseek-v4-flash"
    with pytest.raises(Exception):
        s.key = "other"  # frozen


def test_setting_def_with_validation():
    s = SettingDef(
        key="pgmq.visibility_timeout",
        value_type="duration_ms",
        default=60000,
        description="",
        scopes=["global"],
        validation={"type": "integer", "minimum": 1000},
    )
    assert s.validation == {"type": "integer", "minimum": 1000}


def test_setting_def_secret():
    s = SettingDef(
        key="alerts.slack_webhook_url",
        value_type="string",
        default="",
        description="",
        scopes=["global"],
        is_secret=True,
    )
    assert s.is_secret is True
