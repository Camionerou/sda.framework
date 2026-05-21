import { Clock, Database, FileText, HardDriveUpload, Search, UploadCloud } from "lucide-react";
import Link from "next/link";
import { redirect } from "next/navigation";

import { AppShell } from "@/components/workspace/app-shell";
import { DocumentUploadForm } from "@/components/documents/document-upload-form";
import {
  formatBytes,
  isPendingVisibleDocument,
  visibleDocumentStatuses,
  type DocumentRow
} from "@/lib/documents";
import { formatDateTime, getClaimValue, type AppClaims, type TenantRole } from "@/lib/auth/session";
import { libStatus, libStatusLabel } from "@/lib/workspace";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function DocumentsPage() {
  const supabase = await createClient();
  const { data: claimsData, error: claimsError } = await supabase.auth.getClaims();

  if (claimsError || !claimsData?.claims) {
    redirect("/login");
  }

  const claims = claimsData.claims as AppClaims;
  const tenantId = getClaimValue<string>(claims, "tenant_id", "tenant_id");
  const tenantRole = getClaimValue<TenantRole>(claims, "tenant_role", "tenant_role");
  const tenantSlug = getClaimValue<string>(claims, "tenant_slug", "tenant_slug");

  if (!tenantId) {
    redirect("/app");
  }

  const { data: documentRows, error } = await supabase
    .from("documents")
    .select(
      "id, title, filename, mime_type, byte_size, storage_bucket, storage_path, status, status_reason, uploaded_at, indexed_at, created_at, indexing_pipeline_version, extraction_pipeline_version, tree_indexer_version, embedding_pipeline_version"
    )
    .in("status", [...visibleDocumentStatuses])
    .not("uploaded_at", "is", null)
    .order("created_at", { ascending: false })
    .limit(100)
    .returns<DocumentRow[]>();

  const documents = documentRows ?? [];
  const uploadedCount = documents.filter((doc) => doc.status === "uploaded").length;
  const indexedCount = documents.filter((doc) => doc.status === "indexed").length;
  const pendingCount = documents.filter(isPendingVisibleDocument).length;

  return (
    <AppShell active="documents" tenantLabel={tenantSlug || "SDA"} tenantRole={tenantRole}>
      <div className="page-head">
        <div>
          <div className="kicker">Biblioteca</div>
          <h1>Documentos</h1>
          <p>Carga privada, seguimiento de ingesta y apertura en el workspace.</p>
        </div>
      </div>

      <div className="grid-2">
        <div className="section-grid">
          <div className="stats-grid">
            <div className="stat">
              <div className="stat-label">Subidos</div>
              <div className="stat-value">{uploadedCount}</div>
              <div className="stat-sub">Listos para pipeline</div>
            </div>
            <div className="stat">
              <div className="stat-label">Pendientes</div>
              <div className="stat-value">{pendingCount}</div>
              <div className="stat-sub">Upload o indexación</div>
            </div>
            <div className="stat">
              <div className="stat-label">Indexados</div>
              <div className="stat-value">{indexedCount}</div>
              <div className="stat-sub">Disponibles en el workspace</div>
            </div>
          </div>

          <div className="glass-card">
            <div className="gc-head">
              <h2 className="gc-title">Archivos del tenant</h2>
              <p className="gc-desc">Últimos 100 documentos. Hacé click para abrirlos en el workspace.</p>
            </div>

            {error ? (
              <div className="alert alert-danger" role="alert">
                <strong>No se pudieron leer los documentos.</strong>
                <span>{error.message}</span>
              </div>
            ) : null}

            {documents.length === 0 ? (
              <div className="empty">
                <FileText aria-hidden="true" size={22} />
                <div>
                  <strong>No hay documentos todavía.</strong>
                  <p>Subí el primer archivo desde el panel lateral.</p>
                </div>
              </div>
            ) : (
              <div className="table-wrap">
                <table className="ws-table">
                  <thead>
                    <tr>
                      <th>Documento</th>
                      <th>Estado</th>
                      <th>Tamaño</th>
                      <th>Subido</th>
                    </tr>
                  </thead>
                  <tbody>
                    {documents.map((document) => {
                      const bucket = libStatus(document.status);
                      return (
                        <tr key={document.id}>
                          <td>
                            <div className="t-primary">
                              <Link href={`/app/workspace/documents/${document.id}`}>
                                {document.title ?? document.filename}
                              </Link>
                            </div>
                            <div className="t-secondary">{document.filename}</div>
                          </td>
                          <td>
                            <span className={`status status-${bucket}`}>
                              {libStatusLabel(document.status)}
                            </span>
                            {document.status_reason ? (
                              <div className="t-secondary">{document.status_reason}</div>
                            ) : null}
                          </td>
                          <td>{formatBytes(document.byte_size)}</td>
                          <td>
                            <span className="inline-icon">
                              <Clock aria-hidden="true" size={14} />
                              {formatDateTime(document.uploaded_at ?? document.created_at)}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>

        <div className="section-grid">
          <div className="glass-card">
            <div className="gc-head">
              <h2 className="gc-title">Nueva carga</h2>
              <p className="gc-desc">El archivo queda en Storage privado bajo el prefijo del tenant.</p>
            </div>
            <DocumentUploadForm />
          </div>

          <div className="glass-card">
            <div className="gc-head">
              <h2 className="gc-title">Pipeline</h2>
              <p className="gc-desc">Secuencia operativa conectada a la biblioteca.</p>
            </div>
            <ul className="steps">
              <li>
                <span className="inline-icon">
                  <HardDriveUpload aria-hidden="true" size={16} /> Upload directo a Storage con RLS por
                  tenant.
                </span>
              </li>
              <li>
                <span className="inline-icon">
                  <Database aria-hidden="true" size={16} /> El registro marca `queued` al entrar al
                  workflow.
                </span>
              </li>
              <li>
                <span className="inline-icon">
                  <Search aria-hidden="true" size={16} /> El SDA Tree Index llena `doc_tree` y nodos
                  recuperables.
                </span>
              </li>
              <li>
                <span className="inline-icon">
                  <UploadCloud aria-hidden="true" size={16} /> Disponible para lectura y árbol en el
                  workspace.
                </span>
              </li>
            </ul>
          </div>
        </div>
      </div>
    </AppShell>
  );
}
