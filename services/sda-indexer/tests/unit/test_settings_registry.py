from sda_indexer.settings.registry import SETTINGS, REGISTRY_BY_KEY


def test_registry_has_wave0_keys():
    keys = {s.key for s in SETTINGS}
    # Sample of must-have Wave 0 keys
    assert "llm.model.summarize" in keys
    assert "llm.max_concurrent.deepseek" in keys
    assert "pgmq.visibility_timeout.q_summarize_node" in keys
    assert "summarize.max_summary_chars" in keys


def test_registry_keys_unique():
    keys = [s.key for s in SETTINGS]
    assert len(keys) == len(set(keys)), "duplicated keys in registry"


def test_registry_all_have_global_scope():
    # Wave 0 invariant: cada setting debe tener al menos 'global'
    for s in SETTINGS:
        assert "global" in s.scopes, f"{s.key} missing 'global' scope"


def test_registry_by_key_index():
    s = REGISTRY_BY_KEY.get("llm.model.summarize")
    assert s is not None
    assert s.value_type == "model_id"
