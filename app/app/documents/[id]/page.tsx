import {
  ArrowLeft,
  Clock,
  Database,
  Download,
  FileText,
  Fingerprint,
  GitBranch,
  HardDrive,
  Search
} from "lucide-react";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { AppTopbar } from "@/components/dashboard/app-topbar";
import { KeyValue } from "@/components/dashboard/key-value";
import { IndexingTimeline } from "@/components/documents/indexing-timeline";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from "@/components/ui/card";
import {
  documentStatusLabel,
  documentStatusTone,
  formatBytes,
  type DocumentRow,
  type IndexingEventRow,
  type IndexingRunRow
} from "@/lib/documents";
import {
  compactId,
  formatDateTime,
  getClaimValue,
  type AppClaims,
  type TenantRole
} from "@/lib/session";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type TreeRow = {
  created_at: string;
  indexing_pipeline_version: string | null;
  model: string | null;
  summary: string | null;
  tree_indexer_version: string | null;
  tree_prompt_version: string | null;
  version: string | null;
};

type ComponentVersionRow = {
  component: string;
  version: string;
};

async function countRows(
  supabase: Awaited<ReturnType<typeof createClient>>,
  documentId: string
) {
  const { count, error } = await supabase
    .from("chunks")
    .select("id", { count: "exact", head: true })
    .eq("document_id", documentId);

  return {
    count: count ?? 0,
    error: error?.message
  };
}

