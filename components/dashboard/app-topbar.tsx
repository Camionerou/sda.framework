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
          <strong>SDA</strong>
          <span>Framework</span>
        </div>
      </div>

      <div className="sidebar-label">Navegación</div>
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

      <div className="sidebar-foot">
        <Badge tone={tenantActive ? "success" : "warning"}>
          {tenantActive ? `Rol · ${tenantRole ?? "sin asignar"}` : "Sin tenant"}
        </Badge>
        <a aria-label="Cerrar sesión" className="nav-item nav-signout" href="/auth/sign-out">
          <LogOut aria-hidden="true" size={16} />
          Salir
        </a>
      </div>
    </aside>
  );
}
