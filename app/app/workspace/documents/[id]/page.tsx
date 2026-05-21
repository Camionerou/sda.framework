import { notFound, redirect } from "next/navigation";

import { WorkspaceClient } from "@/components/workspace/workspace-client";
import type { InspectorTab } from "@/components/workspace/inspector";
import {
  visibleDocumentStatuses,
  type DocumentExtractionArtifactRow,
  type DocumentExtractionRow,
  type DocumentRow,
  type IndexingEventRow,
  type IndexingRunRow
} from "@/lib/documents";
import type { ComponentVersionRow, TreeRow } from "@/lib/documents/detail";
import { getClaimValue, type AppClaims } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import { buildTreeRows, type ChunkRow } from "@/lib/workspace";

export const dynamic = "force-dynamic";

export default async function WorkspaceDocumentPage({
  params
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: claimsData, error: claimsError } = await supabase.auth.getClaims();

  if (claimsError || !claimsData?.claims) {
    redirect("/login");
  }

  const claims = claimsData.claims as AppClaims;
  const tenantId = getClaimValue<string>(claims, "tenant_id", "tenant_id");
  const tenantSlug = getClaimValue<string>(claims, "tenant_slug", "tenant_slug");

  if (!tenantId) {
    redirect("/app");
  }

  const { data: document, error } = await supabase
    .from("documents")
    .select(
      "id, title, filename, mime_type, byte_size, storage_bucket, storage_path, status, status_reason, uploaded_at, indexed_at, created_at, indexing_pipeline_version, extraction_pipeline_version, tree_indexer_version, embedding_pipeline_version"
    )
    .eq("id", id)
    .eq("tenant_id", tenantId)
    .in("status", [...visibleDocumentStatuses])
    .not("uploaded_at", "is", null)
    .maybeSingle<DocumentRow>();

  if (error || !document) {
    notFound();
  }

  const [
    { data: tree },
    { data: chunkRows },
    { data: runs },
    { data: eventRows },
    { data: extractionRows },
    { data: artifactRows },
    { data: versionRows }
  ] = await Promise.all([
    supabase
      .from("doc_tree")
      .select(
        "summary, routing_summary, model, version, created_at, indexing_pipeline_version, tree_indexer_version, tree_prompt_version"
      )
      .eq("document_id", document.id)
      .eq("tenant_id", tenantId)
      .maybeSingle<TreeRow>(),
    supabase
      .from("chunks")
      .select("node_id, node_path, chunk_index, page_start, page_end, summary")
      .eq("document_id", document.id)
      .eq("tenant_id", tenantId)
      .order("chunk_index", { ascending: true })
      .limit(4000)
      .returns<ChunkRow[]>(),
    supabase
      .from("indexing_runs")
      .select(
        "id, document_id, status, stage, progress, attempt, created_at, started_at, completed_at, failed_at, error_message, compute_job_id, inngest_run_id, indexing_pipeline_version, extraction_pipeline_version, tree_indexer_version, embedding_pipeline_version"
      )
      .eq("document_id", document.id)
      .eq("tenant_id", tenantId)
      .order("created_at", { ascending: false })
      .limit(1)
      .returns<IndexingRunRow[]>(),
    supabase
      .from("indexing_events")
      .select("id, run_id, document_id, event_type, stage, severity, message, progress, created_at")
      .eq("document_id", document.id)
      .eq("tenant_id", tenantId)
      .order("created_at", { ascending: true })
      .limit(120)
      .returns<IndexingEventRow[]>(),
    supabase
      .from("document_extractions")
      .select(
        "id, document_id, run_id, parser, parser_version, parser_backend, status, artifact_prefix, manifest, metrics, error_message, started_at, completed_at, failed_at, created_at, updated_at"
      )
      .eq("document_id", document.id)
      .eq("tenant_id", tenantId)
      .order("created_at", { ascending: false })
      .limit(5)
      .returns<DocumentExtractionRow[]>(),
    supabase
      .from("document_extraction_artifacts")
      .select(
        "id, extraction_id, document_id, artifact_type, storage_bucket, storage_path, content_type, byte_size, created_at"
      )
      .eq("document_id", document.id)
      .eq("tenant_id", tenantId)
      .order("created_at", { ascending: false })
      .limit(24)
      .returns<DocumentExtractionArtifactRow[]>(),
    supabase
      .from("system_component_versions")
      .select("component, version")
      .returns<ComponentVersionRow[]>()
  ]);

  const chunks = chunkRows ?? [];
  const treeRows = buildTreeRows(chunks);
  const latestRun = runs?.[0] ?? null;
  const events = eventRows ?? [];

  const latestVersions: Record<string, string> = {};
  for (const row of versionRows ?? []) {
    latestVersions[row.component] = row.version;
  }

  const versions = [
    {
      label: "Pipeline",
      component: "indexing_pipeline",
      value:
        document.indexing_pipeline_version ??
        tree?.indexing_pipeline_version ??
        latestRun?.indexing_pipeline_version ??
        null
    },
    {
      label: "Extracción",
      component: "extraction_pipeline",
      value: document.extraction_pipeline_version ?? latestRun?.extraction_pipeline_version ?? null
    },
    {
      label: "Tree Indexer",
      component: "tree_indexer_python",
      value:
        document.tree_indexer_version ??
        tree?.tree_indexer_version ??
        latestRun?.tree_indexer_version ??
        null
    },
    {
      label: "Prompt árbol",
      component: "tree_prompt",
      value: tree?.tree_prompt_version ?? null
    },
    {
      label: "Embeddings",
      component: "embedding_pipeline",
      value: document.embedding_pipeline_version ?? latestRun?.embedding_pipeline_version ?? null
    }
  ];

  const runActive = latestRun?.status === "queued" || latestRun?.status === "running";
  const defaultTab: InspectorTab = runActive
    ? "indexing"
    : treeRows.length > 0 || document.status === "indexed"
      ? "structure"
      : "indexing";

  return (
    <WorkspaceClient
      document={document}
      initialArtifacts={artifactRows ?? []}
      initialExtractions={extractionRows ?? []}
      tenantLabel={tenantSlug || "SDA"}
      tenantId={tenantId}
      treeRows={treeRows}
      treeSummary={tree?.summary ?? null}
      treeModel={tree?.model ?? null}
      treeVersion={tree?.version ?? null}
      chunksCount={chunks.length}
      initialRun={latestRun}
      initialEvents={events}
      versions={versions}
      latestVersions={latestVersions}
      defaultTab={defaultTab}
      viewer={{
        id: claims.sub ?? "unknown",
        label: claims.email ?? "Usuario"
      }}
    />
  );
}
