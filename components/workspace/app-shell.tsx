import { FileText, LayoutGrid, LogOut, UserPlus } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

type AppShellProps = {
  active: "home" | "documents" | "invites";
  tenantLabel: string;
  tenantRole?: string;
  children: ReactNode;
};

const NAV = [
  { key: "home", href: "/app", label: "Resumen", icon: LayoutGrid },
  { key: "documents", href: "/app/documents", label: "Documentos", icon: FileText },
  { key: "invites", href: "/app/invites", label: "Invitaciones", icon: UserPlus }
] as const;

/** Glass aurora chrome for the non-workspace app pages (home, library, invites). */
export function AppShell({ active, tenantLabel, tenantRole, children }: AppShellProps) {
  return (
    <div className="ws">
      <div className="ws-app-shell">
        <nav className="glass ws-topnav" aria-label="Navegación principal">
          <div className="brand-row">
            <Link className="brand" href="/app" aria-label="SDA — inicio">
              S
            </Link>
            <div className="name">
              SDA
              <small>Memoria semántica</small>
            </div>
          </div>

          <div className="ws-nav">
            {NAV.map(({ key, href, label, icon: Icon }) => (
              <Link
                key={key}
                href={href}
                className={active === key ? "is-active" : ""}
                aria-current={active === key ? "page" : undefined}
              >
                <Icon size={15} aria-hidden="true" />
                {label}
              </Link>
            ))}
          </div>

          <div className="nav-right">
            <Link href="/app/workspace" className="button button-primary" style={{ height: 34 }}>
              <LayoutGrid size={15} aria-hidden="true" />
              Abrir workspace
            </Link>
            {tenantRole ? (
              <span className="tenant-pill">
                <span className="swatch" aria-hidden="true" />
                {tenantLabel} · {tenantRole}
              </span>
            ) : null}
            <form action="/auth/sign-out" className="signout-form" method="POST">
              <button className="ico-btn" type="submit" title="Cerrar sesión" aria-label="Cerrar sesión">
                <LogOut size={16} aria-hidden="true" />
              </button>
            </form>
          </div>
        </nav>

        <div className="ws-page">
          <div className="ws-page-inner">{children}</div>
        </div>
      </div>
    </div>
  );
}
