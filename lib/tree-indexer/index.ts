import type { SupabaseClient } from "@supabase/supabase-js";

import { INDEXING_VERSION_COLUMNS, INDEXING_VERSION_METADATA } from "@/lib/system-versions";
import { runTreeIndexGraph, type TreeIndexGraphResult } from "@/lib/tree-indexer/graph";
import { contentListToLabeledPages } from "@/lib/tree-indexer/pageindex-style";

export { isTreeLlmConfigured, TreeLlmMissingConfigError } from "@/lib/tree-indexer/llm";

type TreeIndexerDocument = {
  filename: string;
  id: string;
  tenant_id: string;
  title?: string | null;
};

type ExtractionArtifactRow = {
  artifact_type: string;
  byte_size: number | null;
  content_type: string | null;
  metadata: Record<string, unknown> | null;
  storage_bucket: string;
  storage_path: string;
};

function pickContentListArtifact(artifacts: ExtractionArtifactRow[]) {
  return artifacts.find((artifact) => artifact.artifact_type === "content_list");
}

async function loadExtractionArtifacts(
  supabase: SupabaseClient,
  extractionId: string,
  document: TreeIndexerDocument
) {
  const { data, error } = await supabase
    .from("document_extraction_artifacts")
    .select("artifact_type, storage_bucket, storage_path, byte_size, content_type, metadata")
    .eq("extraction_id", extractionId)
    .eq("tenant_id", document.tenant_id)
    .eq("document_id", document.id)
    .returns<ExtractionArtifactRow[]>();

  if (error) {
    throw error;
  }

  return data ?? [];
}

async function downloadJsonArtifact(
  supabase: SupabaseClient,
  artifact: ExtractionArtifactRow
) {
  const { data, error } = await supabase.storage
    .from(artifact.storage_bucket)
    .download(artifact.storage_path);

  if (error) {
    throw error;
  }

  return JSON.parse(await data.text()) as unknown;
}

async function persistTreeIndex(input: {
  document: TreeIndexerDocument;
  extractionId: string;
  result: TreeIndexGraphResult;
  runId: string;
  supabase: SupabaseClient;
}) {
  const { document, extractionId, result, runId, supabase } = input;
  const { error: deleteError } = await supabase
    .from("chunks")
    .delete()
    .eq("tenant_id", document.tenant_id)
    .eq("document_id", document.id);

  if (deleteError) {
    throw deleteError;
  }

  const { error: treeError } = await supabase.from("doc_tree").upsert(
    {
      document_id: document.id,
      indexing_pipeline_version: INDEXING_VERSION_COLUMNS.indexing_pipeline_version,
      metadata: {
        ...INDEXING_VERSION_METADATA,
        embedding_status: "pending",
        extraction_id: extractionId,
        indexer: result.version,
        metrics: result.metrics,
        run_id: runId,
        source: "pageindex_style_llm_tree"
      },
      model: result.model,
      summary: result.docSummary,
      tenant_id: document.tenant_id,
      tree: {
        nodes: result.treeForStorage,
        source: "pageindex_style_llm_tree",
        version: result.version
      },
      tree_indexer_version: INDEXING_VERSION_COLUMNS.tree_indexer_version,
      tree_prompt_version: INDEXING_VERSION_METADATA.versions.tree_prompt_version,
      version: result.version
    },
    { onConflict: "document_id" }
  );

  if (treeError) {
    throw treeError;
  }

  const chunkRows = result.chunks.map((chunk) => ({
    chunk_index: chunk.chunk_index,
    content: chunk.content,
    document_id: document.id,
    embedding_pipeline_version: INDEXING_VERSION_COLUMNS.embedding_pipeline_version,
    indexing_pipeline_version: INDEXING_VERSION_COLUMNS.indexing_pipeline_version,
    metadata: {
      ...chunk.metadata,
      ...INDEXING_VERSION_METADATA,
      extraction_id: extractionId,
      indexer: result.version,
      run_id: runId
    },
    node_id: chunk.node_id,
    node_path: chunk.node_path,
    page_end: chunk.page_end,
    page_start: chunk.page_start,
    summary: chunk.summary,
    tenant_id: document.tenant_id,
    tree_indexer_version: INDEXING_VERSION_COLUMNS.tree_indexer_version,
    token_count: chunk.token_count
  }));

  if (chunkRows.length === 0) {
    throw new Error("Tree Indexer no genero chunks/nodos recuperables.");
  }

  const { error: chunksError } = await supabase.from("chunks").insert(chunkRows);

  if (chunksError) {
    throw chunksError;
  }
}

export async function buildDocumentTreeIndex(input: {
  document: TreeIndexerDocument;
  extractionId: string;
  runId: string;
  supabase: SupabaseClient;
}) {
  const artifacts = await loadExtractionArtifacts(
    input.supabase,
    input.extractionId,
    input.document
  );
  const contentListArtifact = pickContentListArtifact(artifacts);

  if (!contentListArtifact) {
    throw new Error("No se encontro content_list de MinerU para construir el arbol.");
  }

  const contentList = await downloadJsonArtifact(input.supabase, contentListArtifact);
  const pages = contentListToLabeledPages(contentList);

  if (pages.length === 0) {
    throw new Error("MinerU content_list no contiene paginas utilizables.");
  }

  const result = await runTreeIndexGraph({
    documentTitle: input.document.title ?? input.document.filename,
    pages
  });

  await persistTreeIndex({
    document: input.document,
    extractionId: input.extractionId,
    result,
    runId: input.runId,
    supabase: input.supabase
  });

  return {
    artifact_count: artifacts.length,
    chunk_count: result.chunks.length,
    content_list_path: contentListArtifact.storage_path,
    doc_summary: result.docSummary,
    metrics: result.metrics,
    model: result.model,
    page_count: pages.length,
    provider: result.provider,
    version: result.version
  };
}
