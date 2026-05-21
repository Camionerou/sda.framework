import {
  documentStatusLabel,
  type DocumentStatus,
  type IndexingStage
} from "@/lib/documents";

/** Recoverable node/chunk persisted by the Tree Indexer (subset used by the UI). */
export type ChunkRow = {
  node_id: string | null;
  node_path: string[] | null;
  chunk_index: number;
  page_start: number | null;
  page_end: number | null;
  summary: string | null;
};

/** Flattened tree row for the inspector "Estructura" tab. */
export type TreeRowView = {
  key: string;
  title: string;
  depth: number;
  pageStart: number | null;
  pageEnd: number | null;
  nodeId: string | null;
};

/** Library-item status bucket (drives chip color + label). */
export type LibStatus = "indexed" | "running" | "queued" | "failed" | "neutral";

export function libStatus(status: DocumentStatus): LibStatus {
  switch (status) {
    case "indexed":
      return "indexed";
    case "failed":
      return "failed";
    case "parsing":
    case "structuring":
    case "embedding":
      return "running";
    case "uploading":
    case "uploaded":
    case "queued":
      return "queued";
    case "archived":
    default:
      return "neutral";
  }
}

export function libStatusLabel(status: DocumentStatus): string {
  // Reuse the canonical Spanish labels; "running" surfaces map to "Indexando".
  if (libStatus(status) === "running") {
    return "Indexando";
  }

  return documentStatusLabel(status);
}

/**
 * Reconstruct the semantic tree from flattened chunks.
 * `node_path` is an array of ancestor titles (root → node). We rebuild the
 * hierarchy, propagate page ranges upward, then DFS-flatten in document order.
 */
export function buildTreeRows(chunks: ChunkRow[]): TreeRowView[] {
  type Node = {
    key: string;
    title: string;
    depth: number;
    order: number;
    pageStart: number | null;
    pageEnd: number | null;
    nodeId: string | null;
    children: Map<string, Node>;
  };

  const roots = new Map<string, Node>();
  let order = 0;

  const ordered = [...chunks].sort((a, b) => a.chunk_index - b.chunk_index);

  for (const chunk of ordered) {
    const path =
      chunk.node_path && chunk.node_path.length > 0
        ? chunk.node_path
        : [chunk.summary?.slice(0, 60) || "Sección"];

    let level = roots;
    let prefix = "";
    let node: Node | undefined;

    path.forEach((rawTitle, depth) => {
      const title = (rawTitle ?? "").trim() || `Sección ${depth + 1}`;
      prefix = `${prefix}/${title}`;
      node = level.get(prefix);

      if (!node) {
        node = {
          key: prefix,
          title,
          depth,
          order: order++,
          pageStart: null,
          pageEnd: null,
          nodeId: null,
          children: new Map()
        };
        level.set(prefix, node);
      }

      level = node.children;
    });

    if (node) {
      node.nodeId = chunk.node_id ?? node.nodeId;
      if (chunk.page_start != null) {
        node.pageStart =
          node.pageStart == null ? chunk.page_start : Math.min(node.pageStart, chunk.page_start);
      }
      if (chunk.page_end != null) {
        node.pageEnd = node.pageEnd == null ? chunk.page_end : Math.max(node.pageEnd, chunk.page_end);
      }
    }
  }

  const rows: TreeRowView[] = [];

  const walk = (nodes: Map<string, Node>) => {
    const sorted = [...nodes.values()].sort((a, b) => a.order - b.order);
    for (const n of sorted) {
      // Propagate ranges from descendants when the node itself has none.
      let start = n.pageStart;
      let end = n.pageEnd;
      const childRowsStart = rows.length;

      rows.push({
        key: n.key,
        title: n.title,
        depth: Math.min(n.depth, 3),
        pageStart: start,
        pageEnd: end,
        nodeId: n.nodeId
      });

      walk(n.children);

      // After walking children, fill missing range from them.
      for (let i = childRowsStart + 1; i < rows.length; i += 1) {
        const child = rows[i];
        if (child.pageStart != null) {
          start = start == null ? child.pageStart : Math.min(start, child.pageStart);
        }
        if (child.pageEnd != null) {
          end = end == null ? child.pageEnd : Math.max(end, child.pageEnd);
        }
      }
      rows[childRowsStart].pageStart = start;
      rows[childRowsStart].pageEnd = end;
    }
  };

  walk(roots);

  return rows;
}

export function formatPageRange(start: number | null, end: number | null): string {
  if (start == null) {
    return "—";
  }
  if (end == null || end === start) {
    return `${start}`;
  }
  return `${start}–${end}`;
}

/** Canonical pipeline order for the stage rail. */
export const STAGE_PIPELINE: IndexingStage[] = [
  "queued",
  "extracting",
  "structuring",
  "verifying_tree",
  "refining_tree",
  "summarizing",
  "embedding",
  "persisting",
  "indexed"
];
