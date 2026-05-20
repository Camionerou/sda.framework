import {
  ArrowLeft,
  Clock,
  Database,
  Download,
  FileText,
  Fingerprint,
  HardDrive,
  Search
} from "lucide-react";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { AppTopbar } from "@/components/dashboard/app-topbar";
import { KeyValue } from "@/components/dashboard/key-value";
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
  type DocumentRow
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
  model: string | null;
  summary: string | null;
  version: string | null;
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
      "id, title, filename, mime_type, byte_size, r2_bucket, r2_key, status, status_reason, uploaded_at, indexed_at, created_at"
    )
    .eq("id", id)
    .maybeSingle<DocumentRow>();

  if (error || !document) {
    notFound();
  }

  const [{ data: tree }, chunks] = await Promise.all([
    supabase
      .from("doc_tree")
      .select("summary, model, version, created_at")
      .eq("document_id", document.id)
      .maybeSingle<TreeRow>(),
    countRows(supabase, document.id)
  ]);

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
            <h1>{document.title ?? document.filename}</h1>
            <p>{document.filename}</p>
          </div>
          <div className="card-actions">
            <Badge tone={documentStatusTone(document.status)}>
              {documentStatusLabel(document.status)}
            </Badge>
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
                <CardTitle>Metadata</CardTitle>
                <CardDescription>Datos operativos del documento.</CardDescription>
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
                <CardTitle>Storage</CardTitle>
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
                <CardTitle>Indexación</CardTitle>
                <CardDescription>Estado de árbol y chunks para búsqueda.</CardDescription>
              </CardHeader>
              <CardContent>
                {tree ? (
                  <div className="key-value-list">
                    <KeyValue label="Modelo">{tree.model ?? "Sin dato"}</KeyValue>
                    <KeyValue label="Versión">{tree.version ?? "Sin dato"}</KeyValue>
                    <KeyValue label="Creado">{formatDateTime(tree.created_at)}</KeyValue>
                    <KeyValue label="Resumen">{tree.summary ?? "Sin resumen"}</KeyValue>
                  </div>
                ) : (
                  <div className="empty-state">
                    <Search aria-hidden="true" size={22} />
                    <div>
                      <strong>Sin índice todavía.</strong>
                      <p>El próximo paso es crear el worker que complete `doc_tree` y `chunks`.</p>
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
                    Archivo original registrado en `documents`.
                  </li>
                  <li>
                    <HardDrive aria-hidden="true" size={17} />
                    Path de Storage aislado por tenant.
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
