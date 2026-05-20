import { ShieldCheck } from "lucide-react";
import { redirect } from "next/navigation";

import { GoogleLoginButton } from "@/components/auth/google-login-button";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from "@/components/ui/card";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type LoginSearchParams = {
  error?: string;
  invite_token?: string;
  message?: string;
};

export default async function LoginPage({
  searchParams
}: {
  searchParams: Promise<LoginSearchParams>;
}) {
  const params = await searchParams;
  let configError: string | null = null;
  let hasSession = false;

  try {
    const supabase = await createClient();
    const { data: claimsData } = await supabase.auth.getClaims();
    hasSession = Boolean(claimsData?.claims);
  } catch (error) {
    configError = error instanceof Error ? error.message : "No se pudo leer la sesión.";
  }

  if (hasSession) {
    redirect("/app");
  }

  return (
    <main className="auth-page">
      <div className="auth-panel">
        <div className="auth-brand">
          <div className="brand-mark">
            <ShieldCheck aria-hidden="true" size={20} strokeWidth={2.2} />
          </div>
          <div>
            <h1>SDA Framework</h1>
            <p>Acceso privado por invitación para operar el tenant y la sesión.</p>
          </div>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Ingresar</CardTitle>
            <CardDescription>
              Usá la cuenta de Google asociada a la invitación del tenant.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {params.invite_token ? (
              <div className="alert alert-success">
                <strong>Invitación detectada.</strong>
                <span>Después del login se activa tu usuario y se refrescan los claims.</span>
              </div>
            ) : (
              <div className="alert">
                <strong>Invite-only activo.</strong>
                <span>Sin link de invitación, el login no asigna tenant automáticamente.</span>
              </div>
            )}

            {params.error ? (
              <div className="alert alert-danger" role="alert">
                <strong>{params.error}</strong>
                <span>{params.message ?? "Reintentá con el link de invitación correcto."}</span>
              </div>
            ) : null}

            {configError ? (
              <div className="alert alert-danger" role="alert">
                <strong>Falta configuración local.</strong>
                <span>{configError}</span>
              </div>
            ) : (
              <GoogleLoginButton inviteToken={params.invite_token} />
            )}

            <Badge tone={params.invite_token ? "success" : "warning"}>
              {params.invite_token ? "Invite token listo" : "Requiere invitación"}
            </Badge>
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
