import {
  Clock,
  Database,
  FileText,
  HardDriveUpload,
  Search,
  UploadCloud
} from "lucide-react";
import Link from "next/link";
import { redirect } from "next/navigation";

import { AppTopbar } from "@/components/dashboard/app-topbar";
import { DocumentUploadForm } from "@/components/documents/document-upload-form";
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
} from "@/lib/auth/session";
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

  if (!tenantId) {
    redirect("/app");
  }

  const { data: documentRows, error } = await supabase
    .from("documents")
    .select(
      "id, title, filename, mime_type, byte_size, storage_bucket, storage_path, status, status_reason, uploaded_at, indexed_at, created_at, indexing_pipeline_version, extraction_pipeline_version, tree_indexer_version, embedding_pipeline_version"
    )
    .order("created_at", { ascending: false })
    .limit(100)
    .returns<DocumentRow[]>();

  const documents = documentRows ?? [];
  const uploadedCount = documents.filter((doc) => doc.status === "uploaded").length;
  const indexedCount = documents.filter((doc) => doc.status === "indexed").length;
  const pendingCount = documents.filter((doc) =>
    ["uploading", "queued", "parsing", "structuring", "embedding"].includes(doc.status)
  ).length;

  return (
    <main className="app-shell">
      <AppTopbar active="documents" tenantActive={Boolean(tenantId)} tenantRole={tenantRole} />

      <section className="page">
        <div className="page-header">
          <div className="page-title">
            <div className="kicker">Biblioteca</div>
            <h1>Documentos</h1>
            <p>Carga privada, seguimiento de ingesta y disponibilidad para indexación.</p>
          </div>
          <Badge tone="success">Storage privado</Badge>
        </div>

        <div className="dashboard-grid">
          <div className="section-grid">
            <div className="stats-grid">
              <div className="stat">
                <div className="stat-label">Subidos</div>
                <div className="stat-value">{uploadedCount}</div>
                <div className="muted">Listos para pipeline</div>
              </div>
              <div className="stat">
                <div className="stat-label">Pendientes</div>
                <div className="stat-value">{pendingCount}</div>
                <div className="muted">Upload o indexación</div>
              </div>
              <div className="stat">
                <div className="stat-label">Indexados</div>
                <div className="stat-value">{indexedCount}</div>
                <div className="muted">Disponibles para chat</div>
              </div>
            </div>

            <Card>
              <CardHeader>
                <CardTitle>Archivos del tenant</CardTitle>
                <CardDescription>Últimos 100 documentos visibles para tu sesión.</CardDescription>
              </CardHeader>
              <CardContent>
                {error ? (
                  <div className="alert alert-danger" role="alert">
                    <strong>No se pudieron leer los documentos.</strong>
                    <span>{error.message}</span>
                  </div>
                ) : null}

                {documents.length === 0 ? (
                  <div className="empty-state">
                    <FileText aria-hidden="true" size={22} />
                    <div>
                      <strong>No hay documentos todavía.</strong>
                      <p>Subí el primer archivo desde el panel lateral.</p>
                    </div>
                  </div>
                ) : (
                  <div className="table-wrapper">
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th>Documento</th>
                          <th>Estado</th>
                          <th>Tamaño</th>
                          <th>Subido</th>
                          <th>Storage</th>
                        </tr>
                      </thead>
                      <tbody>
                        {documents.map((document) => (
                          <tr key={document.id}>
                            <td>
                              <div className="table-primary">
                                <Link href={`/app/documents/${document.id}`}>
                                  {document.title ?? document.filename}
                                </Link>
                              </div>
                              <div className="table-secondary">{document.filename}</div>
                            </td>
                            <td>
                              <Badge tone={documentStatusTone(document.status)}>
                                {documentStatusLabel(document.status)}
                              </Badge>
                              {document.status_reason ? (
                                <div className="table-secondary">{document.status_reason}</div>
                              ) : null}
                            </td>
                            <td>{formatBytes(document.byte_size)}</td>
                            <td>
                              <span className="inline-icon">
                                <Clock aria-hidden="true" size={14} />
                                {formatDateTime(document.uploaded_at ?? document.created_at)}
                              </span>
                            </td>
                            <td>
                              <div className="table-primary">{document.storage_bucket}</div>
                              <div className="table-secondary">{compactId(document.id)}</div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>

          <div className="section-grid">
            <Card>
              <CardHeader>
                <CardTitle>Nueva carga</CardTitle>
                <CardDescription>
                  El archivo queda guardado en Storage privado bajo el prefijo del tenant.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <DocumentUploadForm />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Pipeline</CardTitle>
                <CardDescription>Secuencia operativa conectada a la biblioteca.</CardDescription>
              </CardHeader>
              <CardContent>
                <ul className="steps">
                  <li>
                    <HardDriveUpload aria-hidden="true" size={17} />
                    Upload directo a Storage con RLS por tenant.
                  </li>
                  <li>
                    <Database aria-hidden="true" size={17} />
                    Registro `documents` marca `queued` cuando entra al workflow.
                  </li>
                  <li>
                    <Search aria-hidden="true" size={17} />
                    SDA Tree Index llena `doc_tree` y nodos recuperables.
                  </li>
                  <li>
                    <UploadCloud aria-hidden="true" size={17} />
                    El backend cloud podrá reemplazar Storage por R2 sin cambiar la UI.
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
