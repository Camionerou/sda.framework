"use client";

import { Bell } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";

export function AppTopbar() {
  return (
    <header className="flex items-center justify-end h-12 px-4 border-b border-neutral-100 bg-white shrink-0">
      <div className="flex items-center gap-1">
        <button className="relative flex items-center justify-center size-8 rounded-full text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700 transition-colors">
          <Bell className="size-4" />
          <span className="absolute top-1.5 right-1.5 size-1.5 rounded-full bg-neutral-800" />
          <span className="sr-only">Notificaciones</span>
        </button>
        <button className="flex items-center justify-center rounded-full p-1 hover:bg-neutral-100 transition-colors">
          <Avatar className="size-6">
            <AvatarFallback className="text-[9px] font-semibold bg-neutral-900 text-white">U</AvatarFallback>
          </Avatar>
        </button>
      </div>
    </header>
  );
}
