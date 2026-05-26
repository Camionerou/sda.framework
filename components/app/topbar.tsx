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
    <header className="flex items-center justify-between h-12 px-4 border-b border-border bg-card shrink-0">
      {/* Search */}
      <button className="flex items-center gap-2 h-8 px-3 rounded-md bg-muted hover:bg-muted/80 transition-colors text-muted-foreground text-sm w-56">
        <Search className="size-3.5 shrink-0" />
        <span className="flex-1 text-left">Buscar...</span>
        <kbd className="hidden sm:inline-flex items-center gap-0.5 rounded border border-border bg-background px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
          ⌘K
        </kbd>
      </button>

      <div className="flex items-center gap-1">
        {/* Notifications */}
        <button className="relative flex items-center justify-center size-8 rounded-md text-muted-foreground hover:bg-muted hover:text-foreground transition-colors">
          <Bell className="size-4" />
          <span className="absolute top-1.5 right-1.5 size-1.5 rounded-full bg-primary" />
          <span className="sr-only">Notificaciones</span>
        </button>

        {/* User */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="flex items-center justify-center rounded-md p-1 hover:bg-muted transition-colors outline-none">
              <Avatar className="size-7">
                <AvatarImage src="" />
                <AvatarFallback className="text-[10px] font-semibold bg-primary text-primary-foreground">
                  U
                </AvatarFallback>
              </Avatar>
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            <DropdownMenuItem>Perfil</DropdownMenuItem>
            <DropdownMenuItem>Configuración</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="text-destructive focus:text-destructive"
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
