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

    def test_score_with_source_block_overlap(self):
        node = {"start_index": 1, "end_index": 4, "title": "X"}
        pages = [{"page": i, "text": ""} for i in range(1, 5)]
        source_blocks = [
            {"page": 1, "bbox": [0, 0, 1, 1], "kind": "text"},
            {"page": 2, "bbox": [0, 0, 1, 1], "kind": "text"},
            {"page": 3, "bbox": [0, 0, 1, 1], "kind": "text"},
        ]
        # verifier=True (+0.5) + no title match (title "X" no aparece) + overlap 3/4=0.75 >= 0.5 (+0.2) = 0.7
        score = compute_node_confidence(
            node=node, pages=pages, source_blocks=source_blocks, verifier_says_valid=True
        )
        self.assertEqual(score, 0.7)
