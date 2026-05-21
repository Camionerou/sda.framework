import unittest

from app.pageindex_style import (
    SOURCE_BLOCKS_COORDINATE_SYSTEM,
    build_chunks_from_tree,
    candidate_sections_to_tree,
    content_list_to_labeled_pages,
    remove_node_text,
    source_blocks_from_mineru_middle,
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

        typed_chunks = build_chunks_from_tree(tree, document_type="contract")
        self.assertEqual(typed_chunks[0]["metadata"]["document_type"], "contract")

        tree[0]["routing_summary"] = "Questions about the intro."
        routed_chunks = build_chunks_from_tree(tree, document_type="contract")
        self.assertEqual(routed_chunks[0]["routing_summary"], "Questions about the intro.")
        self.assertEqual(
            remove_node_text(tree)[0]["routing_summary"],
            "Questions about the intro.",
        )

    def test_title_near_page_start_prevents_next_page_contamination(self) -> None:
        pages = [
            {"page": 1, "text": "LOGO AriesTruck specs"},
            {"page": 2, "text": "SALDIVIA FAMILIA Aries30s specs"},
            {"page": 3, "text": ""},
        ]
        tree = candidate_sections_to_tree(
            [
                {
                    "appear_start": "no",
                    "physical_index": "<physical_index_1>",
                    "structure": "1",
                    "title": "AriesTruck",
                },
                {
                    "appear_start": "no",
                    "physical_index": "<physical_index_2>",
                    "structure": "2",
                    "title": "Aries30s",
                },
            ],
            pages,
        )

        self.assertEqual(tree[0]["start_index"], 1)
        self.assertEqual(tree[0]["end_index"], 1)
        self.assertEqual(tree[1]["start_index"], 2)
        self.assertEqual(tree[1]["end_index"], 2)

    def test_source_blocks_from_middle_normalizes_page_bboxes(self) -> None:
        source_blocks = source_blocks_from_mineru_middle(
            {
                "pdf_info": [
                    {
                        "page_idx": 0,
                        "page_size": [200, 400],
                        "para_blocks": [
                            {"bbox": [20, 40, 120, 240], "type": "title"},
                            {"bbox": [150, 20, 150, 60], "type": "text"},
                        ],
                    },
                    {
                        "page_idx": 1,
                        "page_size": [100, 100],
                        "para_blocks": [
                            {"bbox": [10, 10, 90, 90], "type": "table"},
                            {"bbox": [-5, -5, 50, 50], "type": "image"},
                        ],
                    },
                ]
            }
        )

        self.assertEqual(
            source_blocks,
            [
                {"bbox": [0.1, 0.1, 0.6, 0.6], "kind": "text", "page": 1},
                {"bbox": [0.0, 0.0, 0.5, 0.5], "kind": "figure", "page": 2},
                {"bbox": [0.1, 0.1, 0.9, 0.9], "kind": "table", "page": 2},
            ],
        )

    def test_source_blocks_are_persisted_on_nodes_and_chunks(self) -> None:
        pages = [
            {"page": 1, "text": "Intro"},
            {"page": 2, "text": "Body"},
        ]
        source_blocks = [
            {"bbox": [0.1, 0.1, 0.2, 0.2], "kind": "text", "page": 1},
            {"bbox": [0.3, 0.3, 0.4, 0.4], "kind": "table", "page": 2},
        ]
        tree = candidate_sections_to_tree(
            [
                {
                    "appear_start": "yes",
                    "physical_index": "<physical_index_1>",
                    "structure": "1",
                    "title": "Intro",
                }
            ],
            pages,
            source_blocks,
        )
        chunks = build_chunks_from_tree(tree)

        self.assertEqual(tree[0]["source_blocks"], source_blocks)
        self.assertEqual(remove_node_text(tree)[0]["source_blocks"], source_blocks)
        self.assertEqual(chunks[0]["metadata"]["source_blocks"], source_blocks)
        self.assertEqual(
            chunks[0]["metadata"]["source_blocks_coordinate_system"],
            SOURCE_BLOCKS_COORDINATE_SYSTEM,
        )


if __name__ == "__main__":
    unittest.main()
