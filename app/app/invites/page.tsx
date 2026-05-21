import { Ban, Clock, UserPlus } from "lucide-react";
import { redirect } from "next/navigation";

import { AppShell } from "@/components/workspace/app-shell";
import { InviteCreateForm } from "@/components/invites/invite-create-form";
import { Button } from "@/components/ui/button";
import { revokeInviteAction } from "@/app/app/invites/actions";
import { compactId, formatDateTime, getClaimValue, type AppClaims, type TenantRole } from "@/lib/session";
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

function statusChip(status: InviteRow["status"]) {
  if (status === "pending") return { tone: "amber", label: "Pendiente" };
  if (status === "accepted") return { tone: "teal", label: "Aceptada" };
  return { tone: "danger", label: "Revocada" };
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
  const tenantSlug = getClaimValue<string>(claims, "tenant_slug", "tenant_slug");
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

  const pendingCount = invites.filter((i) => i.status === "pending").length;
  const acceptedCount = invites.filter((i) => i.status === "accepted").length;
  const revokedCount = invites.filter((i) => i.status === "revoked").length;

  return (
    <AppShell active="invites" tenantLabel={tenantSlug || "SDA"} tenantRole={tenantRole}>
      <div className="page-head">
        <div>
          <div className="kicker">Accesos</div>
          <h1>Invitaciones</h1>
          <p>Alta controlada de usuarios, roles y links activos del tenant.</p>
        </div>
      </div>

      {!canManageInvites ? (
        <div className="glass-card">
          <div className="gc-head">
            <h2 className="gc-title">Permisos insuficientes</h2>
            <p className="gc-desc">Esta sección está disponible para owners y admins del tenant.</p>
          </div>
        </div>
      ) : (
        <div className="grid-2">
          <div className="section-grid">
            <div className="stats-grid">
              <div className="stat">
                <div className="stat-label">Pendientes</div>
                <div className="stat-value">{pendingCount}</div>
                <div className="stat-sub">Links sin aceptar</div>
              </div>
              <div className="stat">
                <div className="stat-label">Aceptadas</div>
                <div className="stat-value">{acceptedCount}</div>
                <div className="stat-sub">Usuarios vinculados</div>
              </div>
              <div className="stat">
                <div className="stat-label">Revocadas</div>
                <div className="stat-value">{revokedCount}</div>
                <div className="stat-sub">Canceladas</div>
              </div>
            </div>

            <div className="glass-card">
              <div className="gc-head">
                <h2 className="gc-title">Historial de accesos</h2>
                <p className="gc-desc">Últimas 100 invitaciones visibles para tu sesión.</p>
              </div>

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
                <div className="empty">
                  <UserPlus aria-hidden="true" size={22} />
                  <div>
                    <strong>No hay invitaciones todavía.</strong>
                    <p>Creá la primera desde el panel lateral.</p>
                  </div>
                </div>
              ) : (
                <div className="table-wrap">
                  <table className="ws-table">
                    <thead>
                      <tr>
                        <th>Email</th>
                        <th>Rol</th>
                        <th>Estado</th>
                        <th>Expira</th>
                        <th>Acción</th>
                      </tr>
                    </thead>
                    <tbody>
                      {invites.map((invite) => {
                        const chip = statusChip(invite.status);
                        return (
                          <tr key={invite.id}>
                            <td>
                              <div className="t-primary">{invite.email}</div>
                              <div className="t-secondary">{compactId(invite.id)}</div>
                            </td>
                            <td>{invite.role}</td>
                            <td>
                              <span className={`chip ${chip.tone}`}>{chip.label}</span>
                            </td>
                            <td>
                              <span className="inline-icon">
                                <Clock aria-hidden="true" size={14} />
                                {invite.expires_at ? formatDateTime(invite.expires_at) : "Sin expiración"}
                              </span>
                            </td>
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
                <h2 className="gc-title">Crear invitación</h2>
                <p className="gc-desc">
                  El link solo funciona para el email indicado.
                  {tenantRole === "owner"
                    ? " Owners crean invitaciones sin vencimiento por default."
                    : " Admins crean invitaciones con vencimiento por default."}
                </p>
              </div>
              <InviteCreateForm defaultExpiresDays={tenantRole === "owner" ? "never" : "7"} />
            </div>
          </div>
        </div>
      )}
    </AppShell>
  );
}