export default async function DocumentDetailPage({
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
  const tenantRole = getClaimValue<TenantRole>(claims, "tenant_role", "tenant_role");

  if (!tenantId) {
    redirect("/app");
  }

  const { data: document, error } = await supabase
    .from("documents")
    .select(
      "id, title, filename, mime_type, byte_size, r2_bucket, r2_key, status, status_reason, uploaded_at, indexed_at, created_at, indexing_pipeline_version, extraction_pipeline_version, tree_indexer_version, embedding_pipeline_version"
    )
    .eq("id", id)
    .maybeSingle<DocumentRow>();

  if (error || !document) {
    notFound();
  }

  const [
    { data: tree },
    chunks,
    { data: indexingRuns },
    { data: indexingEvents },
    { data: componentVersions }
  ] =
    await Promise.all([
      supabase
        .from("doc_tree")
        .select(
          "summary, model, version, created_at, indexing_pipeline_version, tree_indexer_version, tree_prompt_version"
        )
        .eq("document_id", document.id)
        .maybeSingle<TreeRow>(),
      countRows(supabase, document.id),
      supabase
        .from("indexing_runs")
        .select(
          "id, document_id, status, stage, progress, attempt, created_at, started_at, completed_at, failed_at, error_message, compute_job_id, inngest_run_id, indexing_pipeline_version, extraction_pipeline_version, tree_indexer_version, embedding_pipeline_version"
        )
        .eq("document_id", document.id)
        .order("created_at", { ascending: false })
        .limit(1)
        .returns<IndexingRunRow[]>(),
      supabase
        .from("indexing_events")
        .select("id, run_id, document_id, event_type, stage, severity, message, progress, created_at")
        .eq("document_id", document.id)
        .order("created_at", { ascending: true })
        .limit(80)
        .returns<IndexingEventRow[]>(),
      supabase
        .from("system_component_versions")
        .select("component, version")
        .returns<ComponentVersionRow[]>()
    ]);

  const latestRun = indexingRuns?.[0] ?? null;
  const latestVersions = new Map(
    (componentVersions ?? []).map((row) => [row.component, row.version])
  );
  const documentVersions = {
    embedding_pipeline:
      document.embedding_pipeline_version ?? latestRun?.embedding_pipeline_version ?? null,
    extraction_pipeline:
      document.extraction_pipeline_version ?? latestRun?.extraction_pipeline_version ?? null,
    indexing_pipeline:
      document.indexing_pipeline_version ??
      tree?.indexing_pipeline_version ??
      latestRun?.indexing_pipeline_version ??
      null,
    tree_indexer:
      document.tree_indexer_version ??
      tree?.tree_indexer_version ??
      latestRun?.tree_indexer_version ??
      null,
    tree_prompt: tree?.tree_prompt_version ?? null
  };
  const versionChecks = [
    ["indexing_pipeline", documentVersions.indexing_pipeline],
    ["extraction_pipeline", documentVersions.extraction_pipeline],
    ["tree_indexer_python", documentVersions.tree_indexer],
    ["tree_prompt", documentVersions.tree_prompt],
    ["embedding_pipeline", documentVersions.embedding_pipeline]
  ] as const;
  const staleVersions =
    document.status === "indexed" &&
    versionChecks.some(([component, current]) => {
      const latest = latestVersions.get(component);

      return Boolean(current && latest && current !== latest);
    });

  function versionBadge(component: string, current: string | null) {
    const latest = latestVersions.get(component);

    if (!current || !latest) {
      return <Badge tone="neutral">Sin dato</Badge>;
    }

    return current === latest ? (
      <Badge tone="success">Actual</Badge>
    ) : (
      <Badge tone="warning">Vieja</Badge>
    );
  }

  return (
    <main className="app-shell">
      <AppTopbar active="documents" tenantActive={Boolean(tenantId)} tenantRole={tenantRole} />

      <section className="page">
        <div className="page-header">
          <div className="page-title">
            <Link className="button button-ghost back-link" href="/app/documents">
              <ArrowLeft aria-hidden="true" size={16} />
              Documentos
            </Link>
            <div className="kicker">Detalle documental</div>
            <h1>{document.title ?? document.filename}</h1>
            <p>{document.filename}</p>
          </div>
          <div className="card-actions">
            <Badge tone={documentStatusTone(document.status)}>
              {documentStatusLabel(document.status)}
            </Badge>
            {staleVersions ? <Badge tone="warning">Reindex sugerido</Badge> : null}
            <Link className="button button-secondary" href={`/app/documents/${document.id}/download`}>
              <Download aria-hidden="true" size={16} />
              Descargar
            </Link>
          </div>
        </div>

        <div className="dashboard-grid">
          <div className="section-grid">
            <div className="stats-grid">
              <div className="stat">
                <div className="stat-label">Tamaño</div>
                <div className="stat-value stat-value-small">{formatBytes(document.byte_size)}</div>
                <div className="muted">{document.mime_type}</div>
              </div>
              <div className="stat">
                <div className="stat-label">Chunks</div>
                <div className="stat-value">{chunks.count}</div>
                <div className="muted">{chunks.error ?? "Pendiente de indexación"}</div>
              </div>
              <div className="stat">
                <div className="stat-label">Indexación</div>
                <div className="stat-value stat-value-small">
                  {document.indexed_at ? "Lista" : "Pendiente"}
                </div>
                <div className="muted">{formatDateTime(document.indexed_at)}</div>
              </div>
            </div>

            <Card>
              <CardHeader>
                <CardTitle>Ficha operativa</CardTitle>
                <CardDescription>Datos principales del documento y su estado.</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="key-value-list">
                  <KeyValue label="Documento ID">
                    <span className="code">{document.id}</span>
                  </KeyValue>
                  <KeyValue label="Estado">
                    <Badge tone={documentStatusTone(document.status)}>
                      {documentStatusLabel(document.status)}
                    </Badge>
                  </KeyValue>
                  <KeyValue label="Creado">
                    <span className="inline-icon">
                      <Clock aria-hidden="true" size={14} />
                      {formatDateTime(document.created_at)}
                    </span>
                  </KeyValue>
                  <KeyValue label="Subido">{formatDateTime(document.uploaded_at)}</KeyValue>
                  <KeyValue label="Razón">{document.status_reason ?? "Sin observaciones"}</KeyValue>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Ubicación privada</CardTitle>
                <CardDescription>Ubicación privada del archivo original.</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="key-value-list">
                  <KeyValue label="Bucket">{document.r2_bucket}</KeyValue>
                  <KeyValue label="Path">
                    <span className="code">{document.r2_key}</span>
                  </KeyValue>
                  <KeyValue label="Tenant">
                    <span className="code">{compactId(tenantId)}</span>
                  </KeyValue>
                </div>
              </CardContent>
            </Card>
          </div>

          <div className="section-grid">
            <Card>
              <CardHeader>
                <CardTitle>Indexación live</CardTitle>
                <CardDescription>Progreso y eventos del SDA Tree Index.</CardDescription>
              </CardHeader>
              <CardContent>
                <IndexingTimeline
                  documentId={document.id}
                  initialEvents={indexingEvents ?? []}
                  initialRun={latestRun}
                />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Índice semántico</CardTitle>
                <CardDescription>Estado del árbol y nodos para búsqueda.</CardDescription>
              </CardHeader>
              <CardContent>
                {tree ? (
                  <div className="key-value-list">
                    <KeyValue label="Modelo">{tree.model ?? "Sin dato"}</KeyValue>
                    <KeyValue label="Versión">{tree.version ?? "Sin dato"}</KeyValue>
                    <KeyValue label="Pipeline">
                      <span className="inline-icon">
                        <GitBranch aria-hidden="true" size={14} />
                        {documentVersions.indexing_pipeline ?? "Sin dato"}
                        {versionBadge("indexing_pipeline", documentVersions.indexing_pipeline)}
                      </span>
                    </KeyValue>
                    <KeyValue label="Extracción">
                      <span className="inline-icon">
                        {documentVersions.extraction_pipeline ?? "Sin dato"}
                        {versionBadge("extraction_pipeline", documentVersions.extraction_pipeline)}
                      </span>
                    </KeyValue>
                    <KeyValue label="Tree Indexer">
                      <span className="inline-icon">
                        {documentVersions.tree_indexer ?? "Sin dato"}
                        {versionBadge("tree_indexer_python", documentVersions.tree_indexer)}
                      </span>
                    </KeyValue>
                    <KeyValue label="Prompt árbol">
                      <span className="inline-icon">
                        {documentVersions.tree_prompt ?? "Sin dato"}
                        {versionBadge("tree_prompt", documentVersions.tree_prompt)}
                      </span>
                    </KeyValue>
                    <KeyValue label="Embeddings">
                      <span className="inline-icon">
                        {documentVersions.embedding_pipeline ?? "Sin dato"}
                        {versionBadge("embedding_pipeline", documentVersions.embedding_pipeline)}
                      </span>
                    </KeyValue>
                    <KeyValue label="Creado">{formatDateTime(tree.created_at)}</KeyValue>
                    <KeyValue label="Resumen">{tree.summary ?? "Sin resumen"}</KeyValue>
                  </div>
                ) : (
                  <div className="empty-state">
                    <Search aria-hidden="true" size={22} />
                    <div>
                      <strong>Sin índice todavía.</strong>
                      <p>La corrida live va a completar el árbol y los nodos recuperables.</p>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Diagnóstico</CardTitle>
                <CardDescription>Checklist rápido de integridad.</CardDescription>
              </CardHeader>
              <CardContent>
                <ul className="steps">
                  <li>
                    <FileText aria-hidden="true" size={17} />
                    Archivo original registrado.
                  </li>
                  <li>
                    <HardDrive aria-hidden="true" size={17} />
                    Storage aislado por tenant.
                  </li>
                  <li>
                    <Database aria-hidden="true" size={17} />
                    RLS controla lectura del documento y descarga firmada.
                  </li>
                  <li>
                    <Fingerprint aria-hidden="true" size={17} />
                    Checksums quedan pendientes para el worker de ingestión.
                  </li>
                </ul>
              </CardContent>
            </Card>
          </div>
        </div>
      </section>
    </main>
  );
}
