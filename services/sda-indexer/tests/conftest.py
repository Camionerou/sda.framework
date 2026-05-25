import asyncio
import os
import pytest


@pytest.fixture(scope="session")
def event_loop():
    """Single event loop for the whole test session."""
    loop = asyncio.new_event_loop()
    yield loop
    loop.close()


@pytest.fixture
def tiny_md_path(tmp_path):
    """Path to a small fixture markdown file."""
    return os.path.join(os.path.dirname(__file__), "fixtures", "tiny.md")


@pytest.fixture
def nested_md_path():
    return os.path.join(os.path.dirname(__file__), "fixtures", "nested.md")
