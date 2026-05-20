import { Annotation, END, START, StateGraph } from "@langchain/langgraph";

import { callTreeLlmJson, callTreeLlmText } from "@/lib/tree-indexer/llm";
import {
  buildChunksFromTree,
  candidateSectionsToTree,
  flattenTree,
  removeNodeText,
  splitPagesForPrompt,
  taggedPagesText,
  type CandidateSection,
  type LabeledPage,
  type TreeChunk,
  type TreeNode
} from "@/lib/tree-indexer/pageindex-style";

type CandidateSectionsResponse = {
  sections: CandidateSection[];
};

type VerifySectionsResponse = {
  sections: Array<CandidateSection & { valid: boolean }>;
};

type TreeGraphMetrics = {
  candidate_section_count: number;
  chunk_count: number;
  llm_model: string | null;
  llm_provider: string | null;
  page_count: number;
  verified_section_count: number;
};

export type TreeIndexGraphResult = {
  chunks: TreeChunk[];
  docSummary: string;
  metrics: TreeGraphMetrics;
  model: string;
  provider: string;
  tree: TreeNode[];
  treeForStorage: TreeNode[];
  version: string;
};

const TREE_INDEXER_VERSION = "sda-pageindex-langgraph-v0.1.0";

const TreeState = Annotation.Root({
  candidateSections: Annotation<CandidateSection[]>,
  chunks: Annotation<TreeChunk[]>,
  docSummary: Annotation<string>,
  documentTitle: Annotation<string>,
  metrics: Annotation<TreeGraphMetrics>,
  pages: Annotation<LabeledPage[]>,
  provider: Annotation<string>,
  tree: Annotation<TreeNode[]>,
  verifiedSections: Annotation<CandidateSection[]>,
  version: Annotation<string>
});

function assertSections(value: unknown): CandidateSection[] {
  if (!value || typeof value !== "object" || !("sections" in value)) {
    throw new Error("El LLM no devolvio una lista de secciones.");
  }

  const sections = (value as CandidateSectionsResponse).sections;

  if (!Array.isArray(sections)) {
    throw new Error("El LLM no devolvio sections como array.");
  }

  return sections.filter(
    (section) =>
      section &&
      typeof section.structure === "string" &&
      typeof section.title === "string" &&
      section.physical_index !== undefined
  );
}

function candidatePrompt(documentTitle: string, groupText: string, previous?: CandidateSection[]) {
  return `You are an expert in extracting hierarchical tree structure.

Your task is to generate the tree structure of the document, following the PageIndex method.

The "structure" field is the numeric hierarchy code. Examples: "1", "1.1", "1.1.1".
For "title", extract the original section title from the text and only fix spacing inconsistencies.
The provided text contains tags like <physical_index_X> indicating the physical page number.
For "physical_index", return the tag where the section starts.

Document title: ${documentTitle}

${
  previous
    ? `Previous tree structure:
${JSON.stringify(previous, null, 2)}

Continue the structure with only additional sections found in the current text.`
    : "Generate the initial structure from the current text."
}

Current text:
${groupText}

Return only JSON:
{
  "sections": [
    {
      "structure": "1.2",
      "title": "Original section title",
      "physical_index": "<physical_index_12>"
    }
  ]
}`;
}

function verificationPrompt(sections: CandidateSection[], pages: LabeledPage[]) {
  const evidence = sections.map((section) => {
    const physicalIndex =
      typeof section.physical_index === "number"
        ? section.physical_index
        : Number(String(section.physical_index).match(/\d+/)?.[0] ?? 0);
    const page = pages.find((candidate) => candidate.page === physicalIndex);

    return {
      page_excerpt: page?.text.slice(0, 2500) ?? "",
      physical_index: section.physical_index,
      structure: section.structure,
      title: section.title
    };
  });

  return `You are verifying a PageIndex-style document tree.

For each section, check whether the title appears or starts in its assigned page excerpt.
Use fuzzy matching and ignore spacing inconsistencies. Do not invent new sections.
Set appear_start to "yes" only when the title starts at the beginning of the page excerpt.

Candidate sections with page excerpts:
${JSON.stringify(evidence, null, 2)}

Return only JSON:
{
  "sections": [
    {
      "structure": "1.2",
      "title": "Original section title",
      "physical_index": "<physical_index_12>",
      "valid": true,
      "appear_start": "yes",
      "reason": "short reason"
    }
  ]
}`;
}

function summaryPrompt(node: TreeNode) {
  return `You are given a part of a document.
Generate a concise description of the main points covered in this partial document.
Do not add any text outside the description.

Section title: ${node.title}
Page range: ${node.start_index}-${node.end_index}

Partial document text:
${(node.text ?? "").slice(0, 24_000)}`;
}

