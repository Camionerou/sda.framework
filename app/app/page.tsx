import { ArrowRight, CheckCircle2, FileText, Send, Sparkles, UserPlus } from "lucide-react";
import Link from "next/link";
import { redirect } from "next/navigation";

import { AppShell } from "@/components/workspace/app-shell";
import {
  compactId,
  formatDateTime,
  formatUnixSeconds,
  getClaimValue,
  type AppClaims,
  type TenantRole
} from "@/lib/auth/session";
import { visibleDocumentStatuses } from "@/lib/documents";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type TenantRow = { name: string | null; slug: string | null; status: string | null };

type ProfileRow = {
  avatar_url: string | null;
  created_at: string | null;
  display_name: string | null;
  email: string | null;
  id: string;
  role: TenantRole;
  status: string;
  tenant_id: string;
  tenants: TenantRow | TenantRow[] | null;
};

function normalizeTenant(tenant: ProfileRow["tenants"]) {
  return Array.isArray(tenant) ? tenant[0] ?? null : tenant;
}

async function countRows(
  supabase: Awaited<ReturnType<typeof createClient>>,
  table: "conversations" | "documents" | "tenant_invites"
) {
  let query = supabase.from(table).select("id", { count: "exact", head: true });

  if (table === "documents") {
    query = query.in("status", [...visibleDocumentStatuses]).not("uploaded_at", "is", null);
  }

  const { count } = await query;
  return count ?? 0;
}

