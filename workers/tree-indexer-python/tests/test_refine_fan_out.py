import unittest

from app.tree_graph.routing import fan_out_refine_targets


def _state_with_two_large_nodes() -> dict:
    return {
        "document_id": "doc1",
        "document_title": "Titulo",
        "document_type": "report",
        "job_id": "job1",
        "metrics": {},
        "raw_pages": [
            {"page": i, "text": f"page {i} " * 5000}
            for i in range(1, 25)
        ],
        "prompt_pages": [
            {"page": i, "text": f"page {i} " * 5000}
            for i in range(1, 25)
        ],
        "refined_results": [],
        "refinement_iteration": 0,
        "run_id": "run1",
        "tenant_id": "tenant1",
        "tree": [
            {
                "end_index": 12,
                "node_id": "0000",
                "nodes": [],
                "start_index": 1,
                "summary": "",
                "text": "x" * 50000,
                "title": "Capitulo 1",
            },
            {
                "end_index": 24,
                "node_id": "0001",
                "nodes": [],
                "start_index": 13,
                "summary": "",
                "text": "y" * 50000,
                "title": "Capitulo 2",
            },
        ],
    }


class RefineFanOutTests(unittest.TestCase):
    def test_emits_one_send_per_large_node(self):
        sends = fan_out_refine_targets(_state_with_two_large_nodes())
        self.assertEqual(len(sends), 2)
        for send in sends:
            self.assertEqual(send.node, "refine_one_node")
            self.assertIn("refine_target_node_id", send.arg)
            self.assertIn("refine_target_pages", send.arg)
            self.assertIn("refine_target_start_index", send.arg)

    def test_emits_no_sends_when_no_large_nodes(self):
        # Nodes with few pages and short text don't qualify as large
        state = {
            **_state_with_two_large_nodes(),
            "tree": [
                {
                    "end_index": 2,
                    "node_id": "0000",
                    "nodes": [],
                    "start_index": 1,
                    "summary": "",
                    "text": "short",
                    "title": "Capitulo 1",
                },
                {
                    "end_index": 4,
                    "node_id": "0001",
                    "nodes": [],
                    "start_index": 3,
                    "summary": "",
                    "text": "short",
                    "title": "Capitulo 2",
                },
            ],
        }
        sends = fan_out_refine_targets(state)
        self.assertEqual(sends, [])


if __name__ == "__main__":
    unittest.main()
