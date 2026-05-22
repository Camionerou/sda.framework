import unittest

from app.tree_graph.helpers import compute_node_confidence


class ConfidenceTests(unittest.TestCase):
    def test_score_when_verified_and_title_matches(self):
        node = {"start_index": 1, "end_index": 3, "title": "Introduccion"}
        pages = [
            {"page": 1, "text": "Introduccion\nContenido"},
            {"page": 2, "text": ""},
            {"page": 3, "text": ""},
        ]
        score = compute_node_confidence(
            node=node, pages=pages, source_blocks=[], verifier_says_valid=True
        )
        self.assertGreaterEqual(score, 0.8)

    def test_low_when_title_missing(self):
        node = {"start_index": 1, "end_index": 3, "title": "Inexistente"}
        pages = [
            {"page": 1, "text": "Otro texto"},
            {"page": 2, "text": ""},
            {"page": 3, "text": ""},
        ]
        score = compute_node_confidence(
            node=node, pages=pages, source_blocks=[], verifier_says_valid=None
        )
        self.assertLessEqual(score, 0.5)
