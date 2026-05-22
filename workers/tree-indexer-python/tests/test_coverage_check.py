import asyncio
import unittest

from app.tree_graph.nodes.coverage_check import coverage_check


def _run(coro):
    return asyncio.run(coro)


def _state_with_gap() -> dict:
    return {
        "metrics": {},
        "raw_pages": [{"page": i, "text": ""} for i in range(1, 11)],
        "tree": [
            {"node_id": "0000", "start_index": 1, "end_index": 3, "nodes": [], "title": "A"},
            {"node_id": "0001", "start_index": 7, "end_index": 10, "nodes": [], "title": "B"},
        ],
    }


def _state_full_coverage() -> dict:
    return {
        "metrics": {},
        "raw_pages": [{"page": i, "text": ""} for i in range(1, 6)],
        "tree": [{"node_id": "0000", "start_index": 1, "end_index": 5, "nodes": [], "title": "A"}],
    }


class CoverageCheckTests(unittest.TestCase):
    def test_creates_orphan_for_gaps(self):
        result = _run(coverage_check(_state_with_gap()))
        titles = [n["title"] for n in result["tree"]]
        self.assertTrue(any("4-6" in t for t in titles))
        self.assertTrue(result["metrics"]["coverage_gap"])

    def test_no_orphan_when_full(self):
        result = _run(coverage_check(_state_full_coverage()))
        self.assertEqual(len(result["tree"]), 1)
        self.assertEqual(result["metrics"]["coverage_ratio"], 1.0)
