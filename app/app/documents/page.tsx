import { Database, HardDriveUpload, Search, UploadCloud } from "lucide-react";
import { redirect } from "next/navigation";

import { AppShell } from "@/components/workspace/app-shell";
import { DocumentsLiveList } from "@/components/documents/documents-live-list";
import { DocumentUploadForm } from "@/components/documents/document-upload-form";
import { visibleDocumentStatuses, type DocumentRow } from "@/lib/documents";
import { getClaimValue, type AppClaims, type TenantRole } from "@/lib/auth/session";
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
        <DocumentsLiveList
          errorMessage={error?.message}
          initialDocuments={documents}
          tenantId={tenantId}
        />

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
