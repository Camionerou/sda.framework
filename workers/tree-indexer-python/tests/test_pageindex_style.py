import unittest

from app.pageindex_style import (
    build_chunks_from_tree,
    candidate_sections_to_tree,
    content_list_to_labeled_pages,
    remove_node_text,
    tagged_pages_text,
)


class PageIndexStyleTests(unittest.TestCase):
    def test_content_list_to_labeled_pages_preserves_page_order(self) -> None:
        pages = content_list_to_labeled_pages(
            [
                {"bbox": [0, 20], "page_idx": 1, "text": "B", "type": "text"},
                {"bbox": [0, 10], "page_idx": 0, "text": "A", "type": "text"},
                {
                    "bbox": [0, 30],
                    "image_footnote": ["caption"],
                    "page_idx": 1,
                    "type": "image",
                },
            ]
        )

        self.assertEqual(
            pages,
            [
                {"page": 1, "text": "A"},
                {"page": 2, "text": "B\n\ncaption"},
            ],
        )
        self.assertEqual(
            tagged_pages_text(pages[:1]),
            "<physical_index_1>\nA\n<physical_index_1>",
        )

    def test_candidate_sections_to_tree_uses_pageindex_ranges(self) -> None:
        pages = [
            {"page": 1, "text": "Intro"},
            {"page": 2, "text": "Chapter"},
            {"page": 3, "text": "Section"},
        ]
        tree = candidate_sections_to_tree(
            [
                {
                    "appear_start": "yes",
                    "physical_index": "<physical_index_1>",
                    "structure": "1",
                    "title": "Intro",
                },
                {
                    "appear_start": "yes",
                    "physical_index": "<physical_index_2>",
                    "structure": "2",
                    "title": "Chapter",
                },
                {
                    "appear_start": "no",
                    "physical_index": "<physical_index_3>",
                    "structure": "2.1",
                    "title": "Section",
                },
            ],
            pages,
        )

        self.assertEqual(tree[0]["start_index"], 1)
        self.assertEqual(tree[0]["end_index"], 1)
        self.assertEqual(tree[1]["nodes"][0]["start_index"], 3)
        self.assertEqual(tree[1]["nodes"][0]["end_index"], 3)

        chunks = build_chunks_from_tree(tree)
        self.assertEqual([chunk["node_id"] for chunk in chunks], ["0000", "0001", "0002"])
        self.assertIsNone(remove_node_text(tree)[0].get("text"))


if __name__ == "__main__":
    unittest.main()
