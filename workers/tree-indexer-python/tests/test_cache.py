import unittest

from app.cache import CACHE_VERSION, summary_cache_key


class CacheKeyTests(unittest.TestCase):
    def test_key_includes_version(self):
        key = summary_cache_key(
            text="t", title="T", page_start=1, page_end=2,
            summary_model="m", tree_prompt_version="v1.0",
        )
        self.assertTrue(key.startswith(f"tree:summary:{CACHE_VERSION}:"))

    def test_key_changes_with_prompt_version(self):
        a = summary_cache_key(text="t", title="T", page_start=1, page_end=2,
                              summary_model="m", tree_prompt_version="v1")
        b = summary_cache_key(text="t", title="T", page_start=1, page_end=2,
                              summary_model="m", tree_prompt_version="v2")
        self.assertNotEqual(a, b)

    def test_key_changes_with_page_range(self):
        a = summary_cache_key(text="t", title="T", page_start=1, page_end=2,
                              summary_model="m", tree_prompt_version="v")
        b = summary_cache_key(text="t", title="T", page_start=1, page_end=3,
                              summary_model="m", tree_prompt_version="v")
        self.assertNotEqual(a, b)
