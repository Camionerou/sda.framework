"use client";

import { Search, Bell } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { createClient } from "@/lib/supabase/client";
import { useRouter } from "next/navigation";

export function AppTopbar() {
  const router = useRouter();

  async function handleLogout() {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push("/auth/login");
    router.refresh();
  }

  return (
    <header className="flex items-center justify-between h-12 px-4 border-b border-black/[0.07] bg-white shrink-0">
      {/* Search pill */}
      <button className="flex items-center gap-2 h-8 px-3 rounded-full bg-[#FAF8F5] hover:bg-[#F0EDE8] transition-colors text-[#92918B] hover:text-[#27251E] text-[13px] w-52 border border-black/[0.06]">
        <Search className="size-3.5 shrink-0" />
        <span className="flex-1 text-left">Buscar...</span>
        <kbd className="hidden sm:inline-flex items-center gap-0.5 rounded-md bg-white border border-black/[0.08] px-1.5 py-0.5 font-mono text-[10px] text-[#92918B]">
          ⌘K
        </kbd>
      </button>

      <div className="flex items-center gap-1">
        {/* Notifications */}
        <button className="relative flex items-center justify-center size-8 rounded-full text-[#72706B] hover:bg-[#FAF8F5] hover:text-[#27251E] transition-colors">
          <Bell className="size-4" />
          <span className="absolute top-1.5 right-1.5 size-1.5 rounded-full bg-[#27251E]" />
          <span className="sr-only">Notificaciones</span>
        </button>

        {/* User */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="flex items-center justify-center rounded-full p-1 hover:bg-[#FAF8F5] transition-colors outline-none">
              <Avatar className="size-7">
                <AvatarImage src="" />
                <AvatarFallback className="text-[10px] font-semibold bg-[#27251E] text-white">
                  U
                </AvatarFallback>
              </Avatar>
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44 rounded-xl">
            <DropdownMenuItem className="rounded-lg text-[13px]">Perfil</DropdownMenuItem>
            <DropdownMenuItem className="rounded-lg text-[13px]">Configuración</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="rounded-lg text-[13px] text-red-500 focus:text-red-500"
              onClick={handleLogout}
            >
              Cerrar sesión
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
