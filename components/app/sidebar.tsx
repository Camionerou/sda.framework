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
    <aside className="flex flex-col h-full w-14 shrink-0 bg-white border-r border-black/[0.07]">
      {/* Logo */}
      <div className="flex items-center justify-center h-14 shrink-0 border-b border-black/[0.07]">
        <div className="flex size-7 items-center justify-center rounded-lg bg-[#27251E]">
          <span className="text-[9px] font-bold text-white tracking-widest">SDA</span>
        </div>
      </div>

      {/* Nav items */}
      <nav className="flex flex-col items-center gap-0.5 flex-1 py-3 px-2">
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
                      ? "bg-[#FAF8F5] text-[#27251E]"
                      : "text-[#72706B] hover:bg-[#FAF8F5] hover:text-[#27251E]"
                  )}
                >
                  <Icon className="size-[17px]" />
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

      {/* Bottom items */}
      <div className="flex flex-col items-center gap-0.5 px-2 pb-3">
        <Tooltip>
          <TooltipTrigger asChild>
            <button className="flex items-center justify-center size-9 rounded-lg text-[#72706B] hover:bg-[#FAF8F5] hover:text-[#27251E] transition-colors">
              <Upload className="size-[17px]" />
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
                      ? "bg-[#FAF8F5] text-[#27251E]"
                      : "text-[#72706B] hover:bg-[#FAF8F5] hover:text-[#27251E]"
                  )}
                >
                  <Icon className="size-[17px]" />
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
