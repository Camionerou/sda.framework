import unittest

from app.llm import TreeLlmPermanentError, TreeLlmTransientError, TRANSIENT_STATUS


class LlmErrorClassificationTests(unittest.TestCase):
    def test_transient_statuses_known(self):
        for status in (408, 425, 429, 500, 502, 503, 504):
            self.assertIn(status, TRANSIENT_STATUS)

    def test_transient_error_carries_status(self):
        error = TreeLlmTransientError(429, "rate limited")
        self.assertEqual(error.status_code, 429)
        self.assertEqual(str(error), "rate limited")

    def test_permanent_error_carries_status(self):
        error = TreeLlmPermanentError(400, "bad request")
        self.assertEqual(error.status_code, 400)
        self.assertEqual(str(error), "bad request")
