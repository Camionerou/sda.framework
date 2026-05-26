import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { LogoutButton } from "@/components/auth/logout-button";

export default async function DashboardPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/auth/login");
  }

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 p-8">
      <div className="text-center">
        <div className="mx-auto mb-4 flex size-16 items-center justify-center rounded-xl bg-primary">
          <span className="text-xl font-bold text-primary-foreground">SDA</span>
        </div>
        <h1 className="text-3xl font-bold">Bienvenido a SDA Framework</h1>
        <p className="mt-2 text-muted-foreground">
          Has iniciado sesión como{" "}
          <span className="font-medium text-foreground">{user.email}</span>
        </p>
      </div>

      <LogoutButton />
    </main>
  );
}
