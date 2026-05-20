import { LogOut, ShieldCheck } from "lucide-react";
import Link from "next/link";

import { Badge } from "@/components/ui/badge";

export function AppTopbar({
  active,
  tenantActive,
  tenantRole
}: {
  active: "dashboard" | "documents" | "invites";
  tenantActive: boolean;
  tenantRole?: string;
}) {
  return (
    <header className="topbar">
      <div className="topbar-inner">
        <div className="topbar-brand">
          <div className="brand-mark">
            <ShieldCheck aria-hidden="true" size={19} strokeWidth={2.2} />
          </div>
          <span>SDA Framework</span>
        </div>
        <div className="topbar-actions">
          <Badge tone={tenantActive ? "success" : "warning"}>
            {tenantActive ? `Rol: ${tenantRole ?? "sin asignar"}` : "Sin tenant"}
          </Badge>
          <nav aria-label="Principal" className="topbar-nav">
            <Link
              aria-current={active === "dashboard" ? "page" : undefined}
              className="button button-ghost"
              href="/app"
            >
              Consola
            </Link>
            <Link
              aria-current={active === "documents" ? "page" : undefined}
              className="button button-ghost"
              href="/app/documents"
            >
              Documentos
            </Link>
            <Link
              aria-current={active === "invites" ? "page" : undefined}
              className="button button-ghost"
              href="/app/invites"
            >
              Invitaciones
            </Link>
          </nav>
          <Link className="button button-ghost" href="/auth/sign-out">
            <LogOut aria-hidden="true" size={16} />
            Salir
          </Link>
        </div>
      </div>
    </header>
  );
}
