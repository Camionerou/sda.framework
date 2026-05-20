export type MineruContentItem = Record<string, unknown>;

export type LabeledPage = {
  page: number;
  text: string;
};

export type CandidateSection = {
  appear_start?: "yes" | "no";
  physical_index: number | string | null;
  reason?: string;
  structure: string;
  title: string;
  valid?: boolean;
};

export type TreeNode = {
  end_index: number;
  node_id: string;
  nodes?: TreeNode[];
  start_index: number;
  summary?: string;
  text?: string;
  title: string;
};

export type TreeChunk = {
  chunk_index: number;
  content: string;
  metadata: Record<string, unknown>;
  node_id: string;
  node_path: string[];
  page_end: number;
  page_start: number;
  summary: string | null;
  token_count: number;
};

type TreeNodeDraft = Omit<TreeNode, "node_id" | "nodes"> & {
  nodes?: TreeNodeDraft[];
  structure: string;
};

function asString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function asStringList(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.map(asString).filter(Boolean);
}

function pageIndexFromItem(item: MineruContentItem) {
  const value = item.page_idx;

  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
}

function bboxValue(item: MineruContentItem, index: number) {
  const bbox = item.bbox;

  if (!Array.isArray(bbox)) {
    return 0;
  }

  const value = bbox[index];

  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function contentTextFromItem(item: MineruContentItem) {
  const parts = [
    asString(item.text),
    ...asStringList(item.image_caption),
    ...asStringList(item.image_footnote),
    ...asStringList(item.table_caption),
    asString(item.table_body),
    ...asStringList(item.table_footnote)
  ].filter(Boolean);

  return parts.join("\n");
}

export function contentListToLabeledPages(contentList: unknown): LabeledPage[] {
  if (!Array.isArray(contentList)) {
    throw new Error("MinerU content_list invalido: se esperaba un array.");
  }

  const items = contentList as MineruContentItem[];
  const maxPageIndex = items.reduce(
    (max, item) => Math.max(max, pageIndexFromItem(item)),
    0
  );
  const pages = new Map<number, string[]>();

  for (let pageIndex = 0; pageIndex <= maxPageIndex; pageIndex += 1) {
    pages.set(pageIndex + 1, []);
  }

  for (const item of items.sort((left, right) => {
    const pageDelta = pageIndexFromItem(left) - pageIndexFromItem(right);

    if (pageDelta !== 0) {
      return pageDelta;
    }

    return bboxValue(left, 1) - bboxValue(right, 1) || bboxValue(left, 0) - bboxValue(right, 0);
  })) {
    const text = contentTextFromItem(item);

    if (!text) {
      continue;
    }

    pages.get(pageIndexFromItem(item) + 1)?.push(text);
  }

  return Array.from(pages.entries()).map(([page, parts]) => ({
    page,
    text: parts.join("\n\n").trim()
  }));
}

export function estimateTokens(text: string) {
  return Math.ceil(text.length / 4);
}

export function taggedPagesText(pages: LabeledPage[]) {
  return pages
    .map((page) => `<physical_index_${page.page}>\n${page.text}\n<physical_index_${page.page}>`)
    .join("\n\n");
}

export function splitPagesForPrompt(pages: LabeledPage[]) {
  const maxChars = Number(process.env.SDA_TREE_MAX_PROMPT_CHARS ?? 60_000);
  const safeMaxChars = Number.isFinite(maxChars) && maxChars > 0 ? maxChars : 60_000;
  const groups: LabeledPage[][] = [];
  let current: LabeledPage[] = [];
  let currentChars = 0;

  for (const page of pages) {
    const taggedLength = taggedPagesText([page]).length;

    if (current.length > 0 && currentChars + taggedLength > safeMaxChars) {
      groups.push(current);
      current = current.slice(-1);
      currentChars = taggedPagesText(current).length;
    }

    current.push(page);
    currentChars += taggedLength;
  }

  if (current.length > 0) {
    groups.push(current);
  }

  return groups;
}

function physicalIndexToNumber(value: CandidateSection["physical_index"]) {
  if (typeof value === "number" && Number.isInteger(value)) {
    return value;
  }

  if (typeof value === "string") {
    const match = value.match(/physical_index_(\d+)/);

    if (match) {
      return Number(match[1]);
    }

    const parsed = Number(value);

    if (Number.isInteger(parsed)) {
      return parsed;
    }
  }

  return null;
}

function normalizeStructure(value: string) {
  return value.trim().replace(/\s+/g, "");
}

function parentStructure(structure: string) {
  const parts = structure.split(".");

  return parts.length > 1 ? parts.slice(0, -1).join(".") : null;
}

export function normalizeCandidateSections(
  sections: CandidateSection[],
  pageCount: number
) {
  return sections
    .map((section) => ({
      ...section,
      physical_index: physicalIndexToNumber(section.physical_index),
      structure: normalizeStructure(section.structure),
      title: section.title.trim()
    }))
    .filter((section): section is CandidateSection & { physical_index: number } =>
      Boolean(
        section.structure &&
          section.title &&
          section.physical_index &&
          section.physical_index >= 1 &&
          section.physical_index <= pageCount
      )
    );
}

function addPrefaceIfNeeded<T extends CandidateSection & { physical_index: number }>(
  sections: T[]
) {
  if (sections.length === 0 || sections[0].physical_index <= 1) {
    return sections;
  }

  return [
    {
      appear_start: "yes" as const,
      physical_index: 1,
      structure: "0",
      title: "Preface",
      valid: true
    },
    ...sections
  ];
}

function textForRange(pages: LabeledPage[], start: number, end: number) {
  return pages
    .filter((page) => page.page >= start && page.page <= end)
    .map((page) => `<physical_index_${page.page}>\n${page.text}`)
    .join("\n\n")
    .trim();
}

function buildTreeFromDrafts(drafts: TreeNodeDraft[]) {
  const nodeByStructure = new Map<string, TreeNodeDraft>();
  const roots: TreeNodeDraft[] = [];

  for (const draft of drafts) {
    nodeByStructure.set(draft.structure, draft);
  }

  for (const draft of drafts) {
    const parent = parentStructure(draft.structure);
    const parentNode = parent ? nodeByStructure.get(parent) : null;

    if (parentNode) {
      parentNode.nodes = [...(parentNode.nodes ?? []), draft];
    } else {
      roots.push(draft);
    }
  }

  return roots;
}

function assignNodeIds(drafts: TreeNodeDraft[]) {
  let counter = 0;

  function visit(node: TreeNodeDraft): TreeNode {
    const nodeId = String(counter).padStart(4, "0");
    counter += 1;

    return {
      end_index: node.end_index,
      node_id: nodeId,
      ...(node.nodes?.length ? { nodes: node.nodes.map(visit) } : {}),
      start_index: node.start_index,
      text: node.text,
      title: node.title
    };
  }

  return drafts.map(visit);
}

export function candidateSectionsToTree(
  sections: CandidateSection[],
  pages: LabeledPage[]
) {
  const normalized = addPrefaceIfNeeded(normalizeCandidateSections(sections, pages.length));
  const drafts = normalized.map((section, index): TreeNodeDraft => {
    const next = normalized[index + 1];
    const endIndex = next
      ? Math.max(
          section.physical_index,
          next.appear_start === "yes" ? next.physical_index - 1 : next.physical_index
        )
      : pages.length;

    return {
      end_index: endIndex,
      start_index: section.physical_index,
      structure: section.structure,
      text: textForRange(pages, section.physical_index, endIndex),
      title: section.title
    };
  });

  return assignNodeIds(buildTreeFromDrafts(drafts));
}

export function flattenTree(nodes: TreeNode[]) {
  const flattened: Array<{ node: TreeNode; path: string[] }> = [];

  function visit(node: TreeNode, parentPath: string[]) {
    const path = [...parentPath, node.title];
    flattened.push({ node, path });

    for (const child of node.nodes ?? []) {
      visit(child, path);
    }
  }

  for (const node of nodes) {
    visit(node, []);
  }

  return flattened;
}

export function buildChunksFromTree(nodes: TreeNode[]): TreeChunk[] {
  return flattenTree(nodes).map(({ node, path }, index) => {
    const content = node.text?.trim() || node.title;

    return {
      chunk_index: index,
      content,
      metadata: {
        page_range: [node.start_index, node.end_index],
        source: "pageindex_style_llm_tree"
      },
      node_id: node.node_id,
      node_path: path,
      page_end: node.end_index,
      page_start: node.start_index,
      summary: node.summary ?? null,
      token_count: estimateTokens(content)
    };
  });
}

export function removeNodeText(nodes: TreeNode[]): TreeNode[] {
  return nodes.map((node) => ({
    end_index: node.end_index,
    node_id: node.node_id,
    ...(node.nodes?.length ? { nodes: removeNodeText(node.nodes) } : {}),
    start_index: node.start_index,
    summary: node.summary,
    title: node.title
  }));
}

