from __future__ import annotations

import json

from .pageindex_style import CandidateSection, LabeledPage, TreeNode, remove_node_text


def candidate_prompt(
    document_title: str,
    group_text: str,
    previous: list[CandidateSection] | None,
) -> str:
    previous_json = json.dumps(previous, ensure_ascii=False, indent=2) if previous else ""
    previous_text = (
        "Generate the initial structure from the current text."
        if not previous
        else f"""Previous tree structure:
{previous_json}

Continue the structure with only additional sections found in the current text."""
    )
    return f"""You are an expert in extracting hierarchical tree structure.

Your task is to generate the tree structure of the document, following the PageIndex method.

The "structure" field is the numeric hierarchy code. Examples: "1", "1.1", "1.1.1".
For "title", extract the original section title from the text and only fix spacing inconsistencies.
The provided text contains tags like <physical_index_X> indicating the physical page number.
For "physical_index", return the tag where the section starts.

Document title: {document_title}

{previous_text}

Current text:
{group_text}

Return only JSON:
{{
  "sections": [
    {{
      "structure": "1.2",
      "title": "Original section title",
      "physical_index": "<physical_index_12>"
    }}
  ]
}}"""


def verification_prompt(sections: list[CandidateSection], pages: list[LabeledPage]) -> str:
    evidence = []
    for section in sections:
        raw_index = section.get("physical_index")
        if isinstance(raw_index, int):
            physical_index = raw_index
        else:
            digits = "".join(char for char in str(raw_index) if char.isdigit())
            physical_index = int(digits) if digits else 0
        page = next((candidate for candidate in pages if candidate["page"] == physical_index), None)
        evidence.append(
            {
                "page_excerpt": (page or {}).get("text", "")[:2500],
                "physical_index": raw_index,
                "structure": section.get("structure"),
                "title": section.get("title"),
            }
        )

    return f"""You are verifying a PageIndex-style document tree.

For each section, check whether the title appears or starts in its assigned page excerpt.
Use fuzzy matching and ignore spacing inconsistencies. Do not invent new sections.
Set appear_start to "yes" when the title starts a new section on that page,
even if there is a repeated logo, brand, page header, or family label before the title.

Candidate sections with page excerpts:
{json.dumps(evidence, ensure_ascii=False, indent=2)}

Return only JSON:
{{
  "sections": [
    {{
      "structure": "1.2",
      "title": "Original section title",
      "physical_index": "<physical_index_12>",
      "valid": true,
      "appear_start": "yes",
      "reason": "short reason"
    }}
  ]
}}"""


def summary_prompt(node: TreeNode) -> str:
    return f"""You are given a part of a document.
Generate a concise description of the main points covered in this partial document.
Do not add any text outside the description.

Section title: {node["title"]}
Page range: {node["start_index"]}-{node["end_index"]}

Partial document text:
{node.get("text", "")[:24000]}"""


def doc_summary_prompt(tree: list[TreeNode]) -> str:
    return f"""You are an expert in generating descriptions for a document.
You are given the PageIndex-style structure of a document.
Generate a one-sentence description that makes this document easy to distinguish from other documents.
Do not add any text outside the description.

Document structure:
{json.dumps(remove_node_text(tree), ensure_ascii=False, indent=2)}"""
