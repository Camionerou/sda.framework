"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Home,
  FileText,
  Search,
  GitBranch,
  Settings,
  Upload,
  ChevronRight,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { createClient } from "@/lib/supabase/client";
import { useRouter } from "next/navigation";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";

const navItems = [
  { href: "/home", label: "Home", icon: Home },
  { href: "/documents", label: "Documentos", icon: FileText },
  { href: "/search", label: "Buscar", icon: Search },
  { href: "/graph", label: "Grafo", icon: GitBranch },
];

const recentDocs = [
  { id: "1", name: "Arquitectura del sistema v2.pdf" },
  { id: "2", name: "Manual de usuario — Módulo ingestión.md" },
  { id: "3", name: "Especificaciones API REST 2026.pdf" },
  { id: "4", name: "Roadmap Q2-Q3 2026.md" },
];

export function AppSidebar() {
  const pathname = usePathname();
  const router = useRouter();

  async function handleLogout() {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push("/auth/login");
    router.refresh();
  }

  return (
    <aside className="flex flex-col h-full w-56 shrink-0 bg-[#FAFAFA] border-r border-black/[0.07]">
      {/* Logo */}
      <div className="flex items-center gap-2.5 h-14 px-4 shrink-0">
        <div className="flex size-6 items-center justify-center rounded-md bg-[#1a1a1a]">
          <span className="text-[8px] font-bold text-white tracking-widest">SDA</span>
        </div>
        <span className="text-[13px] font-semibold text-[#1a1a1a] tracking-tight">SDA Framework</span>
      </div>

      {/* Upload CTA */}
      <div className="px-3 pb-3">
        <button className="flex items-center gap-2 w-full px-3 py-2 rounded-lg bg-[#1a1a1a] hover:bg-black text-white text-[13px] font-medium transition-colors">
          <Upload className="size-3.5" />
          Subir documento
        </button>
      </div>

      {/* Nav */}
      <nav className="flex flex-col gap-0.5 px-2">
        {navItems.map(({ href, label, icon: Icon }) => {
          const active = pathname === href || pathname.startsWith(href + "/");
          return (
            <Link
              key={href}
              href={href}
              className={cn(
                "flex items-center gap-2.5 px-3 py-2 rounded-lg text-[13px] transition-colors",
                active
                  ? "bg-white shadow-sm border border-black/[0.06] text-[#1a1a1a] font-medium"
                  : "text-[#555] hover:bg-white/70 hover:text-[#1a1a1a]"
              )}
            >
              <Icon className="size-4 shrink-0" />
              {label}
            </Link>
          );
        })}
      </nav>

      {/* Recientes */}
      <div className="flex flex-col gap-0.5 px-2 mt-4">
        <p className="px-3 py-1 text-[11px] font-semibold uppercase tracking-widest text-[#999]">
          Recientes
        </p>
        {recentDocs.map((doc) => (
          <button
            key={doc.id}
            className="group flex items-center gap-2 px-3 py-1.5 rounded-lg text-left hover:bg-white/70 transition-colors"
          >
            <FileText className="size-3.5 shrink-0 text-[#999]" />
            <span className="text-[12.5px] text-[#555] truncate flex-1">{doc.name}</span>
            <ChevronRight className="size-3 text-[#bbb] opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
          </button>
        ))}
        <button className="px-3 py-1.5 text-left text-[12px] text-[#999] hover:text-[#555] transition-colors">
          Mostrar mas
        </button>
      </div>

      {/* Bottom */}
      <div className="flex flex-col gap-0.5 px-2 mt-auto pb-3">
        <Link
          href="/settings"
          className={cn(
            "flex items-center gap-2.5 px-3 py-2 rounded-lg text-[13px] transition-colors",
            pathname === "/settings"
              ? "bg-white shadow-sm border border-black/[0.06] text-[#1a1a1a] font-medium"
              : "text-[#555] hover:bg-white/70 hover:text-[#1a1a1a]"
          )}
        >
          <Settings className="size-4 shrink-0" />
          Configuración
        </Link>

        {/* User */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="flex items-center gap-2.5 px-3 py-2 rounded-lg text-[13px] text-[#555] hover:bg-white/70 hover:text-[#1a1a1a] transition-colors w-full text-left">
              <Avatar className="size-5">
                <AvatarFallback className="text-[9px] font-semibold bg-[#1a1a1a] text-white">U</AvatarFallback>
              </Avatar>
              <span className="flex-1 truncate">Mi cuenta</span>
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" side="top" className="w-44 rounded-xl">
            <DropdownMenuItem className="rounded-lg text-[13px]">Perfil</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="rounded-lg text-[13px] text-red-500 focus:text-red-500"
              onClick={handleLogout}
            >
              Cerrar sesion
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </aside>
  );
}
