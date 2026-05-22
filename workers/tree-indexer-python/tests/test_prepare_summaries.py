import unittest


def _three_node_tree():
    return [
        {
            "node_id": "0000",
            "title": "Cap 1",
            "start_index": 1,
            "end_index": 3,
            "nodes": [
                {"node_id": "0001", "title": "Sub 1.1", "start_index": 1, "end_index": 2, "nodes": []},
            ],
        },
        {
            "node_id": "0002",
            "title": "Cap 2",
            "start_index": 4,
            "end_index": 5,
            "nodes": [],
        },
    ]


class PrepareSummariesTests(unittest.TestCase):
    def test_sets_tree_node_count_in_metrics(self):
        from app.tree_graph.nodes.prepare_summaries import prepare_summaries

        state = {"document_id": "doc1", "metrics": {}, "tree": _three_node_tree()}
        result = prepare_summaries(state)
        # tree has 3 nodes total (Cap1 + Sub1.1 + Cap2)
        self.assertEqual(result["metrics"]["tree_node_count"], 3)

    def test_empty_tree_gives_zero_count(self):
        from app.tree_graph.nodes.prepare_summaries import prepare_summaries

        state = {"document_id": "doc1", "metrics": {}, "tree": []}
        result = prepare_summaries(state)
        self.assertEqual(result["metrics"]["tree_node_count"], 0)
