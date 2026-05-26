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
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

const navItems = [
  { href: "/home", label: "Home", icon: Home },
  { href: "/documents", label: "Documentos", icon: FileText },
  { href: "/search", label: "Buscar", icon: Search },
  { href: "/graph", label: "Grafo", icon: GitBranch },
];

const bottomItems = [
  { href: "/settings", label: "Configuración", icon: Settings },
];

export function AppSidebar() {
  const pathname = usePathname();

  return (
    <aside className="flex flex-col h-full w-14 shrink-0 bg-card border-r border-border">
      {/* Logo */}
      <div className="flex items-center justify-center h-14 shrink-0 border-b border-border">
        <div className="flex size-7 items-center justify-center rounded-lg bg-primary">
          <span className="text-[9px] font-bold text-primary-foreground tracking-widest">SDA</span>
        </div>
      </div>

      {/* Nav */}
      <nav className="flex flex-col items-center gap-1 flex-1 py-3 px-2">
        {navItems.map(({ href, label, icon: Icon }) => {
          const active = pathname === href || pathname.startsWith(href + "/");
          return (
            <Tooltip key={href}>
              <TooltipTrigger asChild>
                <Link
                  href={href}
                  className={cn(
                    "flex items-center justify-center size-9 rounded-lg transition-colors",
                    active
                      ? "bg-primary/10 text-primary"
                      : "text-muted-foreground hover:bg-muted hover:text-foreground"
                  )}
                >
                  <Icon className="size-[18px]" />
                  <span className="sr-only">{label}</span>
                </Link>
              </TooltipTrigger>
              <TooltipContent side="right" className="text-xs">
                {label}
              </TooltipContent>
            </Tooltip>
          );
        })}
      </nav>

      {/* Upload shortcut */}
      <div className="flex flex-col items-center gap-1 px-2 pb-2">
        <Tooltip>
          <TooltipTrigger asChild>
            <button className="flex items-center justify-center size-9 rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground transition-colors">
              <Upload className="size-[18px]" />
              <span className="sr-only">Subir documento</span>
            </button>
          </TooltipTrigger>
          <TooltipContent side="right" className="text-xs">
            Subir documento
          </TooltipContent>
        </Tooltip>

        {bottomItems.map(({ href, label, icon: Icon }) => {
          const active = pathname === href;
          return (
            <Tooltip key={href}>
              <TooltipTrigger asChild>
                <Link
                  href={href}
                  className={cn(
                    "flex items-center justify-center size-9 rounded-lg transition-colors",
                    active
                      ? "bg-primary/10 text-primary"
                      : "text-muted-foreground hover:bg-muted hover:text-foreground"
                  )}
                >
                  <Icon className="size-[18px]" />
                  <span className="sr-only">{label}</span>
                </Link>
              </TooltipTrigger>
              <TooltipContent side="right" className="text-xs">
                {label}
              </TooltipContent>
            </Tooltip>
          );
        })}
      </div>
    </aside>
  );
}
