from __future__ import annotations

import json

from .pageindex_style import CandidateSection, LabeledPage, TreeNode, remove_node_text

DOCUMENT_TYPES = {"book", "contract", "invoice", "manual", "other", "report", "slides"}


def document_type_prompt(document_title: str, first_pages_text: str) -> str:
    return f"""Classify the document type from the first pages.

Allowed types:
- book: long-form book, chaptered material, academic text.
- report: business, technical, analytical, or institutional report.
- invoice: invoice, receipt, quote, purchase order, or billing document.
- contract: contract, agreement, terms, clauses, legal/commercial obligation document.
- slides: slide deck, presentation, one visual topic per page/slide.
- manual: manual, guide, procedure, specification, or reference instructions.
- other: none of the above.

Document title: {document_title}

First pages:
{first_pages_text}

Return only JSON:
{{
  "type": "book|report|invoice|contract|slides|manual|other",
  "reason": "short reason"
}}"""


def _document_type_guidance(document_type: str) -> str:
    guidance = {
        "book": "Use the PageIndex hierarchy from chapters, sections, and subsections.",
        "report": "Use the report hierarchy: executive summary, sections, findings, appendices.",
        "invoice": "Prefer invoice sections such as header, parties, line items, taxes, totals, payment terms, and notes. Do not create one node per page unless the page is a distinct invoice.",
        "contract": "Prefer clauses, schedules, exhibits, and legal sections. Preserve original clause titles when present.",
        "slides": "Treat each slide/page as the main node. Only nest when a deck has explicit parts or agenda sections.",
        "manual": "Use manual/procedure structure: chapters, tasks, steps, specifications, warnings, and reference sections.",
        "other": "Use the clearest visible hierarchy in the document without forcing book-style chapters.",
    }
    return guidance.get(document_type, guidance["other"])


def _tree_mode_guidance(tree_mode: str) -> str:
    if tree_mode == "refine":
        return (
            "Refine one oversized section into smaller, meaningful child sections. Keep the hierarchy "
            "inside this range only; do not summarize the parent again as a single section."
        )
    if tree_mode == "no_toc":
        return (
            "The previous structure attempt was too inaccurate. Do not rely on a table of contents, "
            "numbered outline, or expected chapter labels. Infer the safest hierarchy from visible "
            "headings, page transitions, repeated section markers, and document semantics."
        )
    return (
        "Use explicit headings, numbering, table-of-contents evidence, and page-start markers when "
        "available."
    )


def candidate_prompt(
    document_title: str,
    document_type: str,
    group_text: str,
    previous: list[CandidateSection] | None,
    tree_mode: str = "toc",
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

Document type: {document_type}
Type-specific strategy: {_document_type_guidance(document_type)}
Extraction mode: {tree_mode}
Mode-specific strategy: {_tree_mode_guidance(tree_mode)}

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


def repair_sections_prompt(
    document_title: str,
    document_type: str,
    valid_sections: list[CandidateSection],
    invalid_sections: list[CandidateSection],
    pages: list[LabeledPage],
) -> str:
    page_numbers = sorted(
        {
            int(digits)
            for section in invalid_sections
            if (digits := "".join(char for char in str(section.get("physical_index")) if char.isdigit()))
        }
    )
    evidence = [
        {
            "page_excerpt": page.get("text", "")[:3500],
            "physical_index": f"<physical_index_{page['page']}>",
        }
        for page in pages
        if page["page"] in set(page_numbers)
    ]

    return f"""You are repairing rejected sections in a PageIndex-style document tree.

Keep the valid sections unless a repaired section must fit between them.
For each invalid section, either move it to the correct physical_index, fix its title, or omit it if no matching section exists.
Do not invent sections without evidence in the page excerpts.

Document title: {document_title}
Document type: {document_type}
Type-specific strategy: {_document_type_guidance(document_type)}

Valid sections:
{json.dumps(valid_sections, ensure_ascii=False, indent=2)}

Invalid sections to repair:
{json.dumps(invalid_sections, ensure_ascii=False, indent=2)}

Page excerpts for repair:
{json.dumps(evidence, ensure_ascii=False, indent=2)}

Return only JSON with repaired/replacement sections:
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


def routing_summary_prompt(node: TreeNode, path: list[str], document_type: str) -> str:
    return f"""You are preparing routing text for retrieval.
Given this document section, list 3-5 specific types of user questions that this section can answer.
Focus on intent and information need, not on summarizing prose.
Use one line per question type. Do not add bullets, numbering, or extra commentary.

Document type: {document_type}
Section path: {" > ".join(path)}
Section title: {node["title"]}
Page range: {node["start_index"]}-{node["end_index"]}
Section summary: {node.get("summary", "")}

Partial document text:
{node.get("text", "")[:12000]}"""


def doc_summary_prompt(tree: list[TreeNode]) -> str:
    return f"""You are an expert in generating descriptions for a document.
You are given the PageIndex-style structure of a document.
Generate a one-sentence description that makes this document easy to distinguish from other documents.
Do not add any text outside the description.

Document structure:
{json.dumps(remove_node_text(tree), ensure_ascii=False, indent=2)}"""
