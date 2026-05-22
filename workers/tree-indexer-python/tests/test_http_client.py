import unittest

from app.http_client import get_llm_client, get_llm_semaphore, get_supabase_client


class HttpClientPoolTests(unittest.TestCase):
    def test_llm_client_singleton(self):
        a = get_llm_client()
        b = get_llm_client()
        self.assertIs(a, b)

    def test_supabase_client_singleton(self):
        a = get_supabase_client()
        b = get_supabase_client()
        self.assertIs(a, b)

    def test_semaphore_has_positive_capacity(self):
        sem = get_llm_semaphore()
        self.assertGreater(sem._value, 0)