export default async function AppPage() {
  const supabase = await createClient();
  const { data: claimsData, error: claimsError } = await supabase.auth.getClaims();

  if (claimsError || !claimsData?.claims) {
    redirect("/login");
  }

  const claims = claimsData.claims as AppClaims;
  const tenantId = getClaimValue<string>(claims, "tenant_id", "tenant_id");
  const tenantRole = getClaimValue<TenantRole>(claims, "tenant_role", "tenant_role");
  const tenantSlug = getClaimValue<string>(claims, "tenant_slug", "tenant_slug");
  const tenantStatus = getClaimValue<string>(claims, "tenant_status", "tenant_status");
  const userStatus = getClaimValue<string>(claims, "user_status", "user_status");

  const { data: profile } = await supabase
    .from("users")
    .select(
      "id, tenant_id, email, display_name, avatar_url, role, status, created_at, tenants(name, slug, status)"
    )
    .eq("id", claims.sub)
    .maybeSingle<ProfileRow>();

  const tenant = normalizeTenant(profile?.tenants ?? null);
  const [documents, conversations, invites] = tenantId
    ? await Promise.all([
        countRows(supabase, "documents"),
        countRows(supabase, "conversations"),
        countRows(supabase, "tenant_invites")
      ])
    : [0, 0, 0];

  return (
    <AppShell active="home" tenantLabel={tenantSlug || "SDA"} tenantRole={tenantRole}>
      <div className="page-head">
        <div>
          <div className="kicker">Vista general</div>
          <h1>Consola operativa</h1>
          <p>Sesión, tenant y señales principales del workspace en una sola vista.</p>
        </div>
      </div>

      {!tenantId ? (
        <div className="glass-card">
          <div className="gc-head">
            <h2 className="gc-title">Cuenta autenticada sin tenant</h2>
            <p className="gc-desc">El login fue correcto, pero esta cuenta todavía no aceptó una invitación.</p>
          </div>
          <div className="alert alert-warning">
            <strong>Invite-only está funcionando.</strong>
            <span>Reabrí el link de invitación y entrá con el mismo email para crear tu perfil.</span>
          </div>
          <div className="kv">
            <div className="kv-row">
              <span className="k">Email</span>
              <span className="v">{claims.email ?? "Sin dato"}</span>
            </div>
            <div className="kv-row">
              <span className="k">Auth user</span>
              <span className="v mono">{compactId(claims.sub)}</span>
            </div>
            <div className="kv-row">
              <span className="k">JWT expira</span>
              <span className="v">{formatUnixSeconds(claims.exp)}</span>
            </div>
          </div>
        </div>
      ) : (
        <div className="grid-2">
          <div className="section-grid">
            <div className="stats-grid">
              <div className="stat">
                <div className="stat-label">Documentos</div>
                <div className="stat-value">{documents}</div>
                <div className="stat-sub">Visible por tenant</div>
              </div>
              <div className="stat">
                <div className="stat-label">Conversaciones</div>
                <div className="stat-value">{conversations}</div>
                <div className="stat-sub">Propias o admin</div>
              </div>
              <div className="stat">
                <div className="stat-label">Invitaciones</div>
                <div className="stat-value">{invites}</div>
                <div className="stat-sub">Solo admin</div>
              </div>
            </div>

            <div className="glass-card cta-card">
              <div className="cta-copy">
                <h2 className="gc-title">
                  <span className="inline-icon">
                    <Sparkles size={18} aria-hidden="true" style={{ color: "var(--teal-2)" }} /> Workspace
                    documental
                  </span>
                </h2>
                <p className="gc-desc">
                  Abrí un documento para leer el PDF, navegar su árbol semántico y ver la indexación en
                  vivo, lado a lado.
                </p>
              </div>
              <Link href="/app/workspace" className="button button-primary" style={{ flex: "0 0 auto" }}>
                Abrir
                <ArrowRight size={15} aria-hidden="true" />
              </Link>
            </div>

            <div className="glass-card">
              <div className="gc-head">
                <h2 className="gc-title">Tenant activo</h2>
                <p className="gc-desc">Contexto de trabajo resuelto desde la sesión actual.</p>
              </div>
              <div className="kv">
                <div className="kv-row">
                  <span className="k">Nombre</span>
                  <span className="v">{tenant?.name ?? tenantSlug ?? "Sin dato"}</span>
                </div>
                <div className="kv-row">
                  <span className="k">Slug</span>
                  <span className="v">{tenant?.slug ?? tenantSlug ?? "Sin dato"}</span>
                </div>
                <div className="kv-row">
                  <span className="k">Estado</span>
                  <span className="v">{tenant?.status ?? tenantStatus ?? "Sin dato"}</span>
                </div>
                <div className="kv-row">
                  <span className="k">Tenant ID</span>
                  <span className="v mono">{compactId(tenantId)}</span>
                </div>
              </div>
            </div>
          </div>

          <div className="section-grid">
            <div className="glass-card">
              <div className="gc-head">
                <h2 className="gc-title">Usuario</h2>
                <p className="gc-desc">Perfil vinculado a Supabase Auth.</p>
              </div>
              <div className="kv">
                <div className="kv-row">
                  <span className="k">Email</span>
                  <span className="v">{profile?.email ?? claims.email ?? "Sin dato"}</span>
                </div>
                <div className="kv-row">
                  <span className="k">Nombre</span>
                  <span className="v">{profile?.display_name ?? "Sin nombre visible"}</span>
                </div>
                <div className="kv-row">
                  <span className="k">Estado</span>
                  <span className="v">{profile?.status ?? userStatus ?? "Sin dato"}</span>
                </div>
                <div className="kv-row">
                  <span className="k">Creado</span>
                  <span className="v">{formatDateTime(profile?.created_at)}</span>
                </div>
              </div>
            </div>

            <div className="glass-card">
              <div className="gc-head">
                <h2 className="gc-title">Accesos rápidos</h2>
                <p className="gc-desc">Operaciones conectadas a este tenant.</p>
              </div>
              <ul className="steps">
                <li>
                  <Link href="/app/documents" className="inline-icon">
                    <FileText size={16} aria-hidden="true" /> Biblioteca documental
                  </Link>
                </li>
                <li>
                  <Link href="/app/invites" className="inline-icon">
                    <UserPlus size={16} aria-hidden="true" /> Gestionar invitaciones
                  </Link>
                </li>
              </ul>
              <div className="divider" />
              <ul className="steps">
                <li>
                  <span className="inline-icon">
                    <CheckCircle2 size={16} aria-hidden="true" /> Sesión SSR validada con `getClaims`.
                  </span>
                </li>
                <li>
                  <span className="inline-icon">
                    <Send size={16} aria-hidden="true" /> Claims de tenant presentes tras el invite.
                  </span>
                </li>
              </ul>
            </div>
          </div>
        </div>
      )}
    </AppShell>
  );
}
