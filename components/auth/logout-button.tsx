"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2, LogOut } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";

export function LogoutButton() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  async function handleLogout() {
    setLoading(true);
    const supabase = createClient();
    await supabase.auth.signOut();
    toast.success("Sesión cerrada");
    router.push("/auth/login");
    router.refresh();
  }

  return (
    <Button variant="outline" onClick={handleLogout} disabled={loading}>
      {loading ? (
        <Loader2 data-icon="inline-start" className="animate-spin" />
      ) : (
        <LogOut data-icon="inline-start" />
      )}
      {loading ? "Cerrando sesión..." : "Cerrar sesión"}
    </Button>
  );
}
