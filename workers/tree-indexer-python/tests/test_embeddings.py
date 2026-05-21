import unittest

from app.embeddings import hierarchy_embedding_text


class EmbeddingTests(unittest.TestCase):
    def test_hierarchy_embedding_text_prefers_routing_summary(self) -> None:
        text = hierarchy_embedding_text(
            {
                "chunk_index": 0,
                "content": "Long body content",
                "embedding": None,
                "embedding_model": None,
                "metadata": {},
                "node_id": "0001",
                "node_path": ["Contract", "Payment Terms"],
                "page_end": 3,
                "page_start": 2,
                "routing_summary": "Questions about payment deadlines and penalties.",
                "summary": "This section explains payment terms.",
                "token_count": 10,
            },
            "contract",
        )

        self.assertIn("Document type: contract", text)
        self.assertIn("Path: Contract > Payment Terms", text)
        self.assertIn("Questions about payment deadlines", text)
        self.assertNotIn("Long body content", text)

    def test_hierarchy_embedding_text_falls_back_to_summary(self) -> None:
        text = hierarchy_embedding_text(
            {
                "chunk_index": 0,
                "content": "Fallback body",
                "embedding": None,
                "embedding_model": None,
                "metadata": {},
                "node_id": "0001",
                "node_path": ["Report", "Findings"],
                "page_end": 4,
                "page_start": 1,
                "routing_summary": None,
                "summary": "Finding summary",
                "token_count": 10,
            },
            "report",
        )

        self.assertIn("Finding summary", text)
        self.assertNotIn("Fallback body", text)


if __name__ == "__main__":
    unittest.main()
