from __future__ import annotations

import os


def _version(name: str, fallback: str) -> str:
    return os.getenv(name, fallback)


SYSTEM_COMPONENT_VERSIONS = {
    "app": "0.1.7",
    "chat_agent": "0.0.0",
    "compute_gateway_extraction": "0.1.4",
    "embedding_pipeline": "0.0.0",
    "extraction_pipeline": "0.1.7",
    "indexing_pipeline": "0.1.8",
    "inngest_indexing_workflow": "0.1.6",
    "tree_indexer_python": _version("SDA_TREE_INDEXER_VERSION", "0.1.4"),
    "tree_prompt": _version("SDA_TREE_PROMPT_VERSION", "0.1.2"),
}

TREE_INDEXER_PYTHON_ID = "sda-pageindex-python-langgraph"
TREE_INDEXER_PYTHON_VERSION = (
    f"{TREE_INDEXER_PYTHON_ID}-v{SYSTEM_COMPONENT_VERSIONS['tree_indexer_python']}"
)

INDEXING_VERSION_COLUMNS = {
    "embedding_pipeline_version": SYSTEM_COMPONENT_VERSIONS["embedding_pipeline"],
    "extraction_pipeline_version": SYSTEM_COMPONENT_VERSIONS["extraction_pipeline"],
    "indexing_pipeline_version": SYSTEM_COMPONENT_VERSIONS["indexing_pipeline"],
    "tree_indexer_version": SYSTEM_COMPONENT_VERSIONS["tree_indexer_python"],
}

TREE_PROMPT_VERSION = SYSTEM_COMPONENT_VERSIONS["tree_prompt"]


def version_value(versions: dict[str, str] | None, key: str, fallback: str) -> str:
    value = (versions or {}).get(key)
    return value if isinstance(value, str) and value else fallback