function docSummaryPrompt(tree: TreeNode[]) {
  return `You are an expert in generating descriptions for a document.
You are given the PageIndex-style structure of a document.
Generate a one-sentence description that makes this document easy to distinguish from other documents.
Do not add any text outside the description.

Document structure:
${JSON.stringify(removeNodeText(tree), null, 2)}`;
}

async function buildCandidateTreeNode(state: typeof TreeState.State) {
  const groups = splitPagesForPrompt(state.pages);
  let sections: CandidateSection[] = [];
  let model: string | null = null;
  let provider: string | null = null;

  for (const group of groups) {
    const result = await callTreeLlmJson<CandidateSectionsResponse>(
      candidatePrompt(
        state.documentTitle,
        taggedPagesText(group),
        sections.length > 0 ? sections : undefined
      ),
      "structure"
    );
    sections = [...sections, ...assertSections(result.json)];
    model = result.model;
    provider = result.provider;
  }

  if (sections.length === 0) {
    throw new Error("Tree LLM no encontro secciones para construir el arbol.");
  }

  return {
    candidateSections: sections,
    metrics: {
      ...state.metrics,
      candidate_section_count: sections.length,
      llm_model: model,
      llm_provider: provider
    },
    provider: provider ?? "",
    version: TREE_INDEXER_VERSION
  };
}

async function verifyTreeNode(state: typeof TreeState.State) {
  const result = await callTreeLlmJson<VerifySectionsResponse>(
    verificationPrompt(state.candidateSections, state.pages),
    "structure"
  );
  const verified = assertSections(result.json).filter((section) => section.valid !== false);
  const accuracy = verified.length / state.candidateSections.length;

  if (accuracy < 0.6) {
    throw new Error(`Tree verifier rechazo la estructura candidata: accuracy ${accuracy}.`);
  }

  return {
    metrics: {
      ...state.metrics,
      verified_section_count: verified.length
    },
    verifiedSections: verified
  };
}

function postProcessTreeNode(state: typeof TreeState.State) {
  const tree = candidateSectionsToTree(state.verifiedSections, state.pages);

  return {
    tree
  };
}

async function summarizeTreeNode(state: typeof TreeState.State) {
  const flattened = flattenTree(state.tree);
  const summaryConcurrency = Number(process.env.SDA_TREE_SUMMARY_CONCURRENCY ?? 3);
  const concurrency =
    Number.isInteger(summaryConcurrency) && summaryConcurrency > 0 ? summaryConcurrency : 3;
  let cursor = 0;

  async function worker() {
    for (;;) {
      const index = cursor;
      cursor += 1;

      if (index >= flattened.length) {
        return;
      }

      const node = flattened[index]?.node;

      if (!node) {
        continue;
      }

      const response = await callTreeLlmText(summaryPrompt(node), "summary");
      node.summary = response.content.trim();
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, flattened.length) }, worker));

  const docSummary = (await callTreeLlmText(docSummaryPrompt(state.tree), "summary")).content.trim();
  const chunks = buildChunksFromTree(state.tree);

  return {
    chunks,
    docSummary,
    metrics: {
      ...state.metrics,
      chunk_count: chunks.length
    }
  };
}

const treeGraph = new StateGraph(TreeState)
  .addNode("build_candidate_tree", buildCandidateTreeNode)
  .addNode("verify_tree", verifyTreeNode)
  .addNode("post_process_tree", postProcessTreeNode)
  .addNode("summarize_tree", summarizeTreeNode)
  .addEdge(START, "build_candidate_tree")
  .addEdge("build_candidate_tree", "verify_tree")
  .addEdge("verify_tree", "post_process_tree")
  .addEdge("post_process_tree", "summarize_tree")
  .addEdge("summarize_tree", END)
  .compile();

export async function runTreeIndexGraph(input: {
  documentTitle: string;
  pages: LabeledPage[];
}): Promise<TreeIndexGraphResult> {
  const result = await treeGraph.invoke({
    candidateSections: [],
    chunks: [],
    docSummary: "",
    documentTitle: input.documentTitle,
    metrics: {
      candidate_section_count: 0,
      chunk_count: 0,
      llm_model: null,
      llm_provider: null,
      page_count: input.pages.length,
      verified_section_count: 0
    },
    pages: input.pages,
    provider: "",
    tree: [],
    verifiedSections: [],
    version: TREE_INDEXER_VERSION
  });

  return {
    chunks: result.chunks,
    docSummary: result.docSummary,
    metrics: result.metrics,
    model: result.metrics.llm_model ?? "unknown",
    provider: result.metrics.llm_provider ?? result.provider,
    tree: result.tree,
    treeForStorage: removeNodeText(result.tree),
    version: result.version
  };
}
