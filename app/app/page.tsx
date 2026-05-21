import {
  AlertCircle,
  CheckCircle2,
  FileText,
  MessageSquareText,
  Send,
  UserPlus,
  UserRound
} from "lucide-react";
import Link from "next/link";
import { redirect } from "next/navigation";

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
  compactId,
  formatDateTime,
  formatUnixSeconds,
  getClaimValue,
  type AppClaims,
  type TenantRole
} from "@/lib/session";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type TenantRow = {
  name: string | null;
  slug: string | null;
  status: string | null;
};

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
  if (Array.isArray(tenant)) {
    return tenant[0] ?? null;
  }

  return tenant;
}

async function countRows(
  supabase: Awaited<ReturnType<typeof createClient>>,
  table: "conversations" | "documents" | "tenant_invites"
) {
  const { count, error } = await supabase
    .from(table)
    .select("id", { count: "exact", head: true });

  return {
    count: count ?? 0,
    error: error?.message
  };
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
  const claimsVersion = getClaimValue<number>(claims, "claims_version", "claims_version");

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
    : [
        { count: 0, error: undefined },
        { count: 0, error: undefined },
        { count: 0, error: undefined }
      ];

  return (
    <main className="app-shell">
      <AppTopbar active="dashboard" tenantActive={Boolean(tenantId)} tenantRole={tenantRole} />

      <section className="page">
        <div className="page-header">
          <div className="page-title">
            <div className="kicker">Vista general</div>
            <h1>Consola operativa</h1>
            <p>
              Sesión, tenant y señales principales del workspace en una sola vista.
            </p>
          </div>
          <Badge tone={tenantRole === "owner" || tenantRole === "admin" ? "success" : "neutral"}>
            Rol: {tenantRole ?? "sin asignar"}
          </Badge>
        </div>

        {!tenantId ? (
          <Card>
            <CardHeader>
              <CardTitle>Cuenta autenticada sin tenant</CardTitle>
              <CardDescription>
                El login fue correcto, pero esta cuenta todavía no aceptó una invitación.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="alert alert-warning">
                <strong>Invite-only está funcionando.</strong>
                <span>
                  Reabrí el link de invitación y entrá con el mismo email para crear el perfil
                  en `public.users`.
                </span>
              </div>
              <div className="key-value-list">
                <KeyValue label="Email">{claims.email ?? "Sin dato"}</KeyValue>
                <KeyValue label="Auth user">
                  <span className="code">{compactId(claims.sub)}</span>
                </KeyValue>
                <KeyValue label="JWT expira">{formatUnixSeconds(claims.exp)}</KeyValue>
              </div>
            </CardContent>
          </Card>
        ) : (
          <div className="dashboard-grid">
            <div className="section-grid">
              <div className="stats-grid">
                <div className="stat">
                  <div className="stat-label">Documentos</div>
                  <div className="stat-value">{documents.count}</div>
                  <div className="muted">
                    {documents.error ? documents.error : "Visible por tenant"}
                  </div>
                </div>
                <div className="stat">
                  <div className="stat-label">Conversaciones</div>
                  <div className="stat-value">{conversations.count}</div>
                  <div className="muted">
                    {conversations.error ? conversations.error : "Propias o admin"}
                  </div>
                </div>
                <div className="stat">
                  <div className="stat-label">Invitaciones</div>
                  <div className="stat-value">{invites.count}</div>
                  <div className="muted">{invites.error ? invites.error : "Solo admin"}</div>
                </div>
              </div>

              <Card>
                <CardHeader>
                  <CardTitle>Tenant activo</CardTitle>
                  <CardDescription>Contexto de trabajo resuelto desde la sesión actual.</CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="key-value-list">
                    <KeyValue label="Nombre">{tenant?.name ?? tenantSlug ?? "Sin dato"}</KeyValue>
                    <KeyValue label="Slug">{tenant?.slug ?? tenantSlug ?? "Sin dato"}</KeyValue>
                    <KeyValue label="Estado">{tenant?.status ?? tenantStatus ?? "Sin dato"}</KeyValue>
                    <KeyValue label="Tenant ID">
                      <span className="code">{compactId(tenantId)}</span>
                    </KeyValue>
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>Flujos del workspace</CardTitle>
                  <CardDescription>
                    Accesos rápidos a las operaciones que ya están conectadas a este tenant.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <ul className="steps">
                    <li>
                      <FileText aria-hidden="true" size={17} />
                      Biblioteca documental con Storage privado y estado de indexación.
                    </li>
                    <li>
                      <MessageSquareText aria-hidden="true" size={17} />
                      Conversaciones preparadas para operar sobre documentos indexados.
                    </li>
                    <li>
                      <Send aria-hidden="true" size={17} />
                      Invitaciones controladas para owners y admins.
                    </li>
                  </ul>
                  <div className="card-actions">
                    <Link className="button button-secondary" href="/app/documents">
                      <FileText aria-hidden="true" size={16} />
                      Ver documentos
                    </Link>
                    <Link className="button button-secondary" href="/app/invites">
                      <UserPlus aria-hidden="true" size={16} />
                      Gestionar invitaciones
                    </Link>
                  </div>
                </CardContent>
              </Card>
            </div>

            <div className="section-grid">
              <Card>
                <CardHeader>
                  <CardTitle>Usuario</CardTitle>
                  <CardDescription>Perfil `public.users` vinculado a Supabase Auth.</CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="key-value-list">
                    <KeyValue label="Email">{profile?.email ?? claims.email ?? "Sin dato"}</KeyValue>
                    <KeyValue label="Nombre">
                      {profile?.display_name ?? "Sin nombre visible"}
                    </KeyValue>
                    <KeyValue label="Estado">{profile?.status ?? userStatus ?? "Sin dato"}</KeyValue>
                    <KeyValue label="Creado">{formatDateTime(profile?.created_at)}</KeyValue>
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>Claims de sesión</CardTitle>
                  <CardDescription>Valores que gobiernan permisos y aislamiento.</CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="key-value-list">
                    <KeyValue label="Auth user">
                      <span className="code">{compactId(claims.sub)}</span>
                    </KeyValue>
                    <KeyValue label="Rol">{tenantRole ?? "Sin dato"}</KeyValue>
                    <KeyValue label="Versión">{claimsVersion ?? "Sin dato"}</KeyValue>
                    <KeyValue label="JWT expira">{formatUnixSeconds(claims.exp)}</KeyValue>
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>Salud de acceso</CardTitle>
                  <CardDescription>Chequeos rápidos de autenticación y contexto.</CardDescription>
                </CardHeader>
                <CardContent>
                  <ul className="steps">
                    <li>
                      <CheckCircle2 aria-hidden="true" size={17} />
                      Sesión SSR validada con `getClaims`.
                    </li>
                    <li>
                      <CheckCircle2 aria-hidden="true" size={17} />
                      Claims de tenant presentes después del invite.
                    </li>
                    <li>
                      {profile ? (
                        <UserRound aria-hidden="true" size={17} />
                      ) : (
                        <AlertCircle aria-hidden="true" size={17} />
                      )}
                      Perfil tenant {profile ? "encontrado" : "no encontrado"}.
                    </li>
                  </ul>
                </CardContent>
              </Card>
            </div>
          </div>
        )}
      </section>
    </main>
  );
}
