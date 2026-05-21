from __future__ import annotations

import json
import os
from pathlib import Path


def _load_versions() -> dict[str, str]:
    candidates = [
        os.getenv("SDA_SYSTEM_VERSIONS_FILE"),
        Path(__file__).resolve().parents[3] / "lib" / "system-versions.json",
        Path(__file__).resolve().parents[1] / "system-versions.json",
    ]

    for candidate in candidates:
        if not candidate:
            continue

        try:
            with open(candidate, encoding="utf-8") as source:
                data = json.load(source)
        except OSError:
            continue

        return {key: value for key, value in data.items() if isinstance(value, str)}

    return {}


def _version(name: str, fallback: str) -> str:
    return os.getenv(name, fallback)


_VERSIONS = _load_versions()

SYSTEM_COMPONENT_VERSIONS = {
    **_VERSIONS,
    "tree_indexer_python": _version(
        "SDA_TREE_INDEXER_VERSION",
        _VERSIONS.get("tree_indexer_python", "0.0.0"),
    ),
    "tree_prompt": _version(
        "SDA_TREE_PROMPT_VERSION",
        _VERSIONS.get("tree_prompt", "0.0.0"),
    ),
}

TREE_INDEXER_PYTHON_ID = "sda-pageindex-python-langgraph"
TREE_INDEXER_PYTHON_VERSION = (
    f"{TREE_INDEXER_PYTHON_ID}-v{SYSTEM_COMPONENT_VERSIONS['tree_indexer_python']}"
)

INDEXING_VERSION_COLUMNS = {
    "embedding_pipeline_version": SYSTEM_COMPONENT_VERSIONS.get(
        "embedding_pipeline",
        "0.0.0",
    ),
    "extraction_pipeline_version": SYSTEM_COMPONENT_VERSIONS.get(
        "extraction_pipeline",
        "0.0.0",
    ),
    "indexing_pipeline_version": SYSTEM_COMPONENT_VERSIONS.get(
        "indexing_pipeline",
        "0.0.0",
    ),
    "tree_indexer_version": SYSTEM_COMPONENT_VERSIONS["tree_indexer_python"],
}

TREE_PROMPT_VERSION = SYSTEM_COMPONENT_VERSIONS["tree_prompt"]


def version_value(versions: dict[str, str] | None, key: str, fallback: str) -> str:
    value = (versions or {}).get(key)
    return value if isinstance(value, str) and value else fallback
