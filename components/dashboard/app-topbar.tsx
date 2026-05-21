import { FileText, Gauge, LogOut, ShieldCheck, UserPlus } from "lucide-react";
import Link from "next/link";

import { Badge } from "@/components/ui/badge";

const NAV_ITEMS = [
  { key: "dashboard", href: "/app", label: "Consola", icon: Gauge },
  { key: "documents", href: "/app/documents", label: "Documentos", icon: FileText },
  { key: "invites", href: "/app/invites", label: "Invitaciones", icon: UserPlus }
] as const;

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
    <aside className="sidebar">
      <div className="sidebar-brand">
        <div className="brand-mark">
          <ShieldCheck aria-hidden="true" size={19} strokeWidth={2.2} />
        </div>
        <div className="sidebar-brand-text">
          <strong>SDA Ops</strong>
          <span>Document intelligence</span>
        </div>
      </div>

      <div className="sidebar-status">
        <Badge tone={tenantActive ? "success" : "warning"}>
          {tenantActive ? `Rol · ${tenantRole ?? "sin asignar"}` : "Sin tenant"}
        </Badge>
        <strong>{tenantActive ? "Workspace activo" : "Acceso pendiente"}</strong>
        <p className="muted">
          {tenantActive
            ? "Operación privada con datos aislados por tenant."
            : "Aceptá una invitación para activar el workspace."}
        </p>
      </div>

      <div>
        <div className="sidebar-label">Principal</div>
        <nav aria-label="Principal" className="sidebar-nav">
          {NAV_ITEMS.map(({ key, href, label, icon: Icon }) => (
            <Link
              aria-current={active === key ? "page" : undefined}
              className="nav-item"
              href={href}
              key={key}
            >
              <Icon aria-hidden="true" size={16} />
              {label}
            </Link>
          ))}
        </nav>
      </div>

      <div className="sidebar-foot">
        <Badge tone={tenantActive ? "success" : "warning"}>
          {tenantActive ? "Tenant conectado" : "Tenant requerido"}
        </Badge>
        <form action="/auth/sign-out" className="nav-signout-form" method="POST">
          <button aria-label="Cerrar sesión" className="nav-item nav-signout" type="submit">
            <LogOut aria-hidden="true" size={16} />
            Salir
          </button>
        </form>
      </div>
    </aside>
  );
}
