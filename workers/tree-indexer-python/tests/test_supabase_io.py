import unittest

from app.pageindex_style import SOURCE_BLOCKS_COORDINATE_SYSTEM
from app.supabase_io import _doc_tree_node_rows, _ltree_label, _stable_node_uuid


class SupabaseIoTests(unittest.TestCase):
    def test_doc_tree_node_rows_preserve_hierarchy_embeddings_and_metadata(self) -> None:
        tenant_id = "00000000-0000-0000-0000-000000000101"
        document_id = "00000000-0000-0000-0000-000000000301"
        nodes = [
            {
                "end_index": 3,
                "node_id": "0000",
                "nodes": [
                    {
                        "end_index": 3,
                        "node_id": "0001",
                        "routing_summary": "Ask about warranties.",
                        "source_blocks": [{"bbox": [0.1, 0.2, 0.3, 0.4], "kind": "text", "page": 2}],
                        "start_index": 2,
                        "summary": "Warranty details.",
                        "title": "Warranty",
                    }
                ],
                "routing_summary": "Ask about the whole document.",
                "start_index": 1,
                "summary": "Document summary.",
                "title": "Root",
            }
        ]
        chunks = [
            {
                "embedding": [0.01, 0.02],
                "embedding_model": "gemini-embedding-2",
                "metadata": {"run_id": "run-1"},
                "node_id": "0000",
            },
            {
                "embedding": [0.03, 0.04],
                "embedding_model": "gemini-embedding-2",
                "metadata": {"run_id": "run-1"},
                "node_id": "0001",
            },
        ]

        rows = _doc_tree_node_rows(
            chunks=chunks,
            document_id=document_id,
            document_type="contract",
            embedding_pipeline_version="0.1.0",
            indexing_pipeline_version="0.2.0",
            nodes=nodes,
            tenant_id=tenant_id,
            tree_indexer_version="0.3.0",
            tree_prompt_version="0.4.0",
        )

        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0]["id"], _stable_node_uuid(
            tenant_id=tenant_id,
            document_id=document_id,
            node_id="0000",
        ))
        self.assertIsNone(rows[0]["parent_id"])
        self.assertEqual(rows[0]["node_path"], "n0000")
        self.assertEqual(rows[0]["node_type"], "root")
        self.assertEqual(rows[0]["embedding"], [0.01, 0.02])
        self.assertEqual(rows[1]["parent_id"], rows[0]["id"])
        self.assertEqual(rows[1]["node_path"], "n0000.n0001")
        self.assertEqual(rows[1]["node_type"], "leaf")
        self.assertEqual(rows[1]["metadata"]["document_type"], "contract")
        self.assertEqual(rows[1]["metadata"]["page_range"], [2, 3])
        self.assertEqual(rows[1]["metadata"]["source_blocks_coordinate_system"], SOURCE_BLOCKS_COORDINATE_SYSTEM)
        self.assertEqual(rows[1]["routing_summary"], "Ask about warranties.")
        self.assertEqual(rows[1]["tree_prompt_version"], "0.4.0")

    def test_ltree_label_is_safe_for_postgres_ltree(self) -> None:
        self.assertEqual(_ltree_label("01.Intro / Scope"), "n01_intro_scope")


if __name__ == "__main__":
    unittest.main()
