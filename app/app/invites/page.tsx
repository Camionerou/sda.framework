import { Ban, Clock, UserPlus } from "lucide-react";
import { redirect } from "next/navigation";

import { AppTopbar } from "@/components/dashboard/app-topbar";
import { InviteCreateForm } from "@/components/invites/invite-create-form";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { revokeInviteAction } from "@/app/app/invites/actions";
import {
  compactId,
  formatDateTime,
  getClaimValue,
  type AppClaims,
  type TenantRole
} from "@/lib/session";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type InviteRow = {
  accepted_at: string | null;
  accepted_by: string | null;
  created_at: string;
  email: string;
  expires_at: string | null;
  id: string;
  invited_by: string | null;
  metadata: Record<string, unknown>;
  role: TenantRole;
  status: "pending" | "accepted" | "revoked";
  tenant_id: string;
  updated_at: string;
};

function statusTone(status: InviteRow["status"]) {
  if (status === "pending") {
    return "warning" as const;
  }

  if (status === "accepted") {
    return "success" as const;
  }

  return "danger" as const;
}

function statusLabel(status: InviteRow["status"]) {
  if (status === "pending") {
    return "Pendiente";
  }

  if (status === "accepted") {
    return "Aceptada";
  }

  return "Revocada";
}

export default async function InvitesPage({
  searchParams
}: {
  searchParams: Promise<{ error?: string; revoked?: string }>;
}) {
  const params = await searchParams;
  const supabase = await createClient();
  const { data: claimsData, error: claimsError } = await supabase.auth.getClaims();

  if (claimsError || !claimsData?.claims) {
    redirect("/login");
  }

  const claims = claimsData.claims as AppClaims;
  const tenantId = getClaimValue<string>(claims, "tenant_id", "tenant_id");
  const tenantRole = getClaimValue<TenantRole>(claims, "tenant_role", "tenant_role");
  const canManageInvites = tenantRole === "owner" || tenantRole === "admin";

  if (!tenantId) {
    redirect("/app");
  }

  const { data: inviteRows, error: invitesError } = canManageInvites
    ? await supabase
        .from("tenant_invites")
        .select(
          "id, tenant_id, email, role, status, invited_by, accepted_by, accepted_at, expires_at, metadata, created_at, updated_at"
        )
        .order("created_at", { ascending: false })
        .limit(100)
        .returns<InviteRow[]>()
    : { data: [], error: null };
  const invites = inviteRows ?? [];

  const pendingCount = invites.filter((invite) => invite.status === "pending").length;
  const acceptedCount = invites.filter((invite) => invite.status === "accepted").length;
  const revokedCount = invites.filter((invite) => invite.status === "revoked").length;

  return (
    <main className="app-shell">
      <AppTopbar active="invites" tenantActive={Boolean(tenantId)} tenantRole={tenantRole} />

      <section className="page">
        <div className="page-header">
          <div className="page-title">
            <h1>Invitaciones</h1>
            <p>Alta controlada de usuarios para el tenant activo.</p>
          </div>
          <Badge tone={canManageInvites ? "success" : "danger"}>
            {canManageInvites ? "Gestión habilitada" : "Sin permisos"}
          </Badge>
        </div>

        {!canManageInvites ? (
          <Card>
            <CardHeader>
              <CardTitle>Permisos insuficientes</CardTitle>
              <CardDescription>
                Esta sección está disponible para owners y admins del tenant.
              </CardDescription>
            </CardHeader>
          </Card>
        ) : (
          <div className="dashboard-grid">
            <div className="section-grid">
              <div className="stats-grid">
                <div className="stat">
                  <div className="stat-label">Pendientes</div>
                  <div className="stat-value">{pendingCount}</div>
                  <div className="muted">Links activos sin aceptar</div>
                </div>
                <div className="stat">
                  <div className="stat-label">Aceptadas</div>
                  <div className="stat-value">{acceptedCount}</div>
                  <div className="muted">Usuarios ya vinculados</div>
                </div>
                <div className="stat">
                  <div className="stat-label">Revocadas</div>
                  <div className="stat-value">{revokedCount}</div>
                  <div className="muted">Invitaciones canceladas</div>
                </div>
              </div>

              <Card>
                <CardHeader>
                  <CardTitle>Historial</CardTitle>
                  <CardDescription>Últimas 100 invitaciones visibles por RLS.</CardDescription>
                </CardHeader>
                <CardContent>
                  {params.revoked ? (
                    <div className="alert alert-success">
                      <strong>Invitación revocada.</strong>
                      <span>El link ya no puede ser aceptado.</span>
                    </div>
                  ) : null}
                  {params.error ? (
                    <div className="alert alert-danger" role="alert">
                      <strong>No se pudo completar la acción.</strong>
                      <span>{params.error}</span>
                    </div>
                  ) : null}
                  {invitesError ? (
                    <div className="alert alert-danger" role="alert">
                      <strong>No se pudieron leer las invitaciones.</strong>
                      <span>{invitesError.message}</span>
                    </div>
                  ) : null}

                  {invites.length === 0 ? (
                    <div className="empty-state">
                      <UserPlus aria-hidden="true" size={22} />
                      <div>
                        <strong>No hay invitaciones todavía.</strong>
                        <p>Creá la primera desde el panel lateral.</p>
                      </div>
                    </div>
                  ) : (
                    <div className="table-wrapper">
                      <table className="data-table">
                        <thead>
                          <tr>
                            <th>Email</th>
                            <th>Rol</th>
                            <th>Estado</th>
                            <th>Expira</th>
                            <th>Creada</th>
                            <th>Acción</th>
                          </tr>
                        </thead>
                        <tbody>
                          {invites.map((invite) => (
                            <tr key={invite.id}>
                              <td>
                                <div className="table-primary">{invite.email}</div>
                                <div className="table-secondary">{compactId(invite.id)}</div>
                              </td>
                              <td>{invite.role}</td>
                              <td>
                                <Badge tone={statusTone(invite.status)}>
                                  {statusLabel(invite.status)}
                                </Badge>
                              </td>
                              <td>
                                <span className="inline-icon">
                                  <Clock aria-hidden="true" size={14} />
                                  {invite.expires_at ? formatDateTime(invite.expires_at) : "Sin expiración"}
                                </span>
                              </td>
                              <td>{formatDateTime(invite.created_at)}</td>
                              <td>
                                {invite.status === "pending" ? (
                                  <form action={revokeInviteAction}>
                                    <input name="invite_id" type="hidden" value={invite.id} />
                                    <Button
                                      leftIcon={<Ban aria-hidden="true" size={15} />}
                                      type="submit"
                                      variant="secondary"
                                    >
                                      Revocar
                                    </Button>
                                  </form>
                                ) : (
                                  <span className="muted">Sin acción</span>
                                )}
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
                  <CardTitle>Nueva invitación</CardTitle>
                  <CardDescription>
                    El link solo funciona para el email indicado.
                    {tenantRole === "owner"
                      ? " Owners crean invitaciones sin vencimiento por default."
                      : " Admins crean invitaciones con vencimiento por default."}
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <InviteCreateForm
                    defaultExpiresDays={tenantRole === "owner" ? "never" : "7"}
                  />
                </CardContent>
              </Card>
            </div>
          </div>
        )}
      </section>
    </main>
  );
}
